/**
 * 内网转发 + 网关 + 锁账本 + 强制截断。
 *
 * 对应 FOUNDATION_V5.md §8 / §9：
 *   M1 编排权威属于内网边 —— handler 返回 `{端口: 载荷}`，**永远不指定目标**。
 *      走内网还是走网关，由**端口的声明**决定，不由 handler 选。
 *   M2 寻址 = 隧道标签 ∩ traceid 前缀
 *   M3 callback 落回已声明端点
 *   L1/L2 锁只在网关穿越时产生；owner 唯一是容器
 *   L3 截断靠 generation fence，`cancel` 只是 best effort
 *   L5 可终止 ⟺ 无非终态消息 ∧ 无活跃 execution ∧ 锁表空
 *
 * **零部分提交**：契约或提取失败时输入进 FAILED，一条下游都不创建。
 * **订阅不物化为实例对象**：订阅在模板里声明，实例终身 pin 模板（C4），
 * 所以"当前有哪些订阅"是**派生**的 —— 按需扫一遍 OPEN 实例即可，
 * 不需要独立的订阅表，也就没有退订簿记和幽灵订阅。
 * 运行期动态订阅属"容器工具编辑内网"，等那时再物化。
 *
 * claim/execute/apply 三段式属 Task 5，本文件仍是同步单提交。
 */

import {
  type Endpoint,
  type Json,
  type MessageContract,
  type Port,
  type TraceId,
  type Tunnel,
  allowedEmitPorts,
  formatContractIssues,
  isDescendantOf,
  validateContract,
} from "@nodeflow/contracts";
import { InvariantError, invariant } from "./errors.js";
import { type VarBag, extractPortVars, formatExtractionFailures } from "./extract.js";
import { type ContainerInstance, InstanceRegistry } from "./instances.js";
import { type Lock, LockLedger } from "./locks.js";
import { ObjectStore } from "./store.js";

export type MessageState = "QUEUED" | "CONSUMED" | "FAILED" | "DISCARDED";

export interface Message {
  readonly id: string;
  readonly target: Endpoint;
  readonly payload: Json;
  readonly state: MessageState;
  readonly failure?: string;
  /** 经隧道投递时携带。内网边传递时不带。 */
  readonly tunnel?: Tunnel;
  /** 协议级关联，**绝不进 payload**。 */
  readonly requestId?: string;
  readonly inReplyTo?: string;
}

export interface HandlerContext {
  readonly traceid: TraceId;
  readonly nodeId: string;
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
  /** 有输出但没有出边／没有订阅者接走的端口 —— 观测用，不是错误。 */
  readonly dangling: readonly string[];
  readonly vars: VarBag;
}

export interface StepFailure {
  readonly consumed: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly reason: string;
}

export interface TruncationResult {
  readonly traceid: TraceId;
  readonly reason: string;
  readonly generation: number;
  readonly truncatedMessages: number;
  readonly releasedLocks: number;
  readonly cascaded: readonly TraceId[];
}

interface PendingRequest {
  readonly requestId: string;
  readonly requester: TraceId;
  readonly node: string;
  readonly callbackPort: string;
  readonly lockId: string;
  /** 发起时的实例 generation —— 迟到回复据此判废（L3）。 */
  readonly generation: number;
}

export class Runtime {
  readonly #store: ObjectStore;
  readonly #registry: InstanceRegistry;
  readonly #ledger = new LockLedger();
  readonly #handlers = new Map<string, BuiltinHandler>();
  readonly #messages = new Map<string, Message>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #order: string[] = [];
  #seq = 0;
  #requestSeq = 0;

  constructor(store: ObjectStore, registry: InstanceRegistry) {
    this.#store = store;
    this.#registry = registry;
  }

  get locks(): LockLedger {
    return this.#ledger;
  }

  registerHandler(name: string, fn: BuiltinHandler): void {
    if (this.#handlers.has(name)) {
      throw new InvariantError(`handler 已注册，不可覆盖：${name}`);
    }
    this.#handlers.set(name, fn);
  }

  /** 创建子容器，并对父容器记一把 `child` 锁（L1 第 2 种）。 */
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

