/**
 * 内网单提交路径 —— `handler emit → forward edge → handler receive`。
 *
 * 对应 FOUNDATION_V5.md §8：
 *   M1 编排权威属于内网边 —— handler 返回 `{端口: 载荷}`，**永远不指定目标**；
 *      由哪条边接走完全由模板决定。消息不选边、不创建边。这是结构性的：
 *      handler 的返回类型里根本没有目标字段。
 *   S1/S2 servo 纯提取，控制流只在策略节点。
 *
 * **零部分提交**：契约校验或变量提取失败时，输入消息进 FAILED，
 * 一条下游消息都不创建。下游先在局部数组里攒齐，最后一次性提交。
 *
 * 本文件只做单提交同步路径。claim/execute/apply 三段式与 generation fence 属 Task 5。
 */

import {
  type Endpoint,
  type Json,
  type MessageContract,
  type Port,
  type TraceId,
  allowedEmitPorts,
  formatContractIssues,
  validateContract,
} from "@nodeflow/contracts";
import { InvariantError, invariant } from "./errors.js";
import { type VarBag, extractPortVars, formatExtractionFailures } from "./extract.js";
import { InstanceRegistry } from "./instances.js";
import { ObjectStore } from "./store.js";

export type MessageState = "QUEUED" | "CONSUMED" | "FAILED";

export interface Message {
  readonly id: string;
  readonly target: Endpoint;
  readonly payload: Json;
  readonly state: MessageState;
  readonly failure?: string;
}

export interface HandlerContext {
  readonly traceid: TraceId;
  readonly nodeId: string;
}

/**
 * 内置 handler：拿变量，返回**每个 emit 端口**的载荷。
 * 返回值的键是端口名，不是目标地址 —— 第一不变量与 M1 的落点。
 */
export type BuiltinHandler = (
  vars: VarBag,
  ctx: HandlerContext,
) => Readonly<Record<string, Json>>;

export interface StepResult {
  readonly consumed: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  /** 本次提交创建的下游消息 id。 */
  readonly delivered: readonly string[];
  /** 有输出但没有出边接走的端口 —— 观测用，不是错误。 */
  readonly dangling: readonly string[];
  readonly vars: VarBag;
}

export interface StepFailure {
  readonly consumed: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly reason: string;
}

export class Runtime {
  readonly #store: ObjectStore;
  readonly #registry: InstanceRegistry;
  readonly #handlers = new Map<string, BuiltinHandler>();
  readonly #messages = new Map<string, Message>();
  readonly #order: string[] = [];
  #seq = 0;

  constructor(store: ObjectStore, registry: InstanceRegistry) {
    this.#store = store;
    this.#registry = registry;
  }

  registerHandler(name: string, fn: BuiltinHandler): void {
    if (this.#handlers.has(name)) {
      throw new InvariantError(`handler 已注册，不可覆盖：${name}`);
    }
    this.#handlers.set(name, fn);
  }

  /** 入站。目标端点在入口就校验，不拖到调度时才报 KeyError。 */
  send(target: Endpoint, payload: Json): string {
    const port = this.#resolvePort(target, "send");
    invariant(
      port.direction === "receive",
      `端口 ${target.node}.${target.port} 方向是 emit，不能作为投递目标`,
    );
    return this.#enqueue(target, payload);
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

  /** 取最早的一条 QUEUED 消息跑一步。无活可干返回 null。 */
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

  #commit(input: Message): StepResult | StepFailure {
    const { traceid, node: nodeId } = input.target;
    const instance = this.#registry.get(traceid);
    invariant(instance.status === "OPEN", `实例 ${traceid} 已 ${instance.status}，不接受新工作`);

    const template = this.#registry.template(traceid);
    const node = template.nodes[nodeId];
    invariant(node !== undefined, `实例 ${traceid} 无节点 ${nodeId}`);
    const port = node.ports[input.target.port];
    invariant(port !== undefined, `节点 ${nodeId} 无端口 ${input.target.port}`);

    // 1. 入站契约（运行期取值校验）
    const inboundIssue = this.#checkContract(port, input.payload);
    if (inboundIssue !== null) {
      return this.#fail(input, `入站契约不符：${inboundIssue}`);
    }

    // 2. servo 提取 —— 全有或全无
    const extraction = extractPortVars(port, input.payload);
    if (!extraction.ok) {
      return this.#fail(input, `变量提取失败：${formatExtractionFailures(extraction.failures)}`);
    }

    // 3. 执行
    invariant(node.kind === "handler", `节点 ${nodeId} 不是 handler（策略节点属后续 Task）`);
    invariant(
      node.handler !== undefined,
      `节点 ${nodeId} 声明了 agent 段，需要执行面 backend（属后续 Task）`,
    );
    const fn = this.#handlers.get(node.handler);
    invariant(fn !== undefined, `未注册的内置 handler：${node.handler}`);
    const outputs = fn(extraction.vars, { traceid, nodeId });

    // 4. 输出端口必须是声明过的 emit 端口 —— 第一不变量
    const allowed = new Set(allowedEmitPorts(node.ports));
    for (const portName of Object.keys(outputs)) {
      if (!allowed.has(portName)) {
        throw new InvariantError(
          `节点 ${nodeId} 输出到未声明的 emit 端口 \`${portName}\`。` +
            `可用端口：${[...allowed].sort().join(", ") || "（无）"}`,
        );
      }
    }

    // 5. 出站契约 —— 仍在提交前，失败则零下游
    for (const [portName, value] of Object.entries(outputs)) {
      const issue = this.#checkContract(node.ports[portName] as Port, value);
      if (issue !== null) {
        return this.#fail(input, `端口 \`${portName}\` 出站契约不符：${issue}`);
      }
    }

    // 6. 按边路由。攒在局部数组，最后一次性提交（零部分提交）
    const staged: { target: Endpoint; payload: Json }[] = [];
    const dangling: string[] = [];
    for (const [portName, value] of Object.entries(outputs)) {
      const edges = Object.values(template.edges).filter(
        (e) => e.from.node === nodeId && e.from.port === portName,
      );
      if (edges.length === 0) {
        dangling.push(portName);
        continue;
      }
      for (const edge of edges) {
        // 每条边独立一份 payload 副本：兄弟分支互不污染
        staged.push({
          target: { traceid, node: edge.to.node, port: edge.to.port },
          payload: structuredClone(value) as Json,
        });
      }
    }

    // 7. 提交
    const delivered = staged.map((s) => this.#enqueue(s.target, s.payload));
    this.#setState(input.id, "CONSUMED");
    return {
      consumed: input.id,
      traceid,
      nodeId,
      delivered,
      dangling: dangling.sort(),
      vars: extraction.vars,
    };
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

  #enqueue(target: Endpoint, payload: Json): string {
    this.#seq += 1;
    const id = `msg-${this.#seq}`;
    this.#messages.set(id, Object.freeze({ id, target, payload, state: "QUEUED" as const }));
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
