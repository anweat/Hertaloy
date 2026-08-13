#!/usr/bin/env node
/**
 * pi driver —— 骨架，**尚未验证**。
 *
 * 本文件按 pi 的 README/文档编写，未在装有 pi 的环境中跑过。
 * 带 [TODO-VERIFY] 的位置是我无法从文档确认的具体形状，装上 pi 后需核对：
 *
 *   npm i @earendil-works/pi-agent-core @earendil-works/pi-ai
 *   PROBE_PI=1 python -m unittest test_probes.TestPi -v
 *
 * 设计立场（HARNESS_EVALUATION §1）：只租用推理循环，不租用状态。
 *   - 用低层 `Agent`，**不用** `AgentHarness`（后者自带 lanes/tree/records，与编排面双份）
 *   - 不使用 pi 的 session 持久化；历史完全来自 request.context
 *   - 不使用 CBOR 协议 / server 包
 */

import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const observe = (id, observation) =>
  out({ type: "observation", execution_id: id, observation });

// [TODO-VERIFY] 确认包名与导出符号
let Agent, models;
try {
  ({ Agent } = await import("@earendil-works/pi-agent-core"));
  models = await import("@earendil-works/pi-ai");
} catch (err) {
  out({ type: "error", message: `pi 未安装或导出不符: ${String(err)}` });
  process.exit(1);
}

const inflight = new Map(); // execution_id -> agent

/** 把我们的 InvocationContext 编译成 pi 的 messages。 */
function compileMessages(ctx) {
  const msgs = [];
  for (const ref of ctx.head ?? [])
    msgs.push({ role: "user", content: `[head] ${ref}` });
  for (const m of ctx.messages ?? [])
    msgs.push(typeof m === "object" && m.role ? m : { role: "user", content: JSON.stringify(m) });
  // 不变量 X：运行期发现的 skill/资料一律追加在**尾部**，保住缓存前缀
  for (const ref of ctx.tail ?? [])
    msgs.push({ role: "user", content: `[tail] ${ref}` });
  for (const t of ctx.transient ?? [])
    msgs.push({ role: "user", content: JSON.stringify(t) });
  return msgs;
}

/** allowed_emit_ports → 一个 emit 工具；agent 只能选，不能构造。 */
function buildTools(req, executionId, emissions) {
  const ports = req.output_contract?.allowed_emit_ports ?? [];
  const emitTool = {
    name: "emit",
    description: `输出结果。port 必须是以下之一：${ports.join(", ")}`,
    // [TODO-VERIFY] pi 用 TypeBox；确认 Type.Object 的导入与写法
    parameters: {
      type: "object",
      properties: {
        port: { type: "string", enum: ports },
        payload: { type: "object" },
      },
      required: ["port", "payload"],
    },
    executionMode: "sequential",
    execute: async (toolCallId, params /* , signal, onUpdate */) => {
      emissions.push({ port: params.port, payload: params.payload });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
  return [emitTool];
}

async function handleRun(req) {
  const id = req.execution_id;
  const emissions = [];
  const observations = [];

  const agent = new Agent({
    initialState: {
      systemPrompt: req.agent_spec?.systemPrompt ?? "",
      model: req.agent_spec?.model,
      tools: buildTools(req, id, emissions),
      messages: compileMessages(req.context),
    },
    // [TODO-VERIFY] streamFn 的绑定方式
    streamFn: models.streamSimple?.bind(models),

    // ★A3：绝不擅自压缩 —— 上下文完全由编排面决定
    transformContext: async (messages) => messages,

    // ◇B2：纵深防御。第一不变量在 apply_execution 已强制，这里是第二道
    beforeToolCall: async ({ toolCall, args }) => {
      const gated = toolCall.name === "emit";
      observations.push({
        kind: "tool_call",
        name: toolCall.name,
        gated,
        input: args ?? {},
      });
      observe(id, observations[observations.length - 1]);
      if (gated && !(req.output_contract?.allowed_emit_ports ?? []).includes(args?.port)) {
        return { block: true, reason: `port ${args?.port} 未声明，请从允许集合中选择` };
      }
      return undefined;
    },
  });

  inflight.set(id, agent);

  agent.subscribe(async (event) => {
    // ○B6 / ○C2：内部 tool 拦不住也要能看见
    if (event.type?.startsWith("tool_execution")) {
      observe(id, { kind: "tool_event", type: event.type, name: event.name });
    }
  });

  let termination = "DONE";
  try {
    await agent.waitForIdle?.(); // [TODO-VERIFY] 触发一轮的确切入口
  } catch (err) {
    termination = "FAILED";
    observe(id, { kind: "error", message: String(err) });
  } finally {
    inflight.delete(id);
  }

  out({
    type: "result",
    execution_id: id,
    result: {
      execution_id: id,
      emissions,
      artifacts: [],
      // [TODO-VERIFY] pi 的 usage 字段名；compactions 若拿不到必须留 0 并在文档说明
      usage: { in_tokens: 0, out_tokens: 0, cost: 0, wall_clock_seconds: 0,
               tool_calls: observations.length, compactions: 0 },
      termination,
      session_handle: null,        // 不租用状态
      observations,
      diagnostics: {
        received_context: req.context,
        received_tools: (req.agent_spec?.tools ?? []),
        received_system: req.agent_spec?.systemPrompt ?? null,
      },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    return out({ type: "error", message: `bad json: ${String(err)}` });
  }
  if (msg.type === "run") return handleRun(msg.request);
  if (msg.type === "cancel") {
    const agent = inflight.get(msg.execution_id);
    if (agent) agent.abort();          // ◇C1
    return;
  }
  out({ type: "error", message: `unknown message type: ${msg.type}` });
});
rl.on("close", () => process.exit(0));
