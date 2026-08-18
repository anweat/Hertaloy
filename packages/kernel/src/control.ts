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
}
