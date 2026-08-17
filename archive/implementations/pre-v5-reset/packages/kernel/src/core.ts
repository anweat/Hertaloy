/**
 * Nodeflow V5 —— 内核核心类型（对 Python nodeflow_core.py 的 TS 移植）
 *
 * Principal / ObjectStore / InvocationContext / ExecutionRequest/Result /
 * 内部状态结构 / 错误分类。不含任何调度行为。
 *
 * 约定（与 V4 完全一致）：
 *   - endpoint 地址 = (graph_instance_id, node_id, endpoint_name)
 *   - 队列地址 = topic_id —— 与图拓扑正交（不变量 M2）
 *   - 版本号只由 ObjectStore 分配（V1）；内容寻址幂等（V3）
 *   - 运行引用只接受精确版本 object_id@version（V4）
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@nodeflow/contracts";

// ---------------------------------------------------------------------------
// 执行面契约（FOUNDATION_V4 §4.2，与 contracts 同构；内核自持一份运行时类型）
// ---------------------------------------------------------------------------

export type Termination = "DONE" | "CANCELLED" | "BUDGET" | "INVALID_OUTPUT" | "FAILED";

export interface InvocationContext {
  head: string[];
  messages: unknown[];
  tail: string[];
  transient: unknown[];
  /** 与 messages 对齐的受保护信封元数据（request_id/topic/mkind），不进 payload。 */
  meta: Record<string, unknown>[];
}

export interface WorkspaceScope {
  root: string;
}

export interface OutputContract {
  schema: Record<string, unknown>;
  allowedEmitPorts: string[];
}

export interface ExecutionLimits {
  tokenBudget?: number | null;
  wallClockSeconds?: number | null;
  maxToolCalls?: number | null;
}

export interface ExecutionRequest {
  executionId: string;
  agentSpec: Record<string, unknown>;
  context: InvocationContext;
  origin: [string, string]; // (graph_instance_id, node_id)
  workspace: WorkspaceScope;
  outputContract: OutputContract;
  limits: ExecutionLimits;
  resumeHandle?: unknown;
}

export interface Usage {
  inTokens: number;
  outTokens: number;
  cost: number;
  wallClockSeconds: number;
  toolCalls: number;
  /** 非零 = 图切分错误的告警信号 */
  compactions: number;
}

export interface ExecutionResult {
  executionId: string;
  emissions: Array<[string, unknown]>; // (port, payload)
  artifacts: Array<[string, string, Record<string, unknown>]>; // (kind, objectId, body) —— backend 只提交内容（V1）
  usage: Usage;
  termination: Termination;
  sessionHandle?: unknown;
  observations: Array<Record<string, unknown>>;
  diagnostics: Record<string, unknown>;
}

export interface ExecutionBackend {
  run(request: ExecutionRequest): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
}

export class MockExecutionBackend implements ExecutionBackend {
  seen: ExecutionRequest[] = [];
  private handlers = new Map<string, (req: ExecutionRequest) => ExecutionResult>();
  cancelled = new Set<string>();

  on(specId: string, handler: (req: ExecutionRequest) => ExecutionResult): void {
    this.handlers.set(specId, handler);
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.seen.push(request);
    const handler = this.handlers.get(String(request.agentSpec.spec_id ?? ""));
    if (!handler) return emptyResult(request.executionId);
    return handler(request);
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.add(executionId);
  }

  lastRequestFor(specId: string): ExecutionRequest {
    for (let i = this.seen.length - 1; i >= 0; i--) {
      if (this.seen[i].agentSpec.spec_id === specId) return this.seen[i];
    }
    throw new Error(`no request for spec ${specId}`);
  }
}

export function emptyResult(executionId: string): ExecutionResult {
  return {
    executionId,
    emissions: [],
    artifacts: [],
    usage: { inTokens: 0, outTokens: 0, cost: 0, wallClockSeconds: 0, toolCalls: 0, compactions: 0 },
    termination: "DONE",
    observations: [],
    diagnostics: {},
  };
}

export function defaultUsage(): Usage {
  return { inTokens: 0, outTokens: 0, cost: 0, wallClockSeconds: 0, toolCalls: 0, compactions: 0 };
}

// ---------------------------------------------------------------------------
// 观察投影
// ---------------------------------------------------------------------------

export interface ExecutionRecordView {
  executionId: string;
  graphInstanceId: string;
  nodeId: string;
  status: "RUNNING" | "APPLIED" | "CANCELLED" | "FAILED";
}

export interface QueueView {
  topicId: string;
  depth: number;
  subscriberEndpoints: Array<[string, string, string]>;
}

// ---------------------------------------------------------------------------
// 版本层
// ---------------------------------------------------------------------------

