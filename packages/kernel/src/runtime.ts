/**
 * 内网转发 + 网关 + 锁账本 + 强制截断 + agent 三段式。
 *
 * 对应 FOUNDATION_V5.md §8 / §9 / §10：
 *   M1/M2/M3  编排权威属于边；隧道 ∩ traceid 前缀；callback 落已声明端点
 *   L1/L2     锁只在网关穿越时产生；owner 唯一是容器
 *   L3        截断靠 generation fence，`cancel` 只是 best effort
 *   L5        可终止 ⟺ 无非终态消息 ∧ 无活跃 execution ∧ 锁表空
 *   §10       claim（同步临界区）→ execute（await，临界区外）→ apply（同步临界区）
 *             冲突域 = 实例 + 被消费的消息集合
 *
 * **零部分提交**：排期（`routing.stageOutputs`）与提交分离，失败时一条下游都不创建。
 * **订阅不物化**：模板声明 + 实例终身 pin ⇒ 当前订阅是派生的，没有退订簿记。
 */

import {
  EMPTY_USAGE,
  type Endpoint,
  type ExecutionBackend,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type Json,
  type MessageContract,
  type NodeDefinition,
  type ObjectVersion,
  type ArtifactSubmission,
  type JsonObject,
  type Ref,
  isKernelKind,
  NON_RETRYABLE,
  type Port,
  type Termination,
  type TraceId,
  type Tunnel,
  type Usage,
  allowedEmitPorts,
  checkBackendResult,
  formatContractIssues,
  formatJsonViolations,
  jsonViolations,
  parentTrace as parentTrace_,
  scopeAccepts,
  validateContract,
} from "@nodeflow/contracts";
import { InvariantError, invariant } from "./errors.js";
import { compileContext, formatContextFailures } from "./context.js";
import { type VarBag, extractPortVars, formatExtractionFailures } from "./extract.js";
import { type ContainerInstance, InstanceRegistry, namespacedId } from "./instances.js";
import { LockLedger } from "./locks.js";
import {
  type StagePlan,
  type StagedRequest,
  assertDeclaredPorts,
  describeUndeclared,
  stageOutputs,
  undeclaredPorts,
} from "./routing.js";
import { ObjectStore, refOf } from "./store.js";
import { type Snapshotable, transact } from "./tx.js";

export type MessageState = "QUEUED" | "CLAIMED" | "CONSUMED" | "FAILED" | "DISCARDED";

export interface Message {
  readonly id: string;
  readonly target: Endpoint;
  readonly payload: Json;
  readonly state: MessageState;
  readonly failure?: string;
  readonly tunnel?: Tunnel;
  /** 协议级关联，**绝不进 payload**。 */
  readonly requestId?: string;
  readonly inReplyTo?: string;
  readonly attempts: number;
}

export interface HandlerContext {
  readonly traceid: TraceId;
  readonly nodeId: string;
  /**
   * 本次消息从哪个 receive 端口进来。
   *
   * 缺了这个，多入端口的节点无法区分"新任务来了"和"我要的回复到了" ——
   * 写 Checkpoint B 场景时才暴露：REQUEST 的回复落回同一节点，
   * handler 分不清就会再发一次请求，自己给自己造无限循环。
   */
  readonly port: string;
  /** 本次消息若是 REQUEST，其 id；否则 undefined。 */
  readonly requestId?: string;

  /**
   * 版本层的读写 —— 第四次归约的落点（不变量 C5）。
   *
   * 汇聚 / 计数 / 择优全部靠 `history`：三路各写一版，读到满三条才往下；
   * `plan@3` 就是第三轮。节点里不再有 persistent 状态。
   *
   * 受信 handler 直给；**agent 拿不到 ctx** —— 它在沙箱里跑一条命令行（§14），
   * 用自己的工具，改动由沙箱外的 git 观察。内核不中介它的工具调用。
   */
  /** 精确全局引用 —— 读卡片、读别人的产物。 */
  read(ref: Ref): ObjectVersion;
  /** 读**自己命名空间**下的 `<name>` 的全部版本。 */
  history(name: string): readonly ObjectVersion[];
  /**
   * 读某 traceid 前缀下所有叫 `<name>` 的对象（每个取最新版）。
   *
   * **跨实例汇聚靠它**（剧本帧 12）：三个 coder 子容器各写一份 `results`，
   * 父容器 `ctx.collect("job-1", "results")` 拿到三份。
   */
  collect(prefix: string, name: string): readonly ObjectVersion[];
  /**
   * 写资产到**自己的命名空间**：实际 object_id = `<本实例 traceid>/<name>`。
   *
   * 写不出自己的命名空间 —— 这既修掉了不同实例写同名对象互相污染的 bug，
   * 也是对象存储上的行级安全（§11）。随本次提交事务，回滚即撤销。
   */
  put(name: string, kind: string, body: JsonObject): Ref;

  /**
   * 容器工具：从节点内建子容器（容器八部分第 3 部分 / 剧本帧 8）。
   *
   * `slot` 必须是本容器**已声明**的子槽 —— 第一不变量：只能选不能构造，
   * handler 递不进来一个模板引用。
   *
   * 传了 `payload` 就同时把活送进子容器**已声明的 entry 端点**；
   * 没有 entry 的槽只能建空壳。这样"给 coder-1 派 task-1、给 coder-2 派 task-2"
   * 才成立，而且入口仍然是声明出来的，不是 handler 编的。
   *
   * 随本次提交事务：提交回滚则子容器与它的 child 锁一并撤销。
   */
  spawn(slot: string, segment: string, payload?: Json): TraceId;
}

export type BuiltinHandler = (
  vars: VarBag,
  ctx: HandlerContext,
) => Readonly<Record<string, Json>>;

export interface StepResult {
  readonly consumed: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly delivered: readonly string[];
  readonly dangling: readonly string[];
  readonly vars: VarBag;
  readonly termination?: Termination;
  readonly usage?: Usage;
}

export interface StepFailure {
  readonly consumed: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly reason: string;
  readonly termination?: Termination;
  readonly retrying?: boolean;
}

/**
 * 执行进行到哪一步。**只有三个值，因为只有一件事需要分支**：还在跑吗。
 *
 * 原先有七个：`RUNNING / APPLIED / VOIDED / CANCELLED / BUDGET /
 * INVALID_OUTPUT / FAILED`。后四个是 `Termination` 的**字面重复**，
 * 靠一句 `termination as ExecutionStatus` 接起来 —— 于是 `Termination`
 * 一旦增加取值，这个 cast 会**静默**造出一个非法的 ExecutionStatus。
 *
 * 而实测：七个值里只有 `RUNNING` 被代码分支读过，其余六个只写不读，
 * 是**伪装成状态的展示数据**。所以拆成两个字段，各自只表达一件事：
 *
 *   status      还在跑吗（唯一被分支的）
 *   termination 怎么结束的（`Termination` 是唯一权威，不再有第二套编码）
 */
export type ExecutionStatus = "RUNNING" | "SETTLED" | "VOIDED";

