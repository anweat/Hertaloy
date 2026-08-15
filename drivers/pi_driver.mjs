#!/usr/bin/env node
/**
 * pi driver —— 低层 Agent API 接线
 *
 * 两种模式：
 *   - faux（默认）：fauxProvider 脚本响应，验证接口形状（TestPi，5/3）
 *   - real：PI_REAL=1 时用 deepseekProvider（DEEPSEEK_API_KEY 环境变量），
 *     真实供应商行为（TestPiReal）。协议与观测逻辑两种模式完全一致。
 *
 * 设计立场（HARNESS_EVALUATION §1）：只租用推理循环，不租用状态。
 *   - 用低层 `Agent`，不用 `AgentHarness`（后者自带 lanes/tree/records，与编排面双份）
 *   - 不使用 pi 的 session 持久化；历史完全来自 request.context
 *   - 不使用 CBOR 协议 / server 包
 */

import readline from "node:readline";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Type } from "typebox";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const observe = (id, observation) =>
  out({ type: "observation", execution_id: id, observation });

// ---------------------------------------------------------------------------
// provider 选择
// ---------------------------------------------------------------------------

const REAL = process.env.PI_REAL === "1";
const models = createModels();
let faux = null;
let model = null;
if (REAL) {
  models.setProvider(deepseekProvider());
  model = models.getModel("deepseek",
                          process.env.PI_MODEL || "deepseek-v4-flash");
  if (!model) {
    out({ type: "error", message: "deepseek model 不可用（PI_MODEL 错误？）" });
    process.exit(1);
  }
} else {
  faux = fauxProvider();
  models.setProvider(faux.provider);
  model = faux.getModel();
}
const streamFn = models.streamSimple.bind(models);

const inflight = new Map(); // execution_id -> agent

/** 把我们的 InvocationContext 编译成 pi 的 messages。 */
function compileMessages(ctx) {
  const msgs = [];
  for (const ref of ctx.head ?? [])
    msgs.push({ role: "user", content: `[head] ${ref}` });
  for (let i = 0; i < (ctx.messages ?? []).length; i++) {
    const m = ctx.messages[i];
    const meta = ctx.meta?.[i];
    const tag = meta?.request_id ? `[request_id=${meta.request_id}] ` : "";
    msgs.push(
      typeof m === "object" && m?.role
        ? { ...m, content: tag + String(m.content ?? "") }
        : { role: "user", content: tag + JSON.stringify(m) }
    );
  }
  // 不变量 X：运行期发现的 skill/资料一律追加在**尾部**，保住缓存前缀
  for (const ref of ctx.tail ?? [])
    msgs.push({ role: "user", content: `[tail] ${ref}` });
  for (const t of ctx.transient ?? [])
    msgs.push({ role: "user", content: JSON.stringify(t) });
  return msgs;
}

/**
 * allowed_emit_ports → emit 工具 + agent_spec.tools 声明的工具全集。
 * declared 工具没有执行器：调用时在 beforeToolCall 被显式 gate 掉并回传理由，
 * 不会静默吞掉。
 */
function buildTools(req, executionId, emissions) {
  const ports = req.output_contract?.allowed_emit_ports ?? [];
  const portSchema = Type.Union(
    (ports.length ? ports : ["out"]).map((p) => Type.Literal(p))
  );
  const emitTool = {
    name: "emit",
    label: "emit",
    description: `输出结果。port 必须是以下之一：${ports.join(", ")}`,
    parameters: Type.Object({
      port: portSchema,
      payload: Type.Any(),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      emissions.push({ port: params.port, payload: params.payload ?? {} });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };

  const declared = (req.agent_spec?.tools ?? [])
    .filter((t) => t?.name && t.name !== "emit")
    .map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description ?? "",
      parameters: Type.Any(),
      executionMode: "sequential",
      execute: async () => {
        throw new Error(`工具 ${t.name} 已声明但未接入执行器（pi driver 待办）`);
      },
    }));
  return { tools: [emitTool, ...declared] };
}

