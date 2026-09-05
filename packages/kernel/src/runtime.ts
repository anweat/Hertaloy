/**
 * 编排的**命令面** —— 内网转发 + 网关 + 强制截断 + 三段式。
 *
 * 对应 FOUNDATION_V5.md §8 / §9 / §10：
 *   M1/M2/M3  编排权威属于边；别名沿 traceid 向上解析；callback 落已声明端点
 *   L1/L2     义务全部派生，没有记账点；owner 唯一是容器
 *   L3        截断靠 generation fence，`cancel` 只是 best effort
 *   L5        可终止 ⟺ 名下未了结的义务为空
 *   §10       claim（同步临界区）→ execute（await，临界区外）→ apply（同步临界区）
 *             冲突域 = 实例 + 被消费的消息集合
 *
 * **零部分提交**：排期（`routing.stageOutputs`）与提交分离，失败时一条下游都不创建。
 * **绑定不物化为实例对象**：模板声明 + 创建时物化进实例 ⇒ 当前可达的目标是派生的，
 * 没有退订簿记，也就没有幽灵订阅。
 *
 * ## 这里留下的与搬走的
 *
 * 搬走的都是**组件**（内部分解，为了可测与可读），不是可插拔点：
 *
 *   queue.ts       消息与投递顺序
 *   executions.ts  执行记录 + 本进程在驱动谁
 *   obligations.ts 未了结的义务（纯函数）
 *   invariants.ts  跨状态机的约束检查（纯函数）
 *   aliases/       别名：按时机分成 check / materialize / resolve
 *   facts.ts       上面几样共用的事实投影
 *
 * 留下的是**命令**：三段式与强制截断。它们是"多实例 + 外部副作用"这两个词
 * 合起来的必然要求，硬拆只会把一条内聚的提交路径切成来回传参的几段。
 *
 * 唯一真正的策略缝是 `scheduling.ts`（先跑哪条）—— 判据见那个文件。
 */

import {
  EMPTY_USAGE,
  type Endpoint,
  type ExecutionBackend,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type Json,
  type MessageSource,
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
  type Usage,
  allowedEmitPorts,
  checkBackendResult,
  formatContractIssues,
  formatJsonViolations,
  jsonViolations,
  parentTrace as parentTrace_,
  validateContract,
} from "@nodeflow/contracts";
import { InvariantError, invariant } from "./errors.js";
import { compileContext, formatContextFailures } from "./context.js";
import { type VarBag, extractPortVars, formatExtractionFailures } from "./extract.js";
import { type ContainerInstance, InstanceRegistry, namespacedId } from "./instances.js";
import { LockView } from "./locks.js";
import { type Message, type MessageState, MessageQueue, isLive } from "./queue.js";
import { formatProblems, stateProblems } from "./invariants.js";
import { type Candidate, type Scheduler, acceptedPick, fifo } from "./scheduling.js";
import { type ExecutionRecord, ExecutionLedger } from "./executions.js";
import { resolveAlias } from "./aliases/index.js";
import {
  type ObligationFacts,
  type Obligation,
  describeObligations,
  obligationsOf,
  outstanding,
} from "./obligations.js";
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

/**
 * 消息与队列已抽到 `queue.ts`。这里再导出，保持既有 import 路径不变 ——
 * 拆分不该让下游改 import，那样就不是"能单独回滚的一步"了。
 */
export { MessageQueue, isLive, LIVE_MESSAGE_STATES } from "./queue.js";
export type { Message, MessageState } from "./queue.js";

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
 * 执行记录已抽到 `executions.ts`。这里再导出，保持既有 import 路径不变。
 */
export { ExecutionLedger } from "./executions.js";
export type { ExecutionRecord, ExecutionStatus } from "./executions.js";

export interface TruncationResult {
  readonly traceid: TraceId;
  readonly reason: string;
  readonly generation: number;
  readonly truncatedMessages: number;
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
  /**
   * 先跑哪条。默认 `fifo`（先到先跑，天然无饥饿）。
   *
   * **内核唯一真正的策略缝** —— 换掉它一条不变量都不破（见 `scheduling.ts`）。
   * 换成优先级 / 公平 / 按租户配额都行，但饿死谁由换的人负责。
   */
  readonly scheduler?: Scheduler;
}