/** claim/execute/apply 的持久事实 —— 取消与崩溃接管的唯一依据。 */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly status: ExecutionStatus;
  /**
   * 怎么结束的。`RUNNING` 时没有；`VOIDED` 时无意义 —— 结果被栅栏丢掉了，
   * backend 说了什么都不作数。
   */
  readonly termination?: Termination;
  /** 被 claim 的消息集合 —— 冲突域的一半。 */
  readonly claimed: readonly string[];
  /** claim 时的实例 generation —— 冲突域的另一半，apply 时复核（L3）。 */
  readonly generation: number;
  readonly usage?: Usage;
}

export interface TruncationResult {
  readonly traceid: TraceId;
  readonly reason: string;
  readonly generation: number;
  readonly truncatedMessages: number;
  readonly releasedLocks: number;
  readonly cancelledExecutions: number;
  readonly cascaded: readonly TraceId[];
}

/**
 * 一次提交发生了什么 —— 提交钩子的载荷。
 *
 * `claim` 与其余分开，因为它们的耐久性要求不同（§17.4）：claim 之后紧接着是
 * 花钱的外部副作用，必须当场落盘；其余重放无代价，可以攒到静止点。
 */
export interface CommitEvent {
  readonly kind: "commit" | "claim" | "apply" | "settle" | "truncate";
  readonly traceid: TraceId;
  readonly executionId?: string;
}

/**
 * 提交钩子 —— **在事务内**调用。
 *
 * 抛异常即回滚整次提交。这不是意外用法，是耐久性该有的语义：
 * **落盘失败 = 提交失败**。claim 落不了盘就不该 claim，否则崩溃后恢复不出
 * "外面有个 agent 在跑"这个事实，内核会再派一个（§17.4）。
 */
export type CommitHook = (event: CommitEvent) => void;

export interface RuntimeOptions {
  readonly backend?: ExecutionBackend;
  readonly maxAttempts?: number;
  readonly onCommit?: CommitHook;
  /**
   * 可变头里保留多少条**已消费**消息。默认 200，负数表示不清理。
   *
   * 这是头唯一无界增长的来源，而头**每次提交全量重写** —— 于是累计写入是
   * 消息数的平方级。实测：2000 条已消费消息 → head.json 1.1 MB，
   * 而其中在队列里的是 0 条。文档里"账很小，不随历史增长"那句话是错的。
   */
  readonly keepConsumedMessages?: number;
}

type ClaimOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "rejected"; readonly failure: StepFailure }
  | {
      readonly kind: "claimed";
      readonly record: ExecutionRecord;
      readonly input: Message;
      readonly request: ExecutionRequest;
    };

export class Runtime implements Snapshotable {
  readonly #store: ObjectStore;
  readonly #registry: InstanceRegistry;
  readonly #ledger = new LockLedger();
  readonly #handlers = new Map<string, BuiltinHandler>();
  readonly #messages = new Map<string, Message>();
  readonly #pending = new Map<string, StagedRequest>();
  readonly #records = new Map<string, ExecutionRecord>();
  /** 同 `(实例, 节点)` 不并发 claim —— 冲突域的门。 */
  readonly #busy = new Set<string>();
  readonly #order: string[] = [];
  readonly #backend: ExecutionBackend | undefined;
  readonly #maxAttempts: number;
  readonly #onCommit: CommitHook | undefined;
  readonly #keepConsumed: number;
  #seq = 0;
  #requestSeq = 0;
  #executionSeq = 0;

  constructor(store: ObjectStore, registry: InstanceRegistry, options: RuntimeOptions = {}) {
    this.#store = store;
    this.#registry = registry;
    this.#backend = options.backend;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#onCommit = options.onCommit;
    this.#keepConsumed = options.keepConsumedMessages ?? 200;
  }

