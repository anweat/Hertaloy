/**
 * Nodeflow V5 —— Zod 单源契约（wire JSON 采用 V4 兼容的 snake_case）。
 *
 * 这是画布、后端、MCP、fixtures 共用的唯一真相源：
 *   GraphTemplate / NodeDefinition / EdgeDefinition / SlotDefinition
 *   StrategyPolicy / TopicDefinition / JsonTransformDefinition / MessageContract
 *   GraphInstance / NodeInstance / MessageInstance / ExecutionRecord
 *   ObjectVersion / Provenance / ExecutionRequest / ExecutionResult
 *   WS 事件协议 / ControlPlane 工具 schema / LayoutDocument
 *
 * 命名约定：凡出现在 wire JSON 上的字段一律 snake_case（与 Python V4 / fixtures
 * 完全一致）；TS 内部状态类型（kernel 私有）不受此约束。
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export const principalSchema = z.object({
  kind: z.enum(["human", "agent", "system", "service"]),
  id: z.string(),
});
export type Principal = z.infer<typeof principalSchema>;

export const principalRefSchema = z
  .string()
  .regex(/^(human|agent|system|service):.+/, "principal 必须形如 kind:id");

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

/** MessageContract —— 不可变 JSON Schema 子集（type/properties/required/…）。 */
export const messageContractSchema = z
  .record(z.string(), z.unknown())
  .refine((s) => {
    const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "description"]);
    for (const k of Object.keys(s)) {
      if (!allowed.has(k)) return false;
    }
    if ("type" in s) {
      const t = s.type;
      const okTypes = ["string", "number", "integer", "boolean", "object", "array", "null"];
      if (Array.isArray(t)) return t.every((x) => okTypes.includes(x));
      return okTypes.includes(t as string);
    }
    return true;
  }, "MessageContract 只允许 JSON Schema 子集字段");
export type MessageContract = z.infer<typeof messageContractSchema>;

// ---------------------------------------------------------------------------
// 定义层
// ---------------------------------------------------------------------------

