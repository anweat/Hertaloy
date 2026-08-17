/**
 * RuntimeLike —— Runtime 的结构化接口。
 * 各模块函数（definitions/budget/scheduling/...）以它为第一参数，
 * 与 Python V4 的 mixin 组合等价（模块级职责划分）。
 */
import type { ExecutionBackend, InvocationContext, KernelState, ObjectStore, ObjectVersion, Principal } from "./core.js";
import type { InstanceState } from "./core.js";

export interface RuntimeLike {
  st: KernelState;
  store: ObjectStore;

  // ---- 跨模块共享助手（runtime.ts 实现） ----
  nid(prefix: string): string;
  bumpIdCounter(): void;
  /** 内部写入口 —— 一律经 store，绝不自行分配版本号（projections._append_object）。 */
  appendObject(
    oid: string,
    body: Record<string, unknown>,
    opts?: { kind?: string; provenance?: { graph_instance_id?: string | null; node_id?: string | null; execution_id?: string | null; at_seq: number; derived_from?: string[] } }
  ): ObjectVersion;
  /** 无 RunSnapshot 的状态变更（claim/release/订阅增删）也要落盘。 */
  notifyChange(): void;
  authorize(inst: InstanceState, actor: Principal | string): Principal;
  newMessage(
    target: [string, string, string],
    payload: unknown,
    opts?: { callback?: [string, string, string] | null; topic?: string | null; mkind?: "DATA" | "REPLY"; exitPort?: string | null; requestId?: string | null }
  ): string;
  /** publish 的锁内实现；内核工具桥需要拿到全部投递出的 message id。 */
  publishLocked(topicId: string, payload: unknown, opts?: { callback?: [string, string, string] | null; requestId?: string | null }): string[];
  /** 子容器实例化（PER_CALL / WARM_POOL(n) / SINGLETON + overflow）。 */
  spawnChild(inst: InstanceState, slotId: string, slot: Record<string, unknown>): string;
  /** 该实例是否仍有未完成的工作（WARM_POOL 复用前的隔离检查）。 */
  instanceBusy(gid: string): boolean;
  contract(ref: string | null): Record<string, unknown> | null;

  // ---- 配置（与 Python Runtime 常量一致） ----
  maxOutputRetries: number;
  defaultMaxFanout: number;
  defaultMaxAttempts: number;
  charsPerToken: number;
  cjkCharsPerToken: number;
  truncationOrder: Array<"transient" | "tail" | "messages">;
  minKeep: Partial<Record<"transient" | "tail" | "messages", number>>;

  // ---- 持久化挂载点 ----
  onCommit: ((rt: RuntimeLike, ov: ObjectVersion) => void) | null;
  onChange: ((rt: RuntimeLike) => void) | null;
}

export { InvocationContext };