  /** 事务内通知。钩子抛出 → `transact` 回滚 → 这次提交没发生过。 */
  #commit(event: CommitEvent): void {
    this.#prune();
    this.#onCommit?.(event);
  }

  /**
   * 丢掉过老的**已消费**消息 —— 头的唯一无界增长源。
   *
   * 只丢 `CONSUMED`：它已经完整 apply 过，不会再被任何路径读。
   * **不丢 `DISCARDED`**，那是截断留下的，迟到的结果还要靠它走冲突域复核（L3）；
   * 也不丢 `QUEUED` / `CLAIMED`，那些是活的。
   *
   * 因果查询不受影响：`causesOf` 读的是 RunSnapshot 对象里的 message **id 字符串**，
   * 不需要 Message 本身。`checkInvariants` 也只交叉引用 RUNNING 记录的消息。
   *
   * 在 `#commit` 里调 ⇒ 天然在事务内，回滚一起回滚。
   * 只在明显超量时才扫，免得把平方级的磁盘写入换成平方级的内存扫描。
   */
  #prune(): void {
    if (this.#keepConsumed < 0 || this.#messages.size <= this.#keepConsumed * 2) return;

    const consumed: string[] = [];
    for (const id of this.#order) {
      if (this.#messages.get(id)?.state === "CONSUMED") consumed.push(id);
    }
    const excess = consumed.length - this.#keepConsumed;
    if (excess <= 0) return;

    // #order 是投递顺序，所以前面的就是更老的
    const doomed = new Set(consumed.slice(0, excess));
    for (const id of doomed) this.#messages.delete(id);
    const kept = this.#order.filter((id) => !doomed.has(id));
    this.#order.length = 0;
    this.#order.push(...kept);
  }

  get locks(): LockLedger {
    return this.#ledger;
  }

  /** 消息/记录都是冻结对象，浅拷贝即完整快照（§10.1）。 */
  snapshot(): unknown {
    return {
      messages: new Map(this.#messages),
      order: [...this.#order],
      pending: new Map(this.#pending),
      records: new Map(this.#records),
      seq: this.#seq,
      requestSeq: this.#requestSeq,
      executionSeq: this.#executionSeq,
    };
  }

  restore(snap: unknown): void {
    const s = snap as {
      messages: Map<string, Message>;
      order: string[];
      pending: Map<string, StagedRequest>;
      records: Map<string, ExecutionRecord>;
      seq: number;
      requestSeq: number;
      executionSeq: number;
    };
    this.#messages.clear();
    for (const [k, v] of s.messages) this.#messages.set(k, v);
    this.#order.length = 0;
    this.#order.push(...s.order);
    this.#pending.clear();
    for (const [k, v] of s.pending) this.#pending.set(k, v);
    this.#records.clear();
    for (const [k, v] of s.records) this.#records.set(k, v);
    this.#seq = s.seq;
    this.#requestSeq = s.requestSeq;
    this.#executionSeq = s.executionSeq;
  }

  /**
   * 跨四套状态机的约束检查（§10 / DBMS 的 CHECK constraint 位置）。
   *
   * 这些规则以前散在各处的 if 里，没有一处声明。测试每次提交后跑一遍，
   * 半状态就会当场暴露而不是等到某个下游断言莫名其妙地挂。
   */
  checkInvariants(): void {
    const problems: string[] = [];

    // 消息 CLAIMED ⟺ 存在引用它的 RUNNING 记录
    const claimedByRecord = new Set<string>();
    for (const rec of this.#records.values()) {
      if (rec.status !== "RUNNING") continue;
      for (const id of rec.claimed) claimedByRecord.add(id);
    }
    for (const msg of this.#messages.values()) {
      if (msg.state === "CLAIMED" && !claimedByRecord.has(msg.id)) {
        problems.push(`消息 ${msg.id} 是 CLAIMED，但没有 RUNNING 记录引用它`);
      }
    }
    for (const id of claimedByRecord) {
      const msg = this.#messages.get(id);
      if (msg !== undefined && msg.state !== "CLAIMED") {
        problems.push(`RUNNING 记录引用了 ${id}，但它是 ${msg.state}`);
      }
    }

    /**
     * **一条消息至多被一条 RUNNING 记录 claim。**
     *
     * 只看 RUNNING 是有理由的：重试后旧记录仍列着那条消息，但那是**历史**
     * 不是活跃 claim —— 把 SETTLED 也算进来会把正常的重试判成违规
     * （第一版就是这么写的，测试当场炸了）。
     *
     * 真正要挡的是"两个执行同时以为自己拥有这条消息"，
     * 那正是 claim 被偷走时的样子。§10.4 说 CHECK constraint 该在的位置。
     */
    const owner = new Map<string, string>();
    for (const rec of this.#records.values()) {
      if (rec.status !== "RUNNING") continue;
      for (const id of rec.claimed) {
        const prev = owner.get(id);
        if (prev !== undefined) {
          problems.push(`消息 ${id} 同时被 ${prev} 与 ${rec.executionId} claim`);
        } else {
          owner.set(id, rec.executionId);
        }
      }
    }

    const root = this.#registry.rootTrace;
    if (root !== null) {
      for (const inst of this.#registry.subtree(root)) {
        if (inst.status !== "TERMINAL") continue;
        // TERMINAL ⇒ 无在途消息、无在途执行、无持有锁
        const live = [...this.#messages.values()].filter(
          (m) =>
            m.target.traceid === inst.traceid &&
            (m.state === "QUEUED" || m.state === "CLAIMED"),
        );
        if (live.length > 0) {
          problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍有 ${live.length} 条在途消息`);
        }
        if (this.#ledger.held(inst.traceid).length > 0) {
          problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍持有锁`);
        }
        for (const rec of this.#records.values()) {
          if (rec.traceid === inst.traceid && rec.status === "RUNNING") {
            problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍有 RUNNING 执行 ${rec.executionId}`);
          }
        }
      }
      // child 锁存在 ⇒ 子实例未终态
      for (const lock of this.#ledger.all()) {
        if (lock.kind !== "child") continue;
        if (!this.#registry.has(lock.key)) {
          problems.push(`child 锁指向不存在的实例 ${lock.key}`);
        } else if (this.#registry.get(lock.key).status === "TERMINAL") {
          problems.push(`child 锁仍在，但子实例 ${lock.key} 已 TERMINAL`);
        }
      }
    }

    if (problems.length > 0) {
      throw new InvariantError(["状态不变量被破坏：", ...problems].join("\n  "));
    }
  }

  /** 本次提交涉及的全部可回滚部件。 */
  get #parts(): readonly Snapshotable[] {
    return [this, this.#ledger, this.#registry, this.#store];
  }

  records(): readonly ExecutionRecord[] {
    return [...this.#records.values()];
  }

  record(executionId: string): ExecutionRecord {
    const found = this.#records.get(executionId);
    if (found === undefined) throw new InvariantError(`未知 execution：${executionId}`);
    return found;
  }

  /**
   * 注册内置 handler。
   *
   * **在注册时包一层 JSON 校验**，而不是在每个调用点查 —— 一次施加，全局保证，
   * 加新的调用路径也不会漏。TypeScript 说返回 `Json` 不代表运行期真是 Json，
   * 而不校验的失败方式全是最难查的那种：键被静默丢弃、`NaN` 变 `null`、
   * `Date` 变 `{}`、循环引用让规范化序列化挂死。
   *
   * 受信 handler 返回非 JSON 是**我们自己代码的 bug** → `InvariantError` 直接抛。
   * 提交是事务的，抛了整体回滚，不留半状态。
   */
  registerHandler(name: string, fn: BuiltinHandler): void {
    if (this.#handlers.has(name)) {
      throw new InvariantError(`handler 已注册，不可覆盖：${name}`);
    }
    const guarded: BuiltinHandler = (vars, ctx) => {
      const outputs = fn(vars, ctx);
      const violations = jsonViolations(outputs, `handler:${name}`);
      if (violations.length > 0) {
        throw new InvariantError(
          `handler \`${name}\` 的输出不是合法 JSON：${formatJsonViolations(violations)}`,
        );
      }
      return outputs;
    };
    this.#handlers.set(name, guarded);
  }

  spawn(parentTrace: TraceId, slot: string, segment: string): ContainerInstance {
    const child = this.#registry.spawn(parentTrace, slot, segment);
    this.#ledger.acquire({
      holder: parentTrace,
      kind: "child",
      key: child.traceid,
      waitingOn: child.traceid,
    });
    return child;
  }

  send(target: Endpoint, payload: Json): string {
    const port = this.#resolvePort(target, "send");
    invariant(
      port.direction === "receive",
      `端口 ${target.node}.${target.port} 方向是 emit，不能作为投递目标`,
    );
    return this.#enqueue({ target, payload });
  }

  message(id: string): Message {
    const found = this.#messages.get(id);
    if (found === undefined) throw new InvariantError(`未知消息：${id}`);
    return found;
  }

  messages(): readonly Message[] {
    return this.#order.map((id) => this.#messages.get(id) as Message);
  }

  pending(): readonly Message[] {
    return this.messages().filter((m) => m.state === "QUEUED");
  }

  // -------------------------------------------------------------------------
  // 同步路径（内置 handler）
  // -------------------------------------------------------------------------

  step(): StepResult | StepFailure | null {
    const next = this.#pickWork((node) => node.handler !== undefined);
    if (next === null) return null;
    // 提交是事务：抛异常则消息状态、锁、产物、快照全部回滚（§10.1）
    return transact(this.#parts, () => {
      const result = this.#commitSync(next);
      this.#commit({ kind: "commit", traceid: next.target.traceid });
      return result;
    });
  }

  drain(maxSteps = 10_000): readonly (StepResult | StepFailure)[] {
    const results: (StepResult | StepFailure)[] = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const result = this.step();
      if (result === null) return results;
      results.push(result);
    }
    throw new InvariantError(`drain 未收敛：已执行 ${maxSteps} 步仍有 QUEUED 消息`);
  }

  // -------------------------------------------------------------------------
  // 三段式（agent 节点）
  // -------------------------------------------------------------------------

  /**
   * claim（同步）→ execute（await，临界区外）→ apply（同步）。
   *
   * 单进程里 JS 的同步段天然原子，`await` 是唯一让出点 —— 所以"execute 在提交锁外"
   * 是结构保证的，不靠自觉。并发安全由两件事共同给出：
   *   1. `#busy` 挡住同 (实例, 节点) 的并发 claim
   *   2. apply 复核 generation 与被 claim 消息的状态（冲突域）
   */
  /**
   * **只做 claim**，把执行留给调用方 —— 这是"锁外执行"的入口。
   *
   * `stepAgent` 把 claim / execute / apply 焊成一个 async 方法，于是持有状态目录
   * 锁的驱动方**只能连锁一起等**：agent 挂死 → 锁一直被占 → `truncate` 拿不到锁 →
   * "卡住的 run 杀得掉"这条承诺失效。外部审核指出的正是这个，而它是真的。
   *
   * 拆开之后驱动方可以：claim（持锁，落盘）→ 放锁 → 跑 agent → 重新拿锁 → apply。
   * §10 一直把它写成三段，只是此前没有把三段各自暴露出来。
   */
  claimAgent(): ClaimOutcome {
    return transact(this.#parts, () => {
      const outcome = this.#claim();
      if (outcome.kind === "claimed") {
        try {
          this.#commit({
            kind: "claim",
            traceid: outcome.record.traceid,
            executionId: outcome.record.executionId,
          });
        } catch (error) {
          // 钩子抛了 → 这次 claim 要整体撤销，而 `#busy` 不归 transact 管
          this.#busy.delete(`${outcome.record.traceid}/${outcome.record.nodeId}`);
          throw error;
        }
      }
      return outcome;
    });
  }

  /**
   * 把**在别处执行完**的结果应用回来。
   *
   * `record` 与入站消息从持久状态里查，不由调用方传 —— 调用方可能是
   * 另一个进程（claim 落了盘，apply 时重新打开状态目录）。让它传就等于
   * 让不可信的一侧决定"这是哪次执行的结果"。
   */
  applyAgentResult(executionId: string, raw: unknown): StepResult | StepFailure {
    // 不断言 RUNNING：实例在执行期间被截断时记录已是 CANCELLED，而迟到的结果
    // 该被**优雅丢弃**，不是抛异常 —— 冲突域复核在 `#apply` 里，那才是 L3 的落点。
    const record = this.record(executionId);
    const inputId = record.claimed[0];
    invariant(inputId !== undefined, `execution ${executionId} 没有被 claim 的消息`);
    const input = this.message(inputId);

    this.#busy.delete(`${record.traceid}/${record.nodeId}`);

    const checked = checkBackendResult(executionId, raw);
    if (!checked.ok) {
      return this.#applyFailure(record, input, "INVALID_OUTPUT", checked.reason);
    }
    return transact(this.#parts, () => {
      const result = this.#apply(record, input, checked.result);
      this.#commit({ kind: "apply", traceid: record.traceid, executionId });
      return result;
    });
  }

  /** agent 执行本身失败（backend 抛异常、超时、被杀）时的对应入口。 */
  failAgentResult(executionId: string, termination: Termination, reason: string): StepFailure {
    const record = this.record(executionId);
    const inputId = record.claimed[0];
    invariant(inputId !== undefined, `execution ${executionId} 没有被 claim 的消息`);
    this.#busy.delete(`${record.traceid}/${record.nodeId}`);
    return this.#applyFailure(record, this.message(inputId), termination, reason);
  }

  async stepAgent(): Promise<StepResult | StepFailure | null> {
    const claimed = this.claimAgent();
    // 入口校验失败不是"没活干" —— 必须把失败返回给调用方，否则 drainAgents
    // 会把它当空闲提前退出，后面合法的消息被滞留
    if (claimed.kind === "idle") return null;
    if (claimed.kind === "rejected") return claimed.failure;

    const { record, request } = claimed;
    const backend = this.#backend;
    invariant(backend !== undefined, "未配置 ExecutionBackend，agent 节点无法执行");

    let raw: unknown;
    try {
      raw = await backend.run(request);
    } catch (error) {
      // backend 抛异常 = FAILED 可重试
      return this.failAgentResult(record.executionId, "FAILED", String(error));
    }
    return this.applyAgentResult(record.executionId, raw);
  }

  async drainAgents(maxSteps = 10_000): Promise<readonly (StepResult | StepFailure)[]> {
    const results: (StepResult | StepFailure)[] = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const result = await this.stepAgent();
      if (result === null) return results;
      results.push(result);
    }
    throw new InvariantError(`drainAgents 未收敛：已执行 ${maxSteps} 步`);
  }

  #claim(): ClaimOutcome {
    const input = this.#pickWork((node) => node.agent !== undefined);
    if (input === null) return { kind: "idle" };

    const { traceid, node: nodeId } = input.target;
    const key = `${traceid}/${nodeId}`;
    if (this.#busy.has(key)) return { kind: "idle" };

    const instance = this.#registry.get(traceid);
    const template = this.#registry.template(traceid);
    const node = template.nodes[nodeId];
    invariant(node !== undefined, `实例 ${traceid} 无节点 ${nodeId}`);
    const port = node.ports[input.target.port] as Port;

    const inboundIssue = this.#checkContract(port, input.payload);
    if (inboundIssue !== null) {
      return { kind: "rejected", failure: this.#fail(input, `入站契约不符：${inboundIssue}`) };
    }
    const extraction = extractPortVars(port, input.payload);
    if (!extraction.ok) {
      return {
        kind: "rejected",
        failure: this.#fail(
          input,
          `变量提取失败：${formatExtractionFailures(extraction.failures)}`,
        ),
      };
    }

    /**
     * **全部校验做完，才动任何状态。**
     *
     * 此前顺序是「校验一半 → 置 CLAIMED、写 RUNNING 记录 → 再校验 → 拒绝」，
     * 而拒绝走的是**正常 return**，`transact` 只在 throw 时回滚 ——
     * 于是被拒的 claim 留下一条永久 RUNNING 记录：实例再也 settle 不了，
     * `checkInvariants` 当场判自己违规（RUNNING 记录引用了一条 FAILED 消息）。
     *
     * 我曾在这里写过"外层 transact 会一并撤销"，那句话是错的。
     * 与其修回滚，不如让**拒绝路径根本不产生要回滚的东西** ——
     * 把 `compileContext` 提到 mutation 之前，问题就不存在了。
     */
    const compiled = compileContext(this.#store, node, extraction.vars);
    if (!compiled.ok) {
      return {
        kind: "rejected",
        failure: this.#fail(input, `上下文编译失败：${formatContextFailures(compiled.failures)}`),
      };
    }

    // ↓ 以下才开始改状态。到这里已经不会再拒绝了。
    this.#executionSeq += 1;
    const executionId = `exec-${this.#executionSeq}`;
    this.#setState(input.id, "CLAIMED");

    const record: ExecutionRecord = Object.freeze({
      executionId,
      traceid,
      nodeId,
      status: "RUNNING" as const,
      claimed: [input.id],
      generation: instance.generation,
    });
    this.#records.set(executionId, record);

    const limits: ExecutionLimits =
      node.budget === undefined ? {} : { tokenBudget: node.budget.tokens };
    const request: ExecutionRequest = {
      executionId,
      traceid,
      nodeId,
      agentSpec: (node.agent ?? {}) as never,
      vars: compiled.vars,
      outputContract: { allowedEmitPorts: allowedEmitPorts(node.ports) },
      limits,
    };
    /**
     * `#busy` 到这一步才置位。
     *
     * 它是**进程内的执行中标记**，不是事务状态（不在 `snapshot()` 里），所以
     * `transact` 回滚不到它。早置位就意味着每条被拒的 claim 都会留下一个永不清除
     * 的 busy 标记，那个 (实例, 节点) 从此再也不被调度 —— 而且悄无声息。
     * 推迟到"确定要执行"才置位，被拒的路径就不留残迹。
     */
    this.#busy.add(key);
    return { kind: "claimed", record, input: this.message(input.id), request };
  }

  #apply(
    record: ExecutionRecord,
    input: Message,
    result: ExecutionResult,
  ): StepResult | StepFailure {
    /**
     * 冲突域复核 —— **两半都要查**。
     *
     * 注释一直写着"generation 未变 **且** 被 claim 的消息仍是 CLAIMED"，
     * 而代码只查了前半。三处论证共用这个不存在的检查：§16 的不变量表、
     * §17.14 关于孤儿认领"不必推 generation"的推理、以及 truncate 的注释。
     *
     * 后果是真的：认领把消息退回 QUEUED 之后，迟到的 apply 照样落地、
     * 照样下发下游 —— 于是"两个 agent 改同一份东西"不需要崩溃就会发生。
     */
    const instance = this.#registry.get(record.traceid);
    const stolen = record.claimed.filter((id) => {
      const m = this.#messages.get(id);
      return m === undefined || m.state !== "CLAIMED";
    });
    if (stolen.length > 0) {
      this.#records.set(record.executionId, { ...record, status: "VOIDED" });
      return {
        consumed: record.claimed[0] ?? "",
        traceid: record.traceid,
        nodeId: record.nodeId,
        reason:
          `结果作废：被 claim 的消息 ${stolen.join("、")} 已不再是 CLAIMED` +
          `（多半是被认领退回队列、或被截断丢弃）。迟到的结果不覆盖新的 claim`,
        termination: result.termination,
      };
    }
    if (instance.status !== "OPEN" || instance.generation !== record.generation) {
      this.#records.set(record.executionId, { ...record, status: "VOIDED" });
      return {
        consumed: input.id,
        traceid: record.traceid,
        nodeId: record.nodeId,
        reason:
          `结果作废：实例 generation ${record.generation} → ${instance.generation}` +
          `（状态 ${instance.status}）。迟到的 apply 必然失败，不复活已截断实例`,
        termination: result.termination,
      };
    }

    if (result.termination !== "DONE") {
      return this.#applyFailure(
        record,
        input,
        result.termination,
        `执行终止于 ${result.termination}`,
        result.usage,
      );
    }

    // 执行观测先落，成败都留痕 —— 见 #recordExecution
    this.#recordExecution(record, result);

    const template = this.#registry.template(record.traceid);
    const node = template.nodes[record.nodeId];
    invariant(node !== undefined, `节点 ${record.nodeId} 不存在`);

    // 端口越界在 agent 路径是 INVALID_OUTPUT，**不是**编程错误：
    // backend 跑的是模型输出，属不可信边界。抛异常会让消息永久停在 CLAIMED、
    // 记录永久停在 RUNNING，三个终止谓词从此不可能满足。
    const offenders = undeclaredPorts(node, result.emissions);
    if (offenders.length > 0) {
      return this.#applyFailure(
        record,
        input,
        "INVALID_OUTPUT",
        describeUndeclared(node, record.nodeId, offenders),
        result.usage,
      );
    }

    for (const [portName, value] of Object.entries(result.emissions)) {
      const issue = this.#checkContract(node.ports[portName] as Port, value);
      if (issue !== null) {
        return this.#applyFailure(
          record,
          input,
          "INVALID_OUTPUT",
          `端口 \`${portName}\` 出站契约不符：${issue}`,
          result.usage,
        );
      }
    }

    /**
     * 产物地址**由内核决定**，不是 agent 报什么就写什么。
     *
     * 此前 backend 把沙箱里的文件名原样当 object_id，内核原样 `put` ——
     * 于是 agent 写一个 `artifacts/job-1/coder-2/result.json`，就落进**兄弟实例**
     * 的命名空间；写 `artifacts/root.json` 就能给根模板对象追加一版。
     *
     * 讽刺的是受信 handler 的 `ctx.put` 早就强制命名空间了（那个 bug 当初是
     * 探针实证出来的），**不受信的 agent 反而没有** —— 正好反了。
     * `checkBackendResult` 只挡了保留 kind，挡不住地址。
     *
     * 非法资产名归 INVALID_OUTPUT：这是不可信边界返回的坏数据，不是内核故障。
     */
    const namespaced: { submission: ArtifactSubmission; id: string }[] = [];
    for (const artifact of result.artifacts ?? []) {
      try {
        namespaced.push({
          submission: artifact,
          id: namespacedId(record.traceid, artifact.object_id),
        });
      } catch (error) {
        return this.#applyFailure(
          record,
          input,
          "INVALID_OUTPUT",
          `产物名非法：${(error as Error).message}`,
          result.usage,
        );
      }
    }

    const outcome = stageOutputs(
      this.#stageContext(template, node, record.traceid, record.nodeId, input, instance),
      result.emissions,
    );
    if (!outcome.ok) {
      return this.#applyFailure(record, input, "INVALID_OUTPUT", outcome.reason, result.usage);
    }

    // 产物与下游一起提交：先全部校验通过，再一次性落。
    // 边写边校验会在中途失败时留下部分版本 —— 违反零部分提交。
    for (const { submission, id } of namespaced) {
      this.#store.put(id, submission.kind, submission.body, {
        traceid: record.traceid,
        node_id: record.nodeId,
        execution_id: record.executionId,
        at_seq: 0,
        derived_from: submission.derived_from,
      });
    }

    const delivered = this.#commitPlan(outcome.plan);
    this.#setState(input.id, "CONSUMED");
    this.#records.set(record.executionId, {
      ...record,
      status: "SETTLED" as const,
      termination: "DONE" as const,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });
    this.#recordSnapshot(record.traceid, record.nodeId, [input.id], delivered, {
      execution: record.executionId,
      termination: result.termination,
      artifacts: (result.artifacts ?? []).map((a) => a.object_id),
      ...(result.usage === undefined ? {} : { usage: result.usage as never }),
    });

    return {
      consumed: input.id,
      traceid: record.traceid,
      nodeId: record.nodeId,
      delivered,
      dangling: outcome.plan.dangling,
      vars: {},
      termination: "DONE",
      usage: result.usage ?? EMPTY_USAGE,
    };
  }

  /**
   * 五种终止不混成一种：
   *   CANCELLED / BUDGET  是意图不是故障 → 不重试，消息 DISCARDED
   *   INVALID_OUTPUT / FAILED  → 按 maxAttempts 重试，耗尽后 FAILED
   */
  #applyFailure(
    record: ExecutionRecord,
    input: Message,
    termination: Termination,
    reason: string,
    usage?: Usage,
  ): StepFailure {
    this.#records.set(record.executionId, {
      ...record,
      status: "SETTLED" as const,
      termination,
      ...(usage === undefined ? {} : { usage }),
    });

    if (NON_RETRYABLE.includes(termination)) {
      this.#setState(input.id, "DISCARDED", reason);
      return {
        consumed: input.id,
        traceid: record.traceid,
        nodeId: record.nodeId,
        reason,
        termination,
        retrying: false,
      };
    }

    const attempts = input.attempts + 1;
    if (attempts < this.#maxAttempts) {
      this.#replace(input.id, { state: "QUEUED", attempts, failure: reason });
      return {
        consumed: input.id,
        traceid: record.traceid,
        nodeId: record.nodeId,
        reason,
        termination,
        retrying: true,
      };
    }
    this.#replace(input.id, { state: "FAILED", attempts, failure: reason });
    return {
      consumed: input.id,
      traceid: record.traceid,
      nodeId: record.nodeId,
      reason: `${reason}（已重试 ${attempts} 次，放弃）`,
      termination,
      retrying: false,
    };
  }

  // -------------------------------------------------------------------------
  // 终止与截断
  // -------------------------------------------------------------------------

  terminationBlockers(trace: TraceId): readonly string[] {
    const blockers: string[] = [];
    const live = this.messages().filter(
      (m) => m.target.traceid === trace && (m.state === "QUEUED" || m.state === "CLAIMED"),
    );
    if (live.length > 0) blockers.push(`${live.length} 条待处理消息`);

    const running = this.records().filter(
      (r) => r.traceid === trace && r.status === "RUNNING",
    );
    if (running.length > 0) blockers.push(`${running.length} 个在途 execution`);

    for (const lock of this.#ledger.held(trace)) {
      blockers.push(
        `锁 ${lock.kind}${lock.waitingOn === undefined ? "" : ` · 等 ${lock.waitingOn}`}` +
          `${lock.originNode === undefined ? "" : `（${lock.originNode} 发起）`}`,
      );
    }
    return blockers;
  }

  canTerminate(trace: TraceId): boolean {
    return this.terminationBlockers(trace).length === 0;
  }

  /**
   * **自然终止** —— 三谓词满足后进终态，并销掉父容器对本实例的 `child` 锁。
   *
   * 这是与强制截断完全分开的一条路径（§9.1 那张表的左半列）：
   * 截断是 fiat，自然终止是"它做完了"。没有这个提交点，成功完成的子容器
   * 不会释放父的 child 锁，父容器永远无法自然完成，主线闭不上。
   */
  settle(trace: TraceId): boolean {
    const instance = this.#registry.get(trace);
    if (instance.status !== "OPEN") return false;
    if (!this.canTerminate(trace)) return false;

    return transact(this.#parts, () => {
      this.#registry.setStatus(trace, "TERMINAL");
      // 子终态 → 父的 child 锁销账（L1 第 2 种的对偶）
      this.#ledger.releaseByKey("child", trace);
      this.#notifyParent(instance);
      this.#commit({ kind: "settle", traceid: trace });
      return true;
    });
  }

  /**
   * 子实例进终态 → 往父容器声明的 `exit` 端点投一条**通知**。
   *
   * 没有这一步，`settle` 只释放锁、不叫醒任何人：子干完活父完全不知道，
   * 剧本帧 12（三路汇聚）会断链 —— merge 节点永远等不到触发。
   *
   * 载荷只是通知（谁、从哪个槽、什么状态），**不带子容器的产出** ——
   * 内容在资产里，父用 `ctx.collect` 取（C5：版本历史即状态，
   * 消息降级成通知）。
   */
  #notifyParent(child: ContainerInstance): void {
    const parentTrace = parentTrace_(child.traceid);
    if (parentTrace === null || child.slot === undefined) return;
    if (!this.#registry.has(parentTrace)) return;

    const parent = this.#registry.get(parentTrace);
    if (parent.status !== "OPEN") return;

    const exit = this.#registry.template(parentTrace).children[child.slot]?.exit;
    if (exit === undefined) return;

    this.#enqueue({
      target: { traceid: parentTrace, node: exit.node, port: exit.port },
      payload: { slot: child.slot, traceid: child.traceid, status: "TERMINAL" },
    });
  }

  /**
   * 自底向上收敛：深的先 settle，因为子终态才能释放父的 child 锁。
   * 反复扫到不再有进展为止。
   */
  settleAll(): readonly TraceId[] {
    const root = this.#registry.rootTrace;
    if (root === null) return [];
    const settled: TraceId[] = [];
    for (;;) {
      const byDepthDesc = [...this.#registry.subtree(root)].sort(
        (a, b) => b.traceid.split("/").length - a.traceid.split("/").length,
      );
      const before = settled.length;
      for (const inst of byDepthDesc) {
        if (this.settle(inst.traceid)) settled.push(inst.traceid);
      }
      if (settled.length === before) return settled;
    }
  }

  /**
   * 强制截断（L3 / L4）。
   *
   * 外层包事务：截断连改七处（generation、execution 状态、消息、两类锁、
   * pending 表、实例状态），还要递归级联到子树。中途抛出而没有回滚的话，
   * 留下的是"栅栏推了但锁没放"这类半截状态 —— 比不截断更难收拾。
   */
  truncate(trace: TraceId, reason: string): TruncationResult {
    return transact(this.#parts, () => {
      const result = this.#truncate(trace, reason);
      this.#commit({ kind: "truncate", traceid: trace });
      return result;
    });
  }

  /** 递归本体。已在外层事务里，自己不再开事务。 */
  #truncate(trace: TraceId, reason: string): TruncationResult {
    const instance = this.#registry.get(trace);
    if (instance.status === "TERMINAL") {
      return {
        traceid: trace,
        reason,
        generation: instance.generation,
        truncatedMessages: 0,
        releasedLocks: 0,
        cancelledExecutions: 0,
        cascaded: [],
      };
    }

    // 0. 推进栅栏 —— 气密性的唯一依据
    const bumped = this.#registry.bumpGeneration(trace);

    // 1. 取消在途 execution（best effort；真正保证靠第 0 步）
    let cancelledExecutions = 0;
    for (const rec of this.records()) {
      if (rec.traceid !== trace || rec.status !== "RUNNING") continue;
      this.#records.set(rec.executionId, {
        ...rec,
        status: "SETTLED",
        termination: "CANCELLED",
      });
      void this.#backend?.cancel(rec.executionId).catch(() => undefined);
      cancelledExecutions += 1;
    }

    // 2. 未消费消息 → 丢弃，留计数
    let truncatedMessages = 0;
    for (const msg of this.messages()) {
      if (msg.target.traceid !== trace) continue;
      if (msg.state !== "QUEUED" && msg.state !== "CLAIMED") continue;
      this.#setState(msg.id, "DISCARDED", `实例被截断：${reason}`);
      truncatedMessages += 1;
    }

    // 3 + 4. 自己持有的锁作废；自己在别处造成的锁**反向释放**
    const own = this.#ledger.held(trace);
    const caused = this.#ledger.causedBy(trace);
    for (const lock of [...own, ...caused]) this.#ledger.release(lock.id);
    for (const [requestId, req] of [...this.#pending]) {
      if (req.requester === trace) this.#pending.delete(requestId);
    }

    // 5. 子实例级联
    const cascaded: TraceId[] = [];
    for (const child of this.#registry.children(trace)) {
      if (child.status === "TERMINAL") continue;
      cascaded.push(child.traceid);
      this.#truncate(child.traceid, `父容器 ${trace} 截断`);
    }

    // 6. 终态
    this.#registry.setStatus(trace, "TERMINAL");

    return {
      traceid: trace,
      reason,
      generation: bumped.generation,
      truncatedMessages,
      releasedLocks: own.length + caused.length,
      cancelledExecutions,
      cascaded,
    };
  }

  // -------------------------------------------------------------------------

  #pickWork(accept: (node: NodeDefinition) => boolean): Message | null {
    for (const msg of this.pending()) {
      const instance = this.#registry.get(msg.target.traceid);
      if (instance.status !== "OPEN") continue;
      const node = this.#registry.template(msg.target.traceid).nodes[msg.target.node];
      if (node === undefined || !accept(node)) continue;
      return msg;
    }
    return null;
  }

  #commitSync(input: Message): StepResult | StepFailure {
    const { traceid, node: nodeId } = input.target;
    const instance = this.#registry.get(traceid);
    const template = this.#registry.template(traceid);
    const node = template.nodes[nodeId];
    invariant(node !== undefined, `实例 ${traceid} 无节点 ${nodeId}`);
    const port = node.ports[input.target.port];
    invariant(port !== undefined, `节点 ${nodeId} 无端口 ${input.target.port}`);

    const inboundIssue = this.#checkContract(port, input.payload);
    if (inboundIssue !== null) return this.#fail(input, `入站契约不符：${inboundIssue}`);

    const extraction = extractPortVars(port, input.payload);
    if (!extraction.ok) {
      return this.#fail(input, `变量提取失败：${formatExtractionFailures(extraction.failures)}`);
    }

    invariant(node.handler !== undefined, `节点 ${nodeId} 声明了 agent 段，走三段式而非同步路径`);
    const fn = this.#handlers.get(node.handler);
    invariant(fn !== undefined, `未注册的内置 handler：${node.handler}`);
    const outputs = fn(extraction.vars, this.#handlerContext(traceid, nodeId, input));

    assertDeclaredPorts(node, nodeId, outputs);
    for (const [portName, value] of Object.entries(outputs)) {
      const issue = this.#checkContract(node.ports[portName] as Port, value);
      if (issue !== null) {
        return this.#fail(input, `端口 \`${portName}\` 出站契约不符：${issue}`);
      }
    }

    const outcome = stageOutputs(
      this.#stageContext(template, node, traceid, nodeId, input, instance),
      outputs,
    );
    if (!outcome.ok) return this.#fail(input, outcome.reason);

    const delivered = this.#commitPlan(outcome.plan);
    this.#setState(input.id, "CONSUMED");
    this.#recordSnapshot(traceid, nodeId, [input.id], delivered, {});
    return {
      consumed: input.id,
      traceid,
      nodeId,
      delivered,
      dangling: outcome.plan.dangling,
      vars: extraction.vars,
    };
  }

  /**
   * 执行观测 —— 落成**对象**，不给 `ExecutionRecord` 加字段。
   *
   * 之前 backend 算出的 `diagnostics`（含沙箱外 git 观察：改了哪些文件、加删多少行）
   * **被原地丢弃** —— `#apply` 只读 emissions / artifacts / usage / termination。
   * 归约 5 的招牌机制断在最后一步。
   *
   * 修法不是给记录结构加字段，那会让可变头随执行次数增长。而是**落进版本层**：
   * 一次执行一版 `<traceid>/$exec`，于是它自动获得不可变、内容寻址、
   * 可按前缀查询、随事务提交 —— 全是 C5 已经提供的性质。
   * 顺带 `hertaloy show` / `history` 立刻就能读，不需要新命令。
   *
   * 放在 `#apply` 开头而不是结尾：后面每条 INVALID_OUTPUT 分支都会提前 return，
   * 而**失败时的观测比成功时更值钱**。同一个事务，回滚时它一起回滚。
   */
  #recordExecution(record: ExecutionRecord, result: ExecutionResult): void {
    if (result.diagnostics === undefined) return;
    this.#store.put(
      `${record.traceid}/$exec`,
      "execution",
      {
        execution_id: record.executionId,
        node: record.nodeId,
        termination: result.termination,
        ...(result.usage === undefined ? {} : { usage: result.usage as unknown as Json }),
        diagnostics: result.diagnostics,
      },
      {
        traceid: record.traceid,
        node_id: record.nodeId,
        execution_id: record.executionId,
        at_seq: 0,
        derived_from: [],
      },
    );
  }

  /**
   * **孤儿执行**：记录是 RUNNING，但本进程没在跑它。
   *
   * 这里不引入 `RECONCILING / ADOPTED / ABANDONED` 那套状态机 —— 因为
   * "有没有进程在跑"根本不是持久状态，它是**进程本地事实**（`#busy`）。
   * 把进程本地事实写进持久状态，才需要状态机去对齐两边；不写就不需要。
   *
   * 判据靠状态目录锁给出：单写者模型下，**拿到锁时看到的 RUNNING 必然是孤儿** ——
   * 能写这个 run 的进程只有一个，而它就是我们自己。
   */
  orphanedExecutions(): readonly ExecutionRecord[] {
    return this.records().filter(
      (r) => r.status === "RUNNING" && !this.#busy.has(`${r.traceid}/${r.nodeId}`),
    );
  }

  /**
   * 认领孤儿 —— **复用既有的失败路径**，不新增机制。
   *
   * 孤儿就是一次没跑完的 attempt，而"一次失败的 attempt 该怎么办"内核早就答过了：
   * `#applyFailure` 负责计数、重排队、到上限放弃。所以这里只是把孤儿喂给它。
   *
   * 也不必推 generation：`#apply` 的冲突域复核要求"被 claim 的消息仍是 CLAIMED"，
   * 而认领会把消息退回 QUEUED —— 迟到的结果撞上这条就作废了。L3 已经覆盖。
   *
   * 这不是"当作没发生过"：每个孤儿产出一条带原因的 `StepFailure`，
   * 计入 attempts，超限即 FAILED，在 `status` 里看得见。
   */
  reconcile(reason = "上一个进程没有跑完这次执行"): readonly StepFailure[] {
    const orphans = this.orphanedExecutions();
    if (orphans.length === 0) return [];
    return transact(this.#parts, () => {
      const out = orphans.map((r) => this.failAgentResult(r.executionId, "FAILED", reason));
      this.#commit({ kind: "apply", traceid: orphans[0]!.traceid });
      return out;
    });
  }

  /**
   * RunSnapshot —— **因果权威**（不变量 C2 的另一半）。
   *
   * 每次提交记下"本次消费了哪些输入、产出了哪些输出"，那就是因果边。
   * 所以消息信封里不存 `causation_ids`：同一事实在这里已经有了，
   * 再存一份是冗余，而且两处会漂移。
   *
   * `seq` 只在这里推进 —— claim 单独写 ExecutionRecord，不推进 seq，
   * 因此快照序列没有空洞。
   */
  #recordSnapshot(
    trace: TraceId,
    nodeId: string,
    consumed: readonly string[],
    produced: readonly string[],
    extra: Readonly<Record<string, Json>>,
  ): void {
    const seq = this.#registry.bumpSeq(trace);
    // id 前缀跟着 traceid 走，不是 `run/<traceid>`。
    // 前缀机制被复用了八处（订阅域、子树查询、反向销锁、截断级联、对象命名空间、
    // 授权域、内网名、GC），唯独这里曾自成一格 —— 于是按 `job-1/` 回收会漏掉
    // `run/job-1/…`。现在改是改一行，等第一次 GC 才发现就是改数据。
    this.#store.put(
      `${trace}/$run`,
      "run",
      { seq, node: nodeId, consumed: [...consumed], produced: [...produced], ...extra },
      { traceid: trace, node_id: nodeId, at_seq: seq, derived_from: [] },
    );
  }

  /** 某实例的全部提交快照，按 seq 升序。 */
  snapshots(trace: TraceId): readonly ObjectVersion[] {
    return this.#store.history(`${trace}/$run`);
  }

  /**
   * 因果查询：这条消息是由哪些消息导致的。
   *
   * 从快照的 `produced → consumed` 反查 —— 这就是 traceid 表达不了、
   * 而 RunSnapshot 承担的那一半（扇出后子消息 traceid 相同却各有前因；
   * 汇聚时一条输出有多个前因）。
   */
  causesOf(messageId: string): readonly string[] {
    const root = this.#registry.rootTrace;
    if (root === null) return [];
    for (const instance of this.#registry.subtree(root)) {
      for (const snap of this.snapshots(instance.traceid)) {
        const produced = snap.body.produced as readonly string[] | undefined;
        if (produced?.includes(messageId) === true) {
          return snap.body.consumed as readonly string[];
        }
      }
    }
    return [];
  }

  /**
   * 受信 handler 的 ctx。`put` 走本次提交的事务，回滚即撤销。
   *
   * 内核保留 kind 仍然挡着 —— 受信不等于可以伪造 `run` / `annotation`，
   * 那会污染因果记录。
   */
  #handlerContext(traceid: TraceId, nodeId: string, input: Message): HandlerContext {
    const store = this.#store;
    return {
      traceid,
      nodeId,
      port: input.target.port,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      read: (ref: Ref) => store.resolve(ref),
      history: (name: string) => store.history(namespacedId(traceid, name)),
      collect: (prefix: string, name: string) => store.collect(prefix, name),
      spawn: (slot: string, segment: string, payload?: Json): TraceId => {
        const child = this.spawn(traceid, slot, segment);
        if (payload === undefined) return child.traceid;

        const declared = this.#registry.template(traceid).children[slot];
        const entry = declared?.entry;
        if (entry === undefined) {
          throw new InvariantError(
            `子槽 \`${slot}\` 未声明 entry，无法投递初始载荷；` +
              `要么在模板里声明 entry，要么只建空壳（不传 payload）`,
          );
        }
        this.send({ traceid: child.traceid, node: entry.node, port: entry.port }, payload);
        return child.traceid;
      },
      put: (name: string, kind: string, body: JsonObject): Ref => {
        const violations = jsonViolations(body, `put:${name}`);
        if (violations.length > 0) {
          throw new InvariantError(
            `写入 \`${name}\` 的 body 不是合法 JSON：${formatJsonViolations(violations)}`,
          );
        }
        if (isKernelKind(kind)) {
          throw new InvariantError(
            `handler 不得写入内核保留 kind \`${kind}\`（对象 ${name}）`,
          );
        }
        return refOf(
          store.put(namespacedId(traceid, name), kind, body, {
            traceid,
            node_id: nodeId,
            at_seq: 0,
            derived_from: [],
          }),
        );
      },
    };
  }

  #stageContext(
    template: ReturnType<InstanceRegistry["template"]>,
    node: NonNullable<ReturnType<InstanceRegistry["template"]>["nodes"][string]>,
    traceid: TraceId,
    nodeId: string,
    input: Message,
    instance: ContainerInstance,
  ) {
    return {
      template,
      node,
      traceid,
      nodeId,
      generation: instance.generation,
      inboundMessageId: input.id,
      ...(input.requestId === undefined ? {} : { inboundRequestId: input.requestId }),
      subscribers: (tunnel: string) => this.#subscribers(tunnel as Tunnel, traceid),
      lookupRequest: (requestId: string) => this.#pending.get(requestId),
      nextRequestId: () => {
        this.#requestSeq += 1;
        return `req-${this.#requestSeq}`;
      },
    };
  }

  /** 一次性落地排期结果 —— 零部分提交的提交点。 */
  #commitPlan(plan: StagePlan): readonly string[] {
    for (const requestId of plan.resolved) {
      this.#pending.delete(requestId);
      this.#ledger.releaseByKey("request", requestId);
    }
    for (const spec of plan.locks) this.#ledger.acquire(spec);
    for (const req of plan.requests) this.#pending.set(req.requestId, req);
    return plan.messages.map((m) => this.#enqueue(m));
  }

  #subscribers(tunnel: Tunnel, sender: TraceId): readonly Endpoint[] {
    const root = this.#registry.rootTrace;
    if (root === null) return [];
    const out: Endpoint[] = [];
    for (const instance of this.#registry.subtree(root)) {
      if (instance.status !== "OPEN") continue;
      for (const sub of Object.values(this.#registry.template(instance.traceid).subscriptions)) {
        if (sub.tunnel !== tunnel) continue;
        // 相对作用域按**订阅方实例**解析，所以同一模板换实例仍然正确
        if (!scopeAccepts(sub.scope, instance.traceid, sender)) continue;
        out.push({ traceid: instance.traceid, node: sub.to.node, port: sub.to.port });
      }
    }
    return out;
  }

  #checkContract(port: Port, payload: Json): string | null {
    if (port.contract === undefined) return null;
    const schema = this.#store.resolve(port.contract).body as unknown as MessageContract;
    const issues = validateContract(schema, payload);
    return issues.length === 0 ? null : formatContractIssues(issues);
  }

  #fail(input: Message, reason: string): StepFailure {
    this.#failMessage(input, reason);
    return {
      consumed: input.id,
      traceid: input.target.traceid,
      nodeId: input.target.node,
      reason,
    };
  }

  #failMessage(input: Message, reason: string): void {
    this.#setState(input.id, "FAILED", reason);
  }

  #enqueue(spec: Omit<Message, "id" | "state" | "attempts">): string {
    this.#seq += 1;
    const id = `msg-${this.#seq}`;
    this.#messages.set(
      id,
      Object.freeze({ ...spec, id, state: "QUEUED" as const, attempts: 0 }),
    );
    this.#order.push(id);
    return id;
  }

  #setState(id: string, state: MessageState, failure?: string): void {
    this.#replace(id, failure === undefined ? { state } : { state, failure });
  }

  #replace(id: string, patch: Partial<Message>): void {
    this.#messages.set(id, Object.freeze({ ...this.message(id), ...patch }));
  }

  #resolvePort(target: Endpoint, where: string): Port {
    const instance = this.#registry.get(target.traceid);
    invariant(instance.status === "OPEN", `${where}：实例 ${target.traceid} 已 ${instance.status}`);
    const template = this.#registry.template(target.traceid);
    const node = template.nodes[target.node];
    if (node === undefined) {
      throw new InvariantError(
        `${where}：实例 ${target.traceid} 无节点 \`${target.node}\`。` +
          `可用节点：${Object.keys(template.nodes).sort().join(", ") || "（无）"}`,
      );
    }
    const port = node.ports[target.port];
    if (port === undefined) {
      throw new InvariantError(
        `${where}：节点 \`${target.node}\` 未声明端口 \`${target.port}\`。` +
          `可用端口：${Object.keys(node.ports).sort().join(", ") || "（无）"}`,
      );
    }
    return port;
  }
}