export const nodeKindSchema = z.enum(["agent", "plain", "strategy", "approval", "subflow", "start", "end"]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const endpointBlockSchema = z
  .object({
    contract: z.string().optional(),
  })
  .passthrough();

/** 端点统一模型：方向来自本次 operation，不区分永久 input/output 两类。 */
export const endpointDefinitionSchema = z
  .object({
    receive: z.record(z.string(), z.union([z.string(), endpointBlockSchema])).optional(),
    emit: z.record(z.string(), z.union([z.string(), endpointBlockSchema])).optional(),
  })
  .passthrough();
export type EndpointDefinition = z.infer<typeof endpointDefinitionSchema>;

export const nodeDefinitionSchema = z
  .object({
    kind: nodeKindSchema,
    // agent
    spec: z.string().optional(),
    // plain / strategy
    handler: z.string().optional(),
    // strategy
    policy: z.string().optional(),
    evaluator: z
      .object({ kind: z.literal("model"), spec: z.string() })
      .optional(),
    // agent —— 内核工具桥（topic → 回调端点）
    publish_topics: z.record(z.string()).optional(),
    spawn_slots: z.array(z.string()).optional(),
    on_error: z.string().optional(),
    // approval
    authorized_actors: z.array(z.string()).optional(),
    approve_port: z.string().optional(),
    deny_port: z.string().optional(),
    // subflow
    slot: z.string().optional(),
    return_port: z.string().optional(),
    // start
    emit: z.string().optional(),
    // 节点级 prompt / 预算 / 工作区
    systemPrompt: z.string().optional(),
    limits: z
      .object({
        token_budget: z.number().int().positive().optional(),
        max_attempts: z.number().int().positive().optional(),
      })
      .optional(),
    workspace: z.string().optional(),
    // 统一端点模型：必须声明非空 endpoints
    endpoints: z.record(z.string(), endpointDefinitionSchema),
  })
  .strict()
  .refine((n) => Object.keys(n.endpoints).length > 0, "节点必须声明非空 endpoints（统一端点模型）");
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;

export const edgeDefinitionSchema = z.object({
  id: z.string().optional(),
  from: z.string().regex(/^[^.]+\.[^.]+$/, "from 必须形如 node.endpoint"),
  to: z.string().regex(/^[^.]+\.[^.]+$/, "to 必须形如 node.endpoint"),
  operation: z.literal("PUSH").optional(),
  servo: z.string().optional(),
});
export type EdgeDefinition = z.infer<typeof edgeDefinitionSchema>;

export const slotDefinitionSchema = z.object({
  template: z.string(), // 精确 ref template@n
  instantiation: z.string().optional(), // PER_CALL | WARM_POOL(n) | SINGLETON
  entry: z.string().regex(/^[^.]+\.[^.]+$/, "entry 必须形如 node.endpoint"),
  exit: z
    .object({
      endpoint: z.string().regex(/^[^.]+\.[^.]+$/, "endpoint 必须形如 node.endpoint"),
      contract: z.string().optional(),
    })
    .optional(),
});
export type SlotDefinition = z.infer<typeof slotDefinitionSchema>;

export const subscriptionDefinitionSchema = z.object({
  topic: z.string(),
  endpoint: z.string().regex(/^[^.]+\.[^.]+$/, "endpoint 必须形如 node.endpoint"),
});
export type SubscriptionDefinition = z.infer<typeof subscriptionDefinitionSchema>;

export const graphTemplateSchema = z.object({
  template_id: z.string().optional(),
  nodes: z.record(z.string(), nodeDefinitionSchema),
  edges: z.array(edgeDefinitionSchema).optional(),
  slots: z.record(z.string(), slotDefinitionSchema).optional(),
  subscriptions: z.array(subscriptionDefinitionSchema).optional(),
  strict_contracts: z.boolean().optional(),
  topics: z.record(z.string(), z.unknown()).optional(),
});
export type GraphTemplate = z.infer<typeof graphTemplateSchema>;

export const strategyPolicySchema = z.object({
  readiness: z.enum(["ANY", "ALL_REQUIRED"]).optional(),
  selection: z.enum(["FIRST", "TOP_ONE", "ONE_PER_INPUT", "CROSS_ALL"]).optional(),
  required_inputs: z.array(z.string()).optional(),
  rankField: z.string().optional(),
  unselected: z.enum(["RETAIN", "DISCARD"]).optional(),
  output: z
    .object({
      mode: z.enum(["EMIT_EACH", "WAIT_ALL", "CROSS", "FANOUT_TO_SLOT"]).optional(),
      slot: z.string().optional(),
      max_items: z.number().int().positive().optional(),
      required_outputs: z.array(z.string()).optional(),
      left: z.string().optional(),
      right: z.string().optional(),
      target: z.string().optional(),
      leftKey: z.string().optional(),
      rightKey: z.string().optional(),
    })
    .optional(),
});
export type StrategyPolicy = z.infer<typeof strategyPolicySchema>;

export const jsonTransformDefinitionSchema = z.object({
  role: z.enum(["EDGE_SERVO"]),
  body: z
    .object({
      set: z.record(z.string(), jsonValueSchema).optional(),
      map: z.record(z.string(), z.string()).optional(),
      drop: z.array(z.string()).optional(),
    })
    .strict(),
});
export type JsonTransformDefinition = z.infer<typeof jsonTransformDefinitionSchema>;

export const topicDefinitionSchema = z.object({
  request_contract: messageContractSchema.optional(),
  reply_contract: messageContractSchema.optional(),
});
export type TopicDefinition = z.infer<typeof topicDefinitionSchema>;

// ---------------------------------------------------------------------------
// 版本层
// ---------------------------------------------------------------------------

export const provenanceSchema = z.object({
  graph_instance_id: z.string().nullable().optional(),
  node_id: z.string().nullable().optional(),
  execution_id: z.string().nullable().optional(),
  at_seq: z.number().int(),
  derived_from: z.array(z.string()).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const objectVersionSchema = z.object({
  object_id: z.string(),
  version: z.number().int().positive(),
  kind: z.string(),
  content_hash: z.string(),
  body: z.record(z.string(), z.unknown()),
  provenance: provenanceSchema.optional(),
});
export type ObjectVersion = z.infer<typeof objectVersionSchema>;

// ---------------------------------------------------------------------------
// 实例 / 消息 / 记录
// ---------------------------------------------------------------------------

export const instanceStatusSchema = z.enum(["OPEN", "PAUSED", "CLOSED"]);

export const nodeInstanceStateSchema = z.object({
  persistent_state: z.record(z.string(), z.unknown()),
  tail: z.array(z.string()),
  transient: z.array(z.unknown()),
  version: z.number().int(),
});
export type NodeInstanceState = z.infer<typeof nodeInstanceStateSchema>;

export const graphInstanceSchema = z.object({
  gid: z.string(),
  template_ref: z.string(),
  owner: z.string(),
  status: instanceStatusSchema,
  seq: z.number().int(),
  params: z.record(z.string(), z.unknown()),
  head: z.array(z.string()),
  nodes: z.record(z.string(), nodeInstanceStateSchema),
  children: z.record(z.string(), z.array(z.string())),
  pool_cursor: z.record(z.string(), z.number().int()),
  overflow: z.record(z.string(), z.array(z.string())),
  controllers: z.array(z.string()),
});
export type GraphInstance = z.infer<typeof graphInstanceSchema>;

export const messageStateSchema = z.enum(["QUEUED", "CLAIMED", "CONSUMED", "AWAITING", "FAILED"]);

export const messageInstanceSchema = z.object({
  message_id: z.string(),
  target: z.tuple([z.string(), z.string(), z.string()]),
  payload: z.unknown(),
  state: messageStateSchema,
  callback: z.tuple([z.string(), z.string(), z.string()]).nullable().optional(),
  topic: z.string().nullable().optional(),
  mkind: z.enum(["DATA", "REPLY"]),
  attempts: z.number().int(),
  exit_port: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
});
export type MessageInstance = z.infer<typeof messageInstanceSchema>;

export const recordStatusSchema = z.enum(["RUNNING", "APPLIED", "CANCELLED", "FAILED"]);

export const executionRecordSchema = z.object({
  execution_id: z.string(),
  gid: z.string(),
  node_id: z.string(),
  status: recordStatusSchema,
  claimed: z.array(z.string()),
  request: z.record(z.string(), z.unknown()).nullable().optional(),
  base_node_version: z.number().int(),
  context_trims: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

// ---------------------------------------------------------------------------
// 执行面契约（TS 内部 camelCase）
// ---------------------------------------------------------------------------

export const invocationContextSchema = z.object({
  head: z.array(z.string()),
  messages: z.array(z.unknown()),
  tail: z.array(z.string()),
  transient: z.array(z.unknown()),
  meta: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type InvocationContext = z.infer<typeof invocationContextSchema>;

export const workspaceScopeSchema = z.object({ root: z.string() });
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;

export const outputContractSchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  allowed_emit_ports: z.array(z.string()),
});
export type OutputContract = z.infer<typeof outputContractSchema>;

export const executionLimitsSchema = z.object({
  token_budget: z.number().int().positive().nullable().optional(),
  wall_clock_seconds: z.number().positive().nullable().optional(),
  max_tool_calls: z.number().int().positive().nullable().optional(),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;

export const terminationSchema = z.enum(["DONE", "CANCELLED", "BUDGET", "INVALID_OUTPUT", "FAILED"]);
export type Termination = z.infer<typeof terminationSchema>;

export const usageSchema = z.object({
  in_tokens: z.number().int(),
  out_tokens: z.number().int(),
  cost: z.number(),
  wall_clock_seconds: z.number(),
  tool_calls: z.number().int(),
  compactions: z.number().int(),
});
export type Usage = z.infer<typeof usageSchema>;

export const executionRequestSchema = z.object({
  executionId: z.string(),
  agentSpec: z.record(z.string(), z.unknown()),
  context: invocationContextSchema,
  origin: z.tuple([z.string(), z.string()]),
  workspace: workspaceScopeSchema.optional(),
  outputContract: outputContractSchema.optional(),
  limits: executionLimitsSchema.optional(),
  resumeHandle: z.unknown().optional(),
});
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;

export const executionResultSchema = z.object({
  executionId: z.string(),
  emissions: z.array(z.tuple([z.string(), z.unknown()])),
  artifacts: z.array(z.tuple([z.string(), z.string(), z.record(z.string(), z.unknown())])),
  usage: usageSchema.optional(),
  termination: terminationSchema.optional(),
  sessionHandle: z.unknown().optional(),
  observations: z.array(z.record(z.string(), z.unknown())).optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;

// ---------------------------------------------------------------------------
// WS 事件协议
// ---------------------------------------------------------------------------

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), channels: z.array(z.string()) }),
  z.object({ type: z.literal("unsubscribe"), channels: z.array(z.string()) }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export const eventPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance.status"), gid: z.string(), status: instanceStatusSchema }),
  z.object({ kind: z.literal("message.created"), gid: z.string(), messageId: z.string(), state: z.literal("QUEUED") }),
  z.object({ kind: z.literal("message.claimed"), gid: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal("message.consumed"), gid: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal("message.failed"), gid: z.string(), messageId: z.string(), reason: z.string().optional() }),
  z.object({ kind: z.literal("message.awaiting"), gid: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal("execution.claimed"), executionId: z.string(), gid: z.string(), nodeId: z.string() }),
  z.object({ kind: z.literal("execution.running"), executionId: z.string() }),
  z.object({ kind: z.literal("execution.applied"), executionId: z.string(), gid: z.string(), nodeId: z.string(), seq: z.number().int() }),
  z.object({ kind: z.literal("execution.cancelled"), executionId: z.string() }),
  z.object({ kind: z.literal("execution.failed"), executionId: z.string(), reason: z.string().optional() }),
  z.object({ kind: z.literal("commit.snapshot"), gid: z.string(), seq: z.number().int(), ref: z.string() }),
  z.object({ kind: z.literal("queue.depth"), topic: z.string(), depth: z.number().int() }),
  z.object({ kind: z.literal("control.applied"), gid: z.string(), action: z.string(), actor: z.string() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const wsServerMessageSchema = z.object({
  type: z.literal("event"),
  channel: z.string(),
  seq: z.number().int(),
  payload: eventPayloadSchema,
});
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

// ---------------------------------------------------------------------------
// ControlPlane 工具 schema（MCP Tool.inputSchema 形状）
// ---------------------------------------------------------------------------

export const controlToolSchema = z.object({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ControlTool = z.infer<typeof controlToolSchema>;

export const controlToolsSchema = z.record(z.string(), controlToolSchema);

// ---------------------------------------------------------------------------
// 画布布局文档（_layout —— 不进入语义校验与版本指纹）
// ---------------------------------------------------------------------------

export const layoutDocumentSchema = z.object({
  nodes: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
      collapsed: z.boolean().optional(),
    })
  ),
  edges: z
    .record(
      z.string(),
      z.object({ controlPoints: z.array(z.tuple([z.number(), z.number()])).optional() })
    )
    .optional(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  groups: z
    .record(z.string(), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), title: z.string() }))
    .optional(),
});
export type LayoutDocument = z.infer<typeof layoutDocumentSchema>;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** stable stringify：对象内容哈希与版本指纹的唯一规范（V3 内容寻址）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