export interface Provenance {
  graph_instance_id?: string | null;
  node_id?: string | null;
  execution_id?: string | null;
  at_seq: number;
  derived_from: string[];
}

export interface ObjectVersion {
  object_id: string;
  version: number;
  kind: string;
  content_hash: string;
  body: Record<string, unknown>;
  provenance: Provenance;
  ref: string;
}

const DEFAULT_PROVENANCE = (): Provenance => ({ at_seq: 0, derived_from: [] });

export class ObjectStore {
  static readonly KERNEL_KINDS = ["run", "annotation", "context_summary", "graph_template", "graph_template_proposal"];

  private byObject = new Map<string, ObjectVersion[]>();
  private byHash = new Map<string, ObjectVersion>();

  static contentHash(body: Record<string, unknown>): string {
    return createHash("sha256").update(stableStringify(body), "utf8").digest("hex").slice(0, 16);
  }

  /** 唯一写入口。同内容重复提交返回既有版本（V3 幂等）。 */
  put(objectId: string, kind: string, body: Record<string, unknown>, provenance?: Provenance | null): ObjectVersion {
    const h = ObjectStore.contentHash(body);
    const key = `${objectId}\u0000${h}`;
    const existing = this.byHash.get(key);
    if (existing) return existing;
    const versions = this.byObject.get(objectId) ?? [];
    const ov: ObjectVersion = {
      object_id: objectId,
      version: versions.length + 1,
      kind,
      content_hash: h,
      body,
      provenance: provenance ?? DEFAULT_PROVENANCE(),
      ref: `${objectId}@${versions.length + 1}`,
    };
    versions.push(ov);
    this.byObject.set(objectId, versions);
    this.byHash.set(key, ov);
    return ov;
  }

  get(objectId: string, version: number): ObjectVersion {
    const list = this.byObject.get(objectId);
    if (!list || version <= 0 || version > list.length) {
      throw new InvariantError(`no such version: ${objectId}@${version}`);
    }
    return list[version - 1]!;
  }

  /** 只接受精确引用 `object_id@version`（不变量 V4）。 */
  resolve(ref: string): ObjectVersion {
    const idx = ref.lastIndexOf("@");
    if (idx <= 0) throw new InvariantError(`引用必须精确到版本：${JSON.stringify(ref)}`);
    const oid = ref.slice(0, idx);
    const ver = Number(ref.slice(idx + 1));
    if (!Number.isInteger(ver) || ver <= 0) {
      throw new InvariantError(`引用必须精确到版本：${JSON.stringify(ref)}`);
    }
    return this.get(oid, ver);
  }

  head(objectId: string): ObjectVersion {
    const list = this.byObject.get(objectId);
    if (!list || list.length === 0) throw new InvariantError(`no versions for object: ${objectId}`);
    return list[list.length - 1]!;
  }

  history(objectId: string): ObjectVersion[] {
    return [...(this.byObject.get(objectId) ?? [])];
  }

  allObjects(): Map<string, ObjectVersion[]> {
    return this.byObject;
  }

