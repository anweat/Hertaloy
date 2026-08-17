/**
 * 契约生成器：把 Zod 单源导出为 JSON Schema / OpenAPI 骨架。
 * 运行：pnpm schema:generate
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  graphTemplateSchema,
  strategyPolicySchema,
  jsonTransformDefinitionSchema,
  topicDefinitionSchema,
  messageContractSchema,
  graphInstanceSchema,
  messageInstanceSchema,
  executionRequestSchema,
  executionResultSchema,
  objectVersionSchema,
  layoutDocumentSchema,
  wsServerMessageSchema,
  eventPayloadSchema,
  nodeDefinitionSchema,
  edgeDefinitionSchema,
  slotDefinitionSchema,
  subscriptionDefinitionSchema,
} from "./zod.js";
import { CONTROL_TOOLS } from "./control-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../schemas");
mkdirSync(outDir, { recursive: true });

function emit(name: string, schema: unknown): void {
  writeFileSync(resolve(outDir, `${name}.schema.json`), JSON.stringify(schema, null, 2) + "\n");
  console.log(`written schemas/${name}.schema.json`);
}

emit("graph-template", zodToJsonSchema(graphTemplateSchema, "GraphTemplate"));
emit("node-definition", zodToJsonSchema(nodeDefinitionSchema, "NodeDefinition"));
emit("edge-definition", zodToJsonSchema(edgeDefinitionSchema, "EdgeDefinition"));
emit("slot-definition", zodToJsonSchema(slotDefinitionSchema, "SlotDefinition"));
emit("subscription-definition", zodToJsonSchema(subscriptionDefinitionSchema, "SubscriptionDefinition"));
emit("strategy-policy", zodToJsonSchema(strategyPolicySchema, "StrategyPolicy"));
emit("json-transform", zodToJsonSchema(jsonTransformDefinitionSchema, "JsonTransformDefinition"));
emit("topic-definition", zodToJsonSchema(topicDefinitionSchema, "TopicDefinition"));
emit("message-contract", zodToJsonSchema(messageContractSchema, "MessageContract"));
emit("graph-instance", zodToJsonSchema(graphInstanceSchema, "GraphInstance"));
emit("message-instance", zodToJsonSchema(messageInstanceSchema, "MessageInstance"));
emit("object-version", zodToJsonSchema(objectVersionSchema, "ObjectVersion"));
emit("execution-request", zodToJsonSchema(executionRequestSchema, "ExecutionRequest"));
emit("execution-result", zodToJsonSchema(executionResultSchema, "ExecutionResult"));
emit("layout-document", zodToJsonSchema(layoutDocumentSchema, "LayoutDocument"));
emit("ws-event", zodToJsonSchema(eventPayloadSchema, "EventPayload"));
emit("ws-server-message", zodToJsonSchema(wsServerMessageSchema, "WsServerMessage"));

// ControlPlane 工具（MCP tools/list 同源）
writeFileSync(
  resolve(outDir, "control-tools.json"),
  JSON.stringify(CONTROL_TOOLS, null, 2) + "\n"
);
console.log(`written schemas/control-tools.json (${Object.keys(CONTROL_TOOLS).length} tools)`);

// OpenAPI 骨架（完整 paths 由 server 包在启动时注册，此处生成文档入口）
const openapi = {
  openapi: "3.1.0",
  info: { title: "Nodeflow V5 API", version: "0.1.0" },
  paths: {
    "/cards": { get: { summary: "列出卡片", responses: { "200": { description: "ok" } } }, post: { summary: "注册卡片", responses: { "201": { description: "created" } } } },
    "/drafts": { get: { summary: "列出草稿", responses: { "200": { description: "ok" } } }, post: { summary: "创建草稿", responses: { "201": { description: "created" } } } },
    "/drafts/{id}/publish": { post: { summary: "发布草稿为模板版本", responses: { "200": { description: "template_ref" } } } },
    "/templates/{id}/versions": { get: { summary: "模板版本历史", responses: { "200": { description: "ok" } } } },
    "/instances": { post: { summary: "创建实例", responses: { "201": { description: "gid" } } } },
    "/instances/{gid}/messages": { post: { summary: "发送消息", responses: { "201": { description: "messageId" } } } },
    "/instances/{gid}/run": { post: { summary: "创建后台 run 任务", responses: { "200": { description: "runId" } } } },
    "/instances/{gid}/control": { post: { summary: "控制面动作", responses: { "200": { description: "ok" } } } },
    "/objects/{oid}/{version}": { get: { summary: "读取 ObjectVersion", responses: { "200": { description: "ok" } } } },
    "/control/dispatch": { post: { summary: "ControlPlane 工具 dispatch", responses: { "200": { description: "result" } } } },
  },
  components: { schemas: { GraphTemplate: JSON.parse(JSON.stringify(zodToJsonSchema(graphTemplateSchema))) } },
};
writeFileSync(resolve(outDir, "openapi.yaml"), JSON.stringify(openapi, null, 2) + "\n");
console.log("written schemas/openapi.yaml");