/**
 * 入站校验的结果。**没有 StepFailure，只有 reason** —— 两条路径把同一个理由
 * 包成各自的失败形状（同步是 `StepFailure`，三段式是 `{kind:"rejected"}`），
 * 而这里不该知道调用方要哪一种。
 */
type PrepareOutcome =
  | {
      readonly ok: true;
      /** 完整变量袋：bind 段 + 端口 servo。交给 handler / agent 的就是它。 */
      readonly vars: VarBag;
      /** 只从本条消息提取的那部分 —— StepResult 里报的是这个。 */
      readonly portVars: VarBag;
    }
  | { readonly ok: false; readonly reason: string };

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
  readonly #handlers = new Map<string, BuiltinHandler>();
  readonly #queue: MessageQueue;
  readonly #pending = new Map<string, StagedRequest>();
  readonly #ledger = new ExecutionLedger();
  readonly #backend: ExecutionBackend | undefined;
  readonly #maxAttempts: number;
  readonly #onCommit: CommitHook | undefined;
  readonly #scheduler: Scheduler;
  #requestSeq = 0;

  constructor(store: ObjectStore, registry: InstanceRegistry, options: RuntimeOptions = {}) {
    this.#store = store;
    this.#registry = registry;
    this.#backend = options.backend;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#onCommit = options.onCommit;
    this.#queue = new MessageQueue(options.keepConsumedMessages ?? 200);
    this.#scheduler = options.scheduler ?? fifo;
  }

  /** 事务内通知。钩子抛出 → `transact` 回滚 → 这次提交没发生过。 */
  #commit(event: CommitEvent): void {
    this.#queue.prune();
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
  get locks(): LockView {
    return new LockView(this.obligations());
  }

  /**
   * 落盘形状**逐键写明，不用展开**。
   *
   * 队列与执行记录各自的快照里都有一个 `seq`，展开会互相覆盖，而且是静默的：
   * `executionSeq` 会整个消失，老 run 装进来时消息 id 从头发放、覆盖既有消息。
   * 拆分时差点就这么写了 —— 子部件各自命名自己的计数器，合成时必须显式改名。
   *
   * **不再有 `audit` / `auditSeq`**：授权日志不是编排状态，是追加写的观测日志
   * （§17.6），已搬到 ControlPlane 的注入日志上。老 head 里若带着这两个键，
   * 装载时原样忽略。
   */
  snapshot(): unknown {
    const queue = this.#queue.snapshot() as {
      messages: Map<string, Message>;
      order: string[];
      seq: number;
    };
    const ledger = this.#ledger.snapshot() as {
      records: Map<string, ExecutionRecord>;
      seq: number;
    };
    return {
      messages: queue.messages,
      order: queue.order,
      seq: queue.seq,
      pending: new Map(this.#pending),
      records: ledger.records,
      executionSeq: ledger.seq,
      requestSeq: this.#requestSeq,
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
    this.#queue.restore({ messages: s.messages, order: s.order, seq: s.seq });
    this.#pending.clear();
    for (const [k, v] of s.pending) this.#pending.set(k, v);
    this.#ledger.restore({ records: s.records, seq: s.executionSeq });
    this.#requestSeq = s.requestSeq;
  }

  /**
   * 跨状态机的约束检查。**规则本身在 `invariants.ts`，是纯函数**（§10.4）。
   *
   * 这里只负责把事实凑齐、把违规抛出来。分开的理由是可测性：挂在运行时上时，
   * 要测"两个执行同时 claim 了一条消息"就得先把运行时摆成那个样子 ——
   * 而正确的运行时**摆不出来**。
   */
  checkInvariants(): void {
    const root = this.#registry.rootTrace;
    const message = formatProblems(
      stateProblems({
        messages: this.#queue.all(),
        executions: this.#ledger.all(),
        instances: root === null ? [] : this.#registry.subtree(root),
        obligations: this.obligations(),
      }),
    );
    if (message !== null) throw new InvariantError(message);
  }

  /** 本次提交涉及的全部可回滚部件。 */
  get #parts(): readonly Snapshotable[] {
    return [this, this.#registry, this.#store];
  }

  records(): readonly ExecutionRecord[] {
    return this.#ledger.all();
  }

  record(executionId: string): ExecutionRecord {
    const found = this.#ledger.all().find((r) => r.executionId === executionId);
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
    // 不再记 child 锁：子实例存在且 OPEN **就是**那份义务本身。
    // 记账的那一版还依赖一条不成文约定——谁都不许直接调 `registry.spawn`，
    // 而没有任何东西强制它。现在造不出"有子实例却没有义务"的状态。
    return this.#registry.spawn(parentTrace, slot, segment);
  }

  send(target: Endpoint, payload: Json): string {
    const port = this.#resolvePort(target, "send");
    invariant(
      port.direction === "receive",
      `端口 ${target.node}.${target.port} 方向是 emit，不能作为投递目标`,
    );
    return this.#queue.enqueue({ target, payload });
  }

  message(id: string): Message {
    return this.#queue.get(id);
  }

  messages(): readonly Message[] {
    return this.#queue.all();
  }

  pending(): readonly Message[] {
    return this.#queue.queued();
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
          this.#ledger.releaseDriving(outcome.record.traceid, outcome.record.nodeId);
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

    this.#ledger.releaseDriving(record.traceid, record.nodeId);

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
    this.#ledger.releaseDriving(record.traceid, record.nodeId);
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
    if (this.#ledger.isDriving(traceid, nodeId)) return { kind: "idle" };

    const instance = this.#registry.get(traceid);
    const template = this.#registry.template(traceid);
    const node = template.nodes[nodeId];
    invariant(node !== undefined, `实例 ${traceid} 无节点 ${nodeId}`);
    const port = node.ports[input.target.port] as Port;

    /**
     * **全部校验做完，才动任何状态。**
     *
     * 此前顺序是「校验一半 → 置 CLAIMED、写 RUNNING 记录 → 再校验 → 拒绝」，
     * 而拒绝走的是**正常 return**，`transact` 只在 throw 时回滚 ——
     * 于是被拒的 claim 留下一条永久 RUNNING 记录：实例再也 settle 不了，
     * `checkInvariants` 当场判自己违规（RUNNING 记录引用了一条 FAILED 消息）。
     *
     * 我曾在这里写过"外层 transact 会一并撤销"，那句话是错的。
     * 与其修回滚，不如让**拒绝路径根本不产生要回滚的东西**。
     *
     * `#prepare` 是纯的，所以这个性质现在由**位置**保证：它排在下面那行
     * `// ↓ 以下才开始改状态` 之前，而它自己一个字节都不改。
     */
    const prepared = this.#prepare(input, node, port);
    if (!prepared.ok) {
      return { kind: "rejected", failure: this.#fail(input, prepared.reason) };
    }

    // ↓ 以下才开始改状态。到这里已经不会再拒绝了。
    const executionId = this.#ledger.nextId();
    /**
     * 在把**本次**记录写进账本之前取上游表。
     *
     * 写完再取，本次执行就会出现在自己的"上游"里 —— 于是
     * `workspace.from: <自己这个节点>` 会指向自己那个刚建好的空沙箱，
     * 而不是报错。用例第一次跑就抓到了这条。
     */
    const priorExecutions = this.#ledger.latestPerNode(traceid);
    this.#queue.setState(input.id, "CLAIMED");

    const record: ExecutionRecord = Object.freeze({
      executionId,
      traceid,
      nodeId,
      status: "RUNNING" as const,
      claimed: [input.id],
      generation: instance.generation,
    });
    this.#ledger.put(record);

    const limits: ExecutionLimits =
      node.budget === undefined ? {} : { tokenBudget: node.budget.tokens };
    const request: ExecutionRequest = {
      executionId,
      traceid,
      nodeId,
      agentSpec: node.agent ?? {},
      // 派生，不是记账 —— 见 ExecutionLedger.latestPerNode
      priorExecutions,
      vars: prepared.vars,
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
    this.#ledger.markDriving(traceid, nodeId);
    return { kind: "claimed", record, input: this.message(input.id), request };
  }

  #apply(
    record: ExecutionRecord,
    input: Message,
    result: ExecutionResult,
  ): StepResult | StepFailure {
    /**
     * **执行观测第一件事就落。**
     *
     * 我把它放在"#apply 开头"，注释也写着"失败时的观测比成功时更值钱" ——
     * 但 `termination !== "DONE"` 的提前 return 排在它**前面**，
     * 于是恰恰在最需要现场的时候没有记录：失败 agent 的沙箱留着，
     * 却没有 `$exec` 指向它 —— `status` 看不到、`reclaim` 找不到、
     * 退出码与 stderr 全丢，而 DEVELOPING 还教人"失败先看 show $exec"。
     *
     * 现在真的是第一件事。同一个事务，回滚时一起回滚。
     */
    this.#recordExecution(record, result);

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
      const m = this.#queue.has(id) ? this.#queue.get(id) : undefined;
      return m === undefined || m.state !== "CLAIMED";
    });
    if (stolen.length > 0) {
      this.#ledger.replace(record.executionId, { status: "VOIDED" });
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
      this.#ledger.replace(record.executionId, { status: "VOIDED" });
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
        derived_from: submission.derived_from,
      });
    }

    const delivered = this.#commitPlan(outcome.plan);
    this.#queue.setState(input.id, "CONSUMED");
    this.#ledger.put({
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
    this.#ledger.put({
      ...record,
      status: "SETTLED" as const,
      termination,
      ...(usage === undefined ? {} : { usage }),
    });

    if (NON_RETRYABLE.includes(termination)) {
      this.#terminateMessage(input, "DISCARDED", reason);
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
      this.#queue.replace(input.id, { state: "QUEUED", attempts, failure: reason });
      return {
        consumed: input.id,
        traceid: record.traceid,
        nodeId: record.nodeId,
        reason,
        termination,
        retrying: true,
      };
    }
    this.#terminateMessage(input, "FAILED", reason, attempts);
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

  /**
   * 本地事实束 —— 派生义务的唯一输入。
   *
   * 只读**本进程持有**的四样东西。远端的等待由 `#pending` 里那条本地记录表达，
   * 不去问对面还活着没 —— 这条纪律是给"每个容器都可以是一个租户"留的。
   */
  #facts(): ObligationFacts {
    const root = this.#registry.rootTrace;
    return {
      messages: this.messages(),
      executions: this.records(),
      requests: [...this.#pending.values()],
      instances: root === null ? [] : this.#registry.subtree(root),
    };
  }

  /** 未了结的义务。不给 trace 就是全表。 */
  obligations(trace?: TraceId): readonly Obligation[] {
    const facts = this.#facts();
    return trace === undefined ? outstanding(facts) : obligationsOf(facts, trace);
  }

  /**
   * 阻塞原因。**是义务枚举的投影**，不再是三段并列的数法。
   *
   * 旧写法里"在途消息 / 在途执行 / 持有的锁"各扫一遍，三处漏一处就是一类 bug；
   * 现在只有一处。文案逐字未变 —— 既有用例一条没改。
   */
  terminationBlockers(trace: TraceId): readonly string[] {
    return describeObligations(this.obligations(trace));
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
      // 置终态即销账：父的那份 child 义务是从这个 status 算出来的
      this.#registry.setStatus(trace, "TERMINAL");
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

    this.#signal(
      { traceid: parentTrace, node: exit.node, port: exit.port },
      { slot: child.slot, traceid: child.traceid, status: "TERMINAL" },
      child.traceid,
    );
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
      this.#ledger.put({
        ...rec,
        status: "SETTLED",
        termination: "CANCELLED",
      });
      /**
       * 驱动标记也要放掉。
       *
       * 此前这里只改记录不清标记，于是 `(实例, 节点)` 永远留在 driving 集里。
       * 今天不炸是因为实例已 TERMINAL、`#pickWork` 本来就跳过它 —— 但那是
       * **另一条规则替它兜住了**，不是这里对。而集合只增不减，长跑进程里
       * 每截断一次就多一条，属进程内无界增长。
       *
       * 抽 `ExecutionLedger` 时才看见：记录与标记本该同进同出，
       * 分散在两处写就会漏。
       */
      this.#ledger.releaseDriving(rec.traceid, rec.nodeId);
      void this.#backend?.cancel(rec.executionId).catch(() => undefined);
      cancelledExecutions += 1;
    }

    // 2. 未消费消息 → 丢弃，留计数
    let truncatedMessages = 0;
    for (const msg of this.messages()) {
      if (msg.target.traceid !== trace) continue;
      if (msg.state !== "QUEUED" && msg.state !== "CLAIMED") continue;
      this.#queue.setState(msg.id, "DISCARDED", `实例被截断：${reason}`);
      truncatedMessages += 1;
    }

    // 3 + 4. 请求的两侧，各自了结。**没有"释放锁"这一步了** ——
    //        义务是从 pending 与实例状态算出来的，改了源头就等于销了账。
    //        所以结果里也不再报"释放了几把锁"：那个数是把义务换个名字数一遍，
    //        而机制早已不存在。**删机制要连它的报表一起删**，否则留下的是错误的地图。

    // 3. 自己发出的请求：请求方死了，回复没人收 —— 直接销账
    for (const [requestId, req] of [...this.#pending]) {
      if (req.requester === trace) this.#pending.delete(requestId);
    }

    /**
     * 4. 自己承接的请求：**代服务方发一条了结通知**回请求方的 callback。
     *
     * 此前这里只反向释放了锁，`#pending` 一条不删 —— 于是两份拷贝分叉，
     * 而且 `pending` 跟着头全量落盘，每截断一个服务方就永久多一条
     * （普查在三处独立复现，见 `test/obligations.test.ts`）。
     *
     * 但光删 pending 不够：那样请求方**什么都收不到**，它已经消费掉自己的
     * 输入、发出了请求，然后永远没有下文 —— 静默放弃。所以了结要走
     * **正常回复路径**：请求方的 callback 端口照常收到一条消息，
     * handler 自己决定是重试、降级还是失败。
     *
     * 这与 `#notifyParent`（子进终态 → 往父投通知）是同一个形状：
     * **两种义务，两种了结通知**，此前只实现了一种。
     *
     * 载荷是协议级通知，不带内容 —— 与子实例终止通知同例。服务方将来可以在
     * 订阅声明里写一份自己的默认回复（那才是"服务方自己写"的完整形态），
     * 缺省则用这条。
     */
    for (const [requestId, req] of [...this.#pending]) {
      if (req.waitingOn !== trace) continue;
      this.#settleRequest(requestId, trace, reason);
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
      cancelledExecutions,
      cascaded,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * 挑下一条要跑的消息。
   *
   * **内核先筛，调度器只排序**：只有 `QUEUED`、目标实例 `OPEN`、节点种类对得上
   * 的消息才进候选集；调度器从候选里挑一个，或者不挑。挑完复核它确实是发出去
   * 的那批里的一个（`acceptedPick`）—— 于是一个写坏的调度器**造不出**
   * "跑一条不该跑的消息"，不是靠它自觉。
   */
  #pickWork(accept: (node: NodeDefinition) => boolean): Message | null {
    const eligible: Message[] = [];
    const candidates: Candidate[] = [];
    for (const msg of this.pending()) {
      const instance = this.#registry.get(msg.target.traceid);
      if (instance.status !== "OPEN") continue;
      const node = this.#registry.template(msg.target.traceid).nodes[msg.target.node];
      if (node === undefined || !accept(node)) continue;
      candidates.push({
        message: msg,
        traceid: msg.target.traceid,
        nodeId: msg.target.node,
        position: candidates.length,
      });
      eligible.push(msg);
    }
    if (candidates.length === 0) return null;
    const picked = acceptedPick(candidates, this.#scheduler(candidates));
    if (picked === null) return null;
    return eligible[picked.position] as Message;
  }

  /**
   * 入站三件事：**契约 → 提取 → 编上下文**。两条路径走同一处。
   *
   * 此前它在 `#commitSync` 与 `#claim` 里各写了一遍。同一批不变量守两遍，
   * 代价已经付过：三段式那边曾经是「校验一半 → 置 CLAIMED、写 RUNNING 记录
   * → 再校验 → 拒绝」，而拒绝走正常 return、`transact` 只在 throw 时回滚，
   * 于是被拒的 claim 留下一条永久 RUNNING 记录。修法是把编上下文提到 mutation
   * 之前 —— 而那个修法**只在一条路径上做过**。抽成一处，第二次就不会发生。
   *
   * **纯函数式：一个字节的状态都不改。** 这正是它能排在两条路径各自的
   * mutation 之前的原因，也是"拒绝路径根本不产生要回滚的东西"的落点。
   */
  #prepare(input: Message, node: NodeDefinition, port: Port): PrepareOutcome {
    const inboundIssue = this.#checkContract(port, input.payload);
    if (inboundIssue !== null) {
      return { ok: false, reason: `入站契约不符：${inboundIssue}` };
    }

    const extraction = extractPortVars(port, input.payload);
    if (!extraction.ok) {
      return {
        ok: false,
        reason: `变量提取失败：${formatExtractionFailures(extraction.failures)}`,
      };
    }

    /**
     * **同步路径也要编上下文。**
     *
     * 此前它只做 `extractPortVars` 就直接调 handler，于是两件事同时是假的：
     *
     *   1. B1 的运行期上界**对同步节点根本没查** —— 一个声明
     *      `max_tokens: 1` 的 `long` 变量收到几千 token 照样消费成功。
     *   2. §7.1 说"普通 handler 也能通过 bind 引入长变量"，
     *      而 handler 拿到的变量袋里**根本没有 bind 段** —— literal / card
     *      完全不可达。
     *
     * 走同一个 `compileContext`，两件事一起真。ref 解引用也随之对同步节点生效。
     */
    const compiled = compileContext(this.#store, node, extraction.vars);
    if (!compiled.ok) {
      return {
        ok: false,
        reason: `上下文编译失败：${formatContextFailures(compiled.failures)}`,
      };
    }

    return { ok: true, vars: compiled.vars, portVars: extraction.vars };
  }

  #commitSync(input: Message): StepResult | StepFailure {
    const { traceid, node: nodeId } = input.target;
    const instance = this.#registry.get(traceid);
    const template = this.#registry.template(traceid);
    const node = template.nodes[nodeId];
    invariant(node !== undefined, `实例 ${traceid} 无节点 ${nodeId}`);
    const port = node.ports[input.target.port];
    invariant(port !== undefined, `节点 ${nodeId} 无端口 ${input.target.port}`);

    const prepared = this.#prepare(input, node, port);
    if (!prepared.ok) return this.#fail(input, prepared.reason);

    invariant(node.handler !== undefined, `节点 ${nodeId} 声明了 agent 段，走三段式而非同步路径`);
    const fn = this.#handlers.get(node.handler);
    invariant(fn !== undefined, `未注册的内置 handler：${node.handler}`);
    const outputs = fn(prepared.vars, this.#handlerContext(traceid, nodeId, input));

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
    this.#queue.setState(input.id, "CONSUMED");
    this.#recordSnapshot(traceid, nodeId, [input.id], delivered, {});
    return {
      consumed: input.id,
      traceid,
      nodeId,
      delivered,
      dangling: outcome.plan.dangling,
      vars: prepared.portVars,
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
    return this.#ledger.orphans();
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
      { traceid: trace, node_id: nodeId, derived_from: [] },
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
      /**
       * 别名解析：只读**这个实例自己**的绑定表 + 本租户的实例存活状态。
       * 不扫全树、不看兄弟的定义 —— 那是隧道那条路才需要的，而它已经删了。
       */
      resolve: (alias: string) => {
        const root = this.#registry.rootTrace;
        return resolveAlias(
          this.#registry.get(traceid).bindings,
          root === null ? [] : this.#registry.subtree(root),
          alias,
        );
      },
      lookupRequest: (requestId: string) => this.#pending.get(requestId),
      nextRequestId: () => {
        this.#requestSeq += 1;
        return `req-${this.#requestSeq}`;
      },
    };
  }

  /** 一次性落地排期结果 —— 零部分提交的提交点。 */
  #commitPlan(plan: StagePlan): readonly string[] {
    for (const requestId of plan.resolved) this.#pending.delete(requestId);
    for (const req of plan.requests) this.#pending.set(req.requestId, req);
    return plan.messages.map((m) => this.#queue.enqueue(m));
  }

  #checkContract(port: Port, payload: Json): string | null {
    if (port.contract === undefined) return null;
    const schema = this.#store.resolve(port.contract).body as unknown as MessageContract;
    const issues = validateContract(schema, payload);
    return issues.length === 0 ? null : formatContractIssues(issues);
  }

  /**
   * 内核自己发的**信号** —— 唯一入口。
   *
   * 信号与数据流的分界早就是结构性的（见 `MessageSource` 的注释）：
   *
   *     {traceid, node, port}   某节点的 emit 端口发出   → 数据流，走边
   *     {traceid}               实例自身的生命周期通知   → 信号
   *
   * 但此前没有对应的动作 —— 两处信号各自手写 `source: { traceid }`，
   * 而"别忘了不写 node"只靠注释提醒。收成一处之后这条由**签名**保证：
   * 调用方给的是实例，写不出 node 来。
   *
   * 载荷一律是协议级通知，不带内容：内容在资产里，收信方自己去取
   * （C5，`#notifyParent` 那条注释里的"消息降级成通知"）。
   */
  #signal(target: Endpoint, payload: Json, from: TraceId): void {
    this.#queue.enqueue({ target, payload, source: { traceid: from } });
  }

  /**
   * 了结一条请求，并**告诉请求方**。
   *
   * 请求方已经消费掉自己的输入、发出了请求，然后在等回复。没有这一步，
   * 它就永远等下去：`#pending` 里那条记录是它的义务，而义务不空就不能终止。
   * 静默放弃比报错更难查 —— 两端各自都绿，中间没人走。
   *
   * 走的是**正常回复路径**：请求方的 callback 端口照常收到一条消息，
   * handler 自己决定重试、降级还是失败。
   */
  #settleRequest(requestId: string, service: TraceId, reason: string): void {
    const req = this.#pending.get(requestId);
    if (req === undefined) return;
    this.#pending.delete(requestId);
    if (!this.#registry.has(req.requester)) return;
    if (this.#registry.get(req.requester).status !== "OPEN") return;
    /**
     * 投**请求方自己声明的**那份载荷，不是内核自造的形状。
     *
     * 内核造过一个 `{status, service, reason}`，而 callback 端口的 servo 是
     * 照着回复的形状写的 —— 那条通知会在变量提取那一步被拒，消息进 FAILED，
     * 请求方的 handler 根本没被叫醒。**通知发了等于没发。**
     *
     * `source` 仍然是实例（没有 node）：确实没有节点跑过，这条是内核代投的。
     * 想知道"这是不是真回复"，看的是 source 与消息记录，不是往载荷里塞标记 ——
     * 那会让载荷时有时无一个字段，正是 servo 受不了的那种形状。
     */
    this.#signal(
      { traceid: req.requester, node: req.node, port: req.callbackPort },
      req.unavailable,
      service,
    );
  }

  /**
   * 把一条消息送进终态 —— **并了结它所服务的请求**。
   *
   * 这两件事必须绑在一起，因为它们是同一条不变量的两半：
   *
   *   **一条请求的义务，要么等到回复，要么等到服务它的那条消息死掉。**
   *
   * 此前消息进终态有三个出口（校验失败 → FAILED、不可重试 → DISCARDED、
   * 重试耗尽 → FAILED），**三个都只改消息状态**。于是服务方永久失败时，
   * 请求方什么都收不到，而且永远欠着一条 request 义务 —— 用例已经复现：
   * `expected [] to have a length of 1`、`expected ['request'] to not include 'request'`。
   *
   * 截断那条路早就修好了（代服务方发一条 UNAVAILABLE 通知），但**只修了截断**。
   * 收成一处，第二次不会发生。
   */
  #terminateMessage(
    input: Message,
    state: "FAILED" | "DISCARDED",
    reason: string,
    attempts?: number,
  ): void {
    if (attempts === undefined) this.#queue.setState(input.id, state, reason);
    else this.#queue.replace(input.id, { state, attempts, failure: reason });
    if (input.requestId !== undefined) {
      this.#settleRequest(input.requestId, input.target.traceid, reason);
    }
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
    this.#terminateMessage(input, "FAILED", reason);
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

export { fifo } from "./scheduling.js";
export type { Candidate, Scheduler } from "./scheduling.js";