  /** 回溯版本 DAG：{ref: [上游 ref, ...]}。 */
  lineage(ref: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const frontier = [ref];
    while (frontier.length) {
      const cur = frontier.pop()!;
      if (cur in out) continue;
      let parents: string[] = [];
      try {
        parents = [...this.resolve(cur).provenance.derived_from];
      } catch {
        /* 未解析的引用记为空 */
      }
      out[cur] = parents;
      frontier.push(...parents);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 主体与错误
// ---------------------------------------------------------------------------

export type PrincipalKind = "human" | "agent" | "system" | "service";

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

export function principalStr(p: Principal): string {
  return `${p.kind}:${p.id}`;
}

export function principalParse(value: Principal | string): Principal {
  if (typeof value !== "string") {
    if (value && typeof value.kind === "string" && typeof value.id === "string") return value as Principal;
    throw new InvariantError(`principal 必须形如 kind:id，得到 ${JSON.stringify(value)}`);
  }
  const idx = value.indexOf(":");
  const kind = value.slice(0, idx);
  const ident = value.slice(idx + 1);
  if (idx <= 0 || !["human", "agent", "system", "service"].includes(kind)) {
    throw new InvariantError(
      `principal 必须形如 kind:id，kind ∈ human|agent|system|service，得到 ${JSON.stringify(value)}`
    );
  }
  return { kind: kind as PrincipalKind, id: ident };
}

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

export class AuthorizationError extends InvariantError {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

// ---------------------------------------------------------------------------
// 内部结构（Runtime 状态，persistence 层可经 rt.st 读取）
// ---------------------------------------------------------------------------

export const ALLOWED_NODE_KINDS = new Set(["agent", "plain", "strategy", "approval", "subflow", "start", "end"]);

export type NodeKind = "agent" | "plain" | "strategy" | "approval" | "subflow" | "start" | "end";

export interface NodeState {
  persistent: Record<string, unknown>;
  tail: string[];
  transient: unknown[]; // 本轮临时，claim 后清空
  lastContext: InvocationContext | null;
  lastSpec: Record<string, unknown> | null;
  version: number; // 冲突域：节点级，不是容器级
  sessionHandle: unknown;
}

export type InstanceStatus = "OPEN" | "PAUSED" | "CLOSED";

export interface InstanceState {
  gid: string;
  templateRef: string;
  owner: string;
  status: InstanceStatus;
  seq: number;
  params: Record<string, unknown>;
  nodes: Map<string, NodeState>;
  head: string[];
  children: Record<string, string[]>;
  poolCursor: Record<string, number>;
  controllers: Set<string>;
  overflow: Record<string, string[]>; // WARM_POOL 忙时扩容的孤儿实例
}

export type RecordStatus = "RUNNING" | "APPLIED" | "CANCELLED" | "FAILED";

export interface RecordState {
  executionId: string;
  gid: string;
  nodeId: string;
  status: RecordStatus;
  claimed: string[];
  request: ExecutionRequest | null;
  baseNodeVersion: number;
  contextTrims: Array<Record<string, unknown>>;
}

export type MessageStateValue = "QUEUED" | "CLAIMED" | "CONSUMED" | "AWAITING" | "FAILED";

export interface MessageState {
  mid: string;
  target: [string, string, string];
  payload: unknown;
  state: MessageStateValue;
  callback: [string, string, string] | null;
  topic: string | null;
  mkind: "DATA" | "REPLY";
  attempts: number; // 已失败次数（#7 重试策略）
  exitPort: string | null; // 子流程回程端口（#9，取代 "reply" 魔法串）
  requestId: string | null; // REQUEST 关联（#13）：信封字段，绝不写进 payload（M3b）
}

export interface Unit {
  kind: "agent" | "model_strategy" | "strategy" | "simple";
  inst: InstanceState;
  nodeId: string;
  node: Record<string, unknown>;
  msg?: MessageState;
  batch?: MessageState[];
  executionId?: string;
  discard: MessageState[]; // TOP_ONE DISCARD：随本次提交一起消费但不进 handler
  selectionCtx: Record<string, unknown>; // CROSS_ALL 等选择期上下文
}

export interface HandlerCtx {
  gid: string;
  state: Record<string, unknown>;
  publish: (oid: string, body: Record<string, unknown>) => ObjectVersion;
}

export type HandlerFn = (payloads: Record<string, unknown>, ctx: HandlerCtx) => Record<string, unknown> | void;

/** 全部可变运行状态 —— Runtime 持有，persistence 层可读。 */
export interface KernelState {
  ids: number;
  cards: Map<string, Map<number, Record<string, unknown>>>; // key = `${kind}/${cardId}`
  cardTags: Map<string, Set<string>>; // tag -> ref 集合
  characters: Map<string, { cards: Array<[string, string, number | null]>; tools: Array<Record<string, unknown>> }>;
  specs: Map<string, { spec_id: string; model: string; declared_cards: Array<[string, string, number | null]>; tools: Array<Record<string, unknown>> }>;
  templates: Map<string, Record<string, unknown>>; // ref -> spec（不含 _layout）
  layouts: Map<string, unknown>; // ref -> _layout
  topics: Map<string, { request_contract?: Record<string, unknown> | null; reply_contract?: Record<string, unknown> | null }>;
  transforms: Map<string, { role: string; body: Record<string, unknown> }>;
  contracts: Map<string, Record<string, unknown>>;
  policies: Map<string, Record<string, unknown>>;
  handlers: Map<string, HandlerFn>;
  instances: Map<string, InstanceState>;
  messages: Map<string, MessageState>;
  subs: Map<string, Array<[string, [string, string, string]]>>;
  records: Map<string, RecordState>;
  backend: ExecutionBackend | null;
  inflight: number;
}

export function newKernelState(): KernelState {
  return {
    ids: 1,
    cards: new Map(),
    cardTags: new Map(),
    characters: new Map(),
    specs: new Map(),
    templates: new Map(),
    layouts: new Map(),
    topics: new Map(),
    transforms: new Map(),
    contracts: new Map(),
    policies: new Map(),
    handlers: new Map(),
    instances: new Map(),
    messages: new Map(),
    subs: new Map(),
    records: new Map(),
    backend: null,
    inflight: 0,
  };
}