  step(): StepResult | StepFailure | null {
    const next = this.pending()[0];
    if (next === undefined) return null;
    return this.#commit(next);
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
  // 终止（L5）
  // -------------------------------------------------------------------------

  /**
   * 挡住自然终止的东西。三个谓词：
   *   1. 无非终态消息（内网本地扫描）
   *   2. 无活跃 execution（内网本地扫描；三段式属 Task 5，此刻恒空）
   *   3. 锁表为空（网关账本）
   *
   * 返回的是人话，直接给画布那块"正在阻止关闭"的面板用。
   */
  terminationBlockers(trace: TraceId): readonly string[] {
    const blockers: string[] = [];
    const queued = this.pending().filter((m) => m.target.traceid === trace);
    if (queued.length > 0) {
      blockers.push(`${queued.length} 条待处理消息`);
    }
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
   * 强制截断 —— **永远可用、永远成功**（§9.1）。
   *
   * 正因为它永远可用，锁才只承担"回收提示 + 展示"，不承担正确性：
   * 锁记错了只会导致本该自动回收的没自动回收，最后被人或超时清掉。
   */
  truncate(trace: TraceId, reason: string): TruncationResult {
    const instance = this.#registry.get(trace);
    if (instance.status === "TERMINAL") {
      return {
        traceid: trace,
        reason,
        generation: instance.generation,
        truncatedMessages: 0,
        releasedLocks: 0,
        cascaded: [],
      };
    }

    // 0. 推进栅栏 —— 气密性的唯一依据
    const bumped = this.#registry.bumpGeneration(trace);

    // 1. 取消在途 execution：三段式属 Task 5，此处无

    // 2. 未消费消息 → 丢弃，留计数（不留记录则消息凭空消失，无法调试）
    let truncatedMessages = 0;
    for (const msg of this.pending()) {
      if (msg.target.traceid !== trace) continue;
      this.#setState(msg.id, "DISCARDED", `实例被截断：${reason}`);
      truncatedMessages += 1;
    }

    // 3 + 4. 自己持有的锁作废；自己在别处造成的锁**反向释放**
    //        漏了第 4 步，父容器会永远等一个已死的子
    const own = this.#ledger.held(trace);
    const caused = this.#ledger.causedBy(trace);
    for (const lock of [...own, ...caused]) this.#ledger.release(lock.id);
    for (const [requestId, req] of [...this.#pending]) {
      if (req.requester === trace) this.#pending.delete(requestId);
    }

    // 5. 子实例级联（on_close 固定级联，不给选项）
    const cascaded: TraceId[] = [];
    for (const child of this.#registry.children(trace)) {
      if (child.status === "TERMINAL") continue;
      cascaded.push(child.traceid);
      this.truncate(child.traceid, `父容器 ${trace} 截断`);
    }

    // 6. 终态记录
    this.#registry.setStatus(trace, "TERMINAL");

    return {
      traceid: trace,
      reason,
      generation: bumped.generation,
      truncatedMessages,
      releasedLocks: own.length + caused.length,
      cascaded,
    };
  }

  // -------------------------------------------------------------------------

  #commit(input: Message): StepResult | StepFailure {
    const { traceid, node: nodeId } = input.target;
    const instance = this.#registry.get(traceid);
    invariant(instance.status === "OPEN", `实例 ${traceid} 已 ${instance.status}，不接受新工作`);

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

    invariant(node.kind === "handler", `节点 ${nodeId} 不是 handler（策略节点属后续 Task）`);
    invariant(
      node.handler !== undefined,
      `节点 ${nodeId} 声明了 agent 段，需要执行面 backend（属后续 Task）`,
    );
    const fn = this.#handlers.get(node.handler);
    invariant(fn !== undefined, `未注册的内置 handler：${node.handler}`);
    const outputs = fn(extraction.vars, { traceid, nodeId });

    // 输出端口必须是声明过的 emit 端口 —— 第一不变量
    const allowed = new Set(allowedEmitPorts(node.ports));
    for (const portName of Object.keys(outputs)) {
      if (!allowed.has(portName)) {
        throw new InvariantError(
          `节点 ${nodeId} 输出到未声明的 emit 端口 \`${portName}\`。` +
            `可用端口：${[...allowed].sort().join(", ") || "（无）"}`,
        );
      }
    }

    for (const [portName, value] of Object.entries(outputs)) {
      const issue = this.#checkContract(node.ports[portName] as Port, value);
      if (issue !== null) {
        return this.#fail(input, `端口 \`${portName}\` 出站契约不符：${issue}`);
      }
    }

    // 攒在局部数组，最后一次性提交（零部分提交）
    const staged: Omit<Message, "id" | "state">[] = [];
    const stagedLocks: Parameters<LockLedger["acquire"]>[0][] = [];
    const stagedRequests: PendingRequest[] = [];
    const dangling: string[] = [];

    for (const [portName, value] of Object.entries(outputs)) {
      const emitPort = node.ports[portName] as Port;
      invariant(emitPort.direction === "emit", `端口 ${portName} 不是 emit`);

      if (emitPort.reply === true) {
        const outcome = this.#stageReply(input, value, staged);
        if (outcome !== null) return this.#fail(input, outcome);
        continue;
      }

      if (emitPort.tunnel !== undefined) {
        const targets = this.#subscribers(emitPort.tunnel, traceid);
        if (emitPort.callback === undefined) {
          // PUBLISH：0..N 订阅者，不记锁
          if (targets.length === 0) dangling.push(portName);
          for (const target of targets) {
            staged.push({
              target,
              payload: structuredClone(value) as Json,
              tunnel: emitPort.tunnel,
            });
          }
          continue;
        }
        // REQUEST：恰好 1 个订阅者
        if (targets.length !== 1) {
          return this.#fail(
            input,
            `隧道 \`${emitPort.tunnel}\` 的 REQUEST 要求恰好 1 个订阅者，实际 ${targets.length} 个`,
          );
        }
        this.#requestSeq += 1;
        const requestId = `req-${this.#requestSeq}`;
        stagedLocks.push({
          holder: traceid,
          kind: "request",
          key: requestId,
          originNode: nodeId,
        });
        stagedRequests.push({
          requestId,
          requester: traceid,
          node: nodeId,
          callbackPort: emitPort.callback,
          lockId: "",
          generation: instance.generation,
        });
        staged.push({
          target: targets[0] as Endpoint,
          payload: structuredClone(value) as Json,
          tunnel: emitPort.tunnel,
          requestId,
        });
        continue;
      }

      // 内网边
      const edges = Object.values(template.edges).filter(
        (e) => e.from.node === nodeId && e.from.port === portName,
      );
      if (edges.length === 0) {
        dangling.push(portName);
        continue;
      }
      for (const edge of edges) {
        staged.push({
          target: { traceid, node: edge.to.node, port: edge.to.port },
          payload: structuredClone(value) as Json,
        });
      }
    }

    // 提交
    for (const spec of stagedLocks) this.#ledger.acquire(spec);
    for (const req of stagedRequests) this.#pending.set(req.requestId, req);
    const delivered = staged.map((s) => this.#enqueue(s));
    this.#setState(input.id, "CONSUMED");

    // 本次消费的是 REQUEST 且已回复 → 该请求的锁已在 #stageReply 里销账
    return {
      consumed: input.id,
      traceid,
      nodeId,
      delivered,
      dangling: dangling.sort(),
      vars: extraction.vars,
    };
  }

  /** 返回 null 表示成功排期；返回字符串表示失败原因。 */
  #stageReply(
    input: Message,
    value: Json,
    staged: Omit<Message, "id" | "state">[],
  ): string | null {
    if (input.requestId === undefined) {
      return "本次消息不是 REQUEST，无法从 `reply` 端口回复";
    }
    const req = this.#pending.get(input.requestId);
    if (req === undefined) {
      return `请求 ${input.requestId} 已回复或已作废，拒绝重复回复`;
    }

    // 迟到回复不复活实例（L3）：请求方已截断 / generation 变了 → 丢弃留痕
    const requester = this.#registry.get(req.requester);
    if (requester.status !== "OPEN" || requester.generation !== req.generation) {
      this.#pending.delete(input.requestId);
      this.#ledger.releaseByKey("request", input.requestId);
      return `请求方 ${req.requester} 已截断（generation ${req.generation} → ${requester.generation}），回复丢弃`;
    }

    this.#pending.delete(input.requestId);
    this.#ledger.releaseByKey("request", input.requestId);
    staged.push({
      target: { traceid: req.requester, node: req.node, port: req.callbackPort },
      payload: structuredClone(value) as Json,
      inReplyTo: input.id,
    });
    return null;
  }

  /**
   * 匹配订阅者 = 隧道标签相等 ∩ 发送方落在订阅声明的 traceid 作用域内（M2）。
   *
   * 派生自模板，不查独立订阅表 —— 所以不会有幽灵订阅。
   */
  #subscribers(tunnel: Tunnel, sender: TraceId): readonly Endpoint[] {
    const out: Endpoint[] = [];
    for (const instance of this.#registry.subtree(this.#registry.rootTrace as TraceId)) {
      if (instance.status !== "OPEN") continue;
      const template = this.#registry.template(instance.traceid);
      for (const sub of Object.values(template.subscriptions)) {
        if (sub.tunnel !== tunnel) continue;
        if (sub.scope !== undefined && !isDescendantOf(sender, sub.scope)) continue;
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
    this.#setState(input.id, "FAILED", reason);
    return {
      consumed: input.id,
      traceid: input.target.traceid,
      nodeId: input.target.node,
      reason,
    };
  }

  #enqueue(spec: Omit<Message, "id" | "state">): string {
    this.#seq += 1;
    const id = `msg-${this.#seq}`;
    this.#messages.set(id, Object.freeze({ ...spec, id, state: "QUEUED" as const }));
    this.#order.push(id);
    return id;
  }

  #setState(id: string, state: MessageState, failure?: string): void {
    const current = this.message(id);
    this.#messages.set(
      id,
      Object.freeze(failure === undefined ? { ...current, state } : { ...current, state, failure }),
    );
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

export type { Lock };