/** faux 模式：request.agent_spec.fake 把剧本翻译成脚本响应。 */
function scriptFor(fake) {
  if (!faux) return;
  const blocks = [];
  for (const c of fake.toolCalls ?? [])
    blocks.push(fauxToolCall(c.name, c.input ?? {}));
  for (const e of fake.emit ?? [])
    blocks.push(fauxToolCall("emit", { port: e.port, payload: e.payload ?? {} }));
  if (blocks.length) {
    faux.setResponses([fauxAssistantMessage(blocks, { stopReason: "toolUse" })]);
    return;
  }
  faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
}

async function handleRun(req) {
  const id = req.execution_id;
  const emissions = [];
  const observations = [];
  const fake = req.agent_spec?.fake ?? {};
  scriptFor(fake);

  const built = buildTools(req, id, emissions);
  const declaredNames = new Set(built.tools.map((t) => t.name));

  const agent = new Agent({
    initialState: {
      systemPrompt: req.agent_spec?.systemPrompt ?? "",
      model,
      tools: built.tools,
    },
    streamFn,

    // ★A3：绝不擅自压缩 —— 上下文完全由编排面决定
    transformContext: async (messages) => messages,

    // ◇B2：纵深防御。第一不变量在 apply_execution 已强制，这里是第二道
    beforeToolCall: async ({ toolCall, args }) => {
      const name = toolCall.name;
      const gated = name === "emit" || declaredNames.has(name);
      observations.push({
        kind: "tool_call",
        name,
        gated,
        input: args ?? {},
      });
      observe(id, observations[observations.length - 1]);
      if (name === "emit") {
        const ports = req.output_contract?.allowed_emit_ports ?? [];
        if (!ports.includes(args?.port)) {
          return {
            block: true,
            terminate: true,
            reason: `port ${args?.port} 未声明，请从允许集合中选择`,
          };
        }
        return undefined;
      }
      if (declaredNames.has(name)) {
        return { block: true, terminate: true,
                 reason: `工具 ${name} 已声明但未接入执行器，已拦截` };
      }
      return { block: true, terminate: true,
               reason: `工具 ${name} 未声明，不可调用` };
    },
  });

  inflight.set(id, agent);

  agent.subscribe((event) => {
    // ○B6 / ○C2：内部 tool 拦不住也要能看见
    if (event.type?.startsWith("tool_execution")) {
      const rec = { kind: "tool_event", type: event.type, name: event.name };
      observations.push(rec);
      observe(id, rec);
    }
  });

  let termination = "DONE";
  let errorMessage = null;
  try {
    await agent.prompt(compileMessages(req.context));  // 历史外来：完整 messages 是我们给的
    await agent.waitForIdle?.();
  } catch (err) {
    termination = "FAILED";
    errorMessage = String(err?.message ?? err);
    observe(id, { kind: "error", message: errorMessage });
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
      // faux 无真实计量；real 模式 pi 的 Agent 事件流不暴露 usage 字段，
      // 如实报 0 并在诊断中注明 —— 不伪造消耗。
      usage: { in_tokens: 0, out_tokens: 0, cost: 0, wall_clock_seconds: 0,
               tool_calls: observations.length, compactions: 0 },
      termination,
      session_handle: null,        // 不租用状态
      observations,
      diagnostics: {
        provider_mode: REAL ? "deepseek-real" : "faux",
        received_context: req.context,
        received_tools: req.agent_spec?.tools ?? [],
        actual_tools: built.tools.map((t) => ({ name: t.name })),
        received_system: req.agent_spec?.systemPrompt ?? null,
        error: errorMessage,
      },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    out({ type: "error", message: `bad json: ${String(err)}` });
    return;
  }
  if (msg.type === "run") {
    handleRun(msg.request).catch((err) => {
      out({ type: "error", execution_id: msg.request?.execution_id,
            message: String(err?.message ?? err) });
    });
    return;
  }
  if (msg.type === "cancel") {
    inflight.get(msg.execution_id)?.abort();   // ◇C1
    return;
  }
  out({ type: "error", message: `unknown message type: ${msg.type}` });
});
rl.on("close", () => process.exit(0));
