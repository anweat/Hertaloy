/**
 * 控制面 —— **可信边界**（FOUNDATION_V5.md §11）。
 *
 * 权限检查放在这一层，不穿进内核签名。理由有三：
 *
 *   1. §11.3 要求 `Principal` **必须由可信边界注入** —— 那个边界就是这里，
 *      注入一次即可，不必让每个内核方法都多一个参数。
 *   2. Runtime 保持**纯引擎**：它不知道谁在调它，也就不可能被"payload 里
 *      自称的 actor"骗到。
 *   3. 权限是数据（授权表），换策略不用改内核。
 *
 * 操作按 DDL / DML / DQL 分类，`scope` 复用同一套段边界前缀判定。
 */

import {
  type Endpoint,
  type Json,
  type OpClass,
  type PermissionTable,
  type Principal,
  type ObjectVersion,
  type Ref,
  type TraceId,
} from "@nodeflow/contracts";
import { AuthorizationError } from "./errors.js";
import { type ContainerInstance, InstanceRegistry, registerContainerTemplate } from "./instances.js";
import type { ObjectStore } from "./store.js";
import type { Lock } from "./locks.js";
import type {
  ExecutionRecord,
  Message,
  Runtime,
  StepFailure,
  StepResult,
  TruncationResult,
} from "./runtime.js";

/** 操作 → 类别的映射表。**这张表就是分层本身**，不散在各处 if 里。 */
export const OPERATION_CLASS = {
  define: "DDL",
  send: "DML",
  run: "DML",
  spawn: "DML",
  truncate: "DML",
  settle: "DML",
  query: "DQL",
} as const satisfies Record<string, OpClass>;

export type Operation = keyof typeof OPERATION_CLASS;

export class ControlPlane {
  readonly #runtime: Runtime;
  readonly #registry: InstanceRegistry;
  readonly #store: ObjectStore;
  readonly #permissions: PermissionTable;

  constructor(
    runtime: Runtime,
    registry: InstanceRegistry,
    store: ObjectStore,
    permissions: PermissionTable,
  ) {
    this.#runtime = runtime;
    this.#registry = registry;
    this.#store = store;
    this.#permissions = permissions;
  }

  /**
   * 授权检查。**默认拒绝**；拒绝时抛 `AuthorizationError` 并说清缺什么。
   *
   * `actor` 由调用方（服务端 session / MCP 环境变量）注入 ——
   * 绝不从 payload 或 arguments 里取。
   */
  #authorize(actor: Principal, op: Operation, target: string): void {
    const decision = this.#permissions.decide(actor, OPERATION_CLASS[op], target);
    if (!decision.allowed) throw new AuthorizationError(decision.reason);
  }

  // --- DDL ---------------------------------------------------------------

  /** 注册容器定义或覆盖层。scope 按**定义路径前缀**判定（对象级 GRANT）。 */
  define(actor: Principal, templateId: string, spec: unknown, kind?: string): Ref {
    this.#authorize(actor, "define", templateId);
    return registerContainerTemplate(this.#store, templateId, spec, kind);
  }

  // --- DML ---------------------------------------------------------------

  /** scope 按 **traceid 前缀**判定（行级安全）。 */
  send(actor: Principal, target: Endpoint, payload: Json): string {
    this.#authorize(actor, "send", target.traceid);
    return this.#runtime.send(target, payload);
  }

  spawn(actor: Principal, parent: TraceId, slot: string, segment: string): ContainerInstance {
    this.#authorize(actor, "spawn", parent);
    return this.#runtime.spawn(parent, slot, segment);
  }

  /** 同步驱动。授权按根实例判定 —— 驱动会跨整棵树。 */
  run(actor: Principal, scope: TraceId): readonly (StepResult | StepFailure)[] {
    this.#authorize(actor, "run", scope);
    return this.#runtime.drain();
  }

  /**
   * 驱动 **agent 节点**（异步）。
   *
   * 与 `run` 分成两条而不是合成一条：`run` 是同步的纯引擎推进，
   * `runAgents` 里面有 `await`，中间会跑外部进程、花钱、产生副作用。
   * 合成一条就得让所有调用方都变成 async，也会掩盖"这一步要花钱"这件事。
   */
  async runAgents(actor: Principal, scope: TraceId): Promise<readonly (StepResult | StepFailure)[]> {
    this.#authorize(actor, "run", scope);
    return await this.#runtime.drainAgents();
  }

  truncate(actor: Principal, trace: TraceId, reason: string): TruncationResult {
    this.#authorize(actor, "truncate", trace);
    return this.#runtime.truncate(trace, reason);
  }

  settle(actor: Principal, trace: TraceId): boolean {
    this.#authorize(actor, "settle", trace);
    return this.#runtime.settle(trace);
  }

  // --- DQL ---------------------------------------------------------------

  subtree(actor: Principal, trace: TraceId): readonly ContainerInstance[] {
    this.#authorize(actor, "query", trace);
    return this.#registry.subtree(trace);
  }

  locks(actor: Principal, trace: TraceId): readonly Lock[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.locks.held(trace);
  }

  blockers(actor: Principal, trace: TraceId): readonly string[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.terminationBlockers(trace);
  }

  messages(actor: Principal, trace: TraceId): readonly Message[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.messages().filter((m) => m.target.traceid === trace);
  }

  records(actor: Principal, trace: TraceId): readonly ExecutionRecord[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.records().filter((r) => r.traceid === trace);
  }

  /**
   * 读一个对象版本。
   *
   * DQL 此前只覆盖了实例侧（子树 / 锁 / 消息 / 记录），**对象侧是空的** ——
   * 而 C5 之后"东西经历了什么"全在版本历史里，不给读法等于把主要的可观测面
   * 关在门外。target 用 object_id：它本来就是 traceid 命名空间，
   * 同一套段边界前缀判定直接通吃（行级安全覆盖到对象）。
   */
  read(actor: Principal, ref: Ref): ObjectVersion {
    this.#authorize(actor, "query", objectIdOf(ref));
    return this.#store.resolve(ref);
  }

  head(actor: Principal, objectId: string): ObjectVersion {
    this.#authorize(actor, "query", objectId);
    return this.#store.head(objectId);
  }

  history(actor: Principal, objectId: string): readonly ObjectVersion[] {
    this.#authorize(actor, "query", objectId);
    return this.#store.history(objectId);
  }

  /**
   * 因果查询：这条消息是由哪些消息导致的。
   *
   * RunSnapshot 存在的全部理由就是承担 traceid 表达不了的那半边因果 ——
   * 扇出后子消息 traceid 相同却各有前因，汇聚时一条输出有多个前因。
   * 查询早就实现了，只是一直没有出口，等于把主要的可观测面关在门外。
   */
  causesOf(actor: Principal, scope: TraceId, messageId: string): readonly string[] {
    this.#authorize(actor, "query", scope);
    return this.#runtime.causesOf(messageId);
  }

  /** 认领孤儿执行。见 `Runtime.reconcile` —— 复用失败路径，不是新状态机。 */
  reconcile(actor: Principal, scope: TraceId): readonly StepFailure[] {
    this.#authorize(actor, "run", scope);
    return this.#runtime.reconcile();
  }

  /** 把够条件的实例收进终态。授权按传入的作用域根判定。 */
  settleAll(actor: Principal, scope: TraceId): readonly TraceId[] {
    this.#authorize(actor, "settle", scope);
    return this.#runtime.settleAll();
  }
}

/** `id@3` → `id`。授权按对象身份判定，与具体第几版无关。 */
function objectIdOf(ref: Ref): string {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}
