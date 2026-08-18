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
   * 受信 handler 直给；agent 拿不到 ctx，它走已声明的内核工具。
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

export type ExecutionStatus =
  | "RUNNING"
  | "APPLIED"
  | "VOIDED"
  | "CANCELLED"
  | "BUDGET"
  | "INVALID_OUTPUT"
  | "FAILED";

/** claim/execute/apply 的持久事实 —— 取消与崩溃接管的唯一依据。 */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly status: ExecutionStatus;
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

export interface RuntimeOptions {
  readonly backend?: ExecutionBackend;
  readonly maxAttempts?: number;
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
  #seq = 0;
  #requestSeq = 0;
  #executionSeq = 0;

  constructor(store: ObjectStore, registry: InstanceRegistry, options: RuntimeOptions = {}) {
    this.#store = store;
    this.#registry = registry;
    this.#backend = options.backend;
    this.#maxAttempts = options.maxAttempts ?? 3;
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

  registerHandler(name: string, fn: BuiltinHandler): void {
    if (this.#handlers.has(name)) {
      throw new InvariantError(`handler 已注册，不可覆盖：${name}`);
    }
    this.#handlers.set(name, fn);
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
    return transact(this.#parts, () => this.#commitSync(next));
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
  async stepAgent(): Promise<StepResult | StepFailure | null> {
    const claimed = this.#claim();
    // 入口校验失败不是"没活干" —— 必须把失败返回给调用方，否则 drainAgents
    // 会把它当空闲提前退出，后面合法的消息被滞留
    if (claimed.kind === "idle") return null;
    if (claimed.kind === "rejected") return claimed.failure;

    const { record, input, request } = claimed;
    const key = `${record.traceid}/${record.nodeId}`;

    try {
      const backend = this.#backend;
      invariant(backend !== undefined, "未配置 ExecutionBackend，agent 节点无法执行");

      let raw: unknown;
      try {
        raw = await backend.run(request);
      } catch (error) {
        // backend 抛异常 = FAILED 可重试
        return this.#applyFailure(record, input, "FAILED", String(error));
      }

      // backend 是不可信边界：形状、executionId、内核保留 kind 都要真校验
      const checked = checkBackendResult(record.executionId, raw);
      if (!checked.ok) {
        return this.#applyFailure(record, input, "INVALID_OUTPUT", checked.reason);
      }
      return transact(this.#parts, () => this.#apply(record, input, checked.result));
    } finally {
      this.#busy.delete(key);
    }
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

    this.#busy.add(key);
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

    // bind 段进请求（不变量 X 的稳定前缀）+ 运行期上界校验（B1 的运行期一半）
    const compiled = compileContext(this.#store, node, extraction.vars);
    if (!compiled.ok) {
      this.#busy.delete(key);
      this.#records.delete(executionId);
      this.#setState(input.id, "QUEUED");
      return {
        kind: "rejected",
        failure: this.#fail(input, `上下文编译失败：${formatContextFailures(compiled.failures)}`),
      };
    }

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
    return { kind: "claimed", record, input: this.message(input.id), request };
  }

  #apply(
    record: ExecutionRecord,
    input: Message,
    result: ExecutionResult,
  ): StepResult | StepFailure {
    // 冲突域复核：实例 generation 未变 且 被 claim 的消息仍是 CLAIMED
    const instance = this.#registry.get(record.traceid);
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

    const outcome = stageOutputs(
      this.#stageContext(template, node, record.traceid, record.nodeId, input, instance),
      result.emissions,
    );
    if (!outcome.ok) {
      return this.#applyFailure(record, input, "INVALID_OUTPUT", outcome.reason, result.usage);
    }

    // 产物与下游一起提交：先全部校验通过，再一次性落。
    // 边写边校验会在中途失败时留下部分版本 —— 违反零部分提交。
    for (const artifact of result.artifacts ?? []) {
      this.#store.put(artifact.object_id, artifact.kind, artifact.body, {
        traceid: record.traceid,
        node_id: record.nodeId,
        execution_id: record.executionId,
        at_seq: 0,
        derived_from: artifact.derived_from,
      });
    }

    const delivered = this.#commitPlan(outcome.plan);
    this.#setState(input.id, "CONSUMED");
    this.#records.set(record.executionId, {
      ...record,
      status: "APPLIED",
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
      status: termination === "DONE" ? "FAILED" : (termination as ExecutionStatus),
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

    this.#registry.setStatus(trace, "TERMINAL");
    // 子终态 → 父的 child 锁销账（L1 第 2 种的对偶）
    this.#ledger.releaseByKey("child", trace);
    return true;
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

  truncate(trace: TraceId, reason: string): TruncationResult {
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
      this.#records.set(rec.executionId, { ...rec, status: "CANCELLED" });
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
      this.truncate(child.traceid, `父容器 ${trace} 截断`);
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
    this.#store.put(
      `run/${trace}`,
      "run",
      { seq, node: nodeId, consumed: [...consumed], produced: [...produced], ...extra },
      { traceid: trace, node_id: nodeId, at_seq: seq, derived_from: [] },
    );
  }

  /** 某实例的全部提交快照，按 seq 升序。 */
  snapshots(trace: TraceId): readonly ObjectVersion[] {
    return this.#store.history(`run/${trace}`);
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
