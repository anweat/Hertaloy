#!/usr/bin/env node
/**
 * OpenAI 兼容端点 driver（DeepSeek / OpenRouter / Groq / Together / …）
 *
 * 定位：**对照组 + 最小生产 backend**。
 * 我们自己实现，因此四条必控判据（A1/A2/A3/D1）天然满足：
 *   A1 system prompt 完全由我们给
 *   A2 messages 完全由我们给，不补历史
 *   A3 永不压缩（compactions 恒为 0）
 *   D1 全程无状态，不落任何会话文件
 * 它是 pi / Claude / Codex 的比较基准。
 *
 * 配置（**不进 git**）：默认读 ./config/llm.local.json，可用
 * NODEFLOW_LLM_CONFIG 指定其他路径；也可全部走环境变量。
 *
 *   { "base_url": "https://api.deepseek.com/v1",
 *     "api_key":  "…",
 *     "model":    "deepseek-chat" }
 *
 * 环境变量覆盖：NODEFLOW_LLM_BASE_URL / NODEFLOW_LLM_API_KEY / NODEFLOW_LLM_MODEL
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const observe = (id, observation) =>
  out({ type: "observation", execution_id: id, observation });

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function loadConfig() {
  const p =
    process.env.NODEFLOW_LLM_CONFIG ??
    path.join(process.cwd(), "config", "llm.local.json");
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    /* 允许纯环境变量模式 */
  }
  const cfg = {
    base_url: process.env.NODEFLOW_LLM_BASE_URL ?? file.base_url,
    api_key: process.env.NODEFLOW_LLM_API_KEY ?? file.api_key,
    model: process.env.NODEFLOW_LLM_MODEL ?? file.model ?? "deepseek-chat",
    max_iterations: file.max_iterations ?? 6,
  };
  if (!cfg.base_url || !cfg.api_key) {
    throw new Error(
      `缺少 base_url / api_key。请创建 ${p}（该路径已在 .gitignore 中），` +
        `或设置 NODEFLOW_LLM_BASE_URL / NODEFLOW_LLM_API_KEY`
    );
  }
  return cfg;
}

let CFG;
try {
  CFG = loadConfig();
} catch (err) {
  out({ type: "error", message: String(err.message ?? err) });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 上下文编译 —— 完全由编排面决定，driver 不加任何东西
// ---------------------------------------------------------------------------

function compileMessages(req) {
  const ctx = req.context ?? {};
  const msgs = [];
  const system = req.agent_spec?.systemPrompt;
  if (system) msgs.push({ role: "system", content: system });

  for (const ref of ctx.head ?? [])
    msgs.push({ role: "user", content: `[head] ${ref}` });

  for (const m of ctx.messages ?? []) {
    if (m && typeof m === "object" && typeof m.role === "string") msgs.push(m);
    else msgs.push({ role: "user", content: JSON.stringify(m) });
  }

  // 不变量 X：运行期发现的资料一律追加在尾部，保住缓存前缀
  for (const ref of ctx.tail ?? [])
    msgs.push({ role: "user", content: `[tail] ${ref}` });
  for (const t of ctx.transient ?? [])
    msgs.push({ role: "user", content: JSON.stringify(t) });

  return msgs;
}

/** allowed_emit_ports → 一个 emit 工具。Agent 只能选，不能构造。 */
function buildTools(req) {
  const ports = req.output_contract?.allowed_emit_ports ?? [];
  return [
    {
      type: "function",
      function: {
        name: "emit",
        description:
          "输出本轮结果。完成任务后必须调用一次。port 只能取给定枚举值之一。",
        parameters: {
          type: "object",
          properties: {
            port: { type: "string", enum: ports },
            payload: { type: "object", description: "结果内容" },
          },
          required: ["port", "payload"],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const inflight = new Map(); // execution_id -> AbortController

async function handleRun(req) {
  const id = req.execution_id;
  const ports = req.output_contract?.allowed_emit_ports ?? [];
  const emissions = [];
  const observations = [];
  const usage = {
    in_tokens: 0, out_tokens: 0, cost: 0,
    wall_clock_seconds: 0, tool_calls: 0,
    compactions: 0,          // ★A3：我们永不压缩
  };

  const diagnostics = {
    received_context: req.context,
    received_tools: req.agent_spec?.tools ?? [],
    received_system: req.agent_spec?.systemPrompt ?? null,
    model: CFG.model,
  };

  // 探针专用：不打 API 的可控挂起，用于验证取消链路（不烧 token）
  if (req.agent_spec?.probe_hang) {
    const ac = new AbortController();
    inflight.set(id, ac);
    await new Promise((resolve) => {
      ac.signal.addEventListener("abort", resolve, { once: true });
    });
    inflight.delete(id);
    return out({
      type: "result", execution_id: id,
      result: { execution_id: id, emissions: [], artifacts: [], usage,
                termination: "CANCELLED", session_handle: null,
                observations, diagnostics },
    });
  }

  const ac = new AbortController();
  inflight.set(id, ac);
  const started = Date.now();
  const messages = compileMessages(req);
  const tools = buildTools(req);
  let termination = "DONE";

  try {
    for (let i = 0; i < CFG.max_iterations; i++) {
      const resp = await fetch(`${CFG.base_url}/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CFG.api_key}`,
        },
        body: JSON.stringify({
          model: CFG.model,
          messages,
          tools,
          tool_choice: "auto",
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      const data = await resp.json();
      if (data.usage) {
        usage.in_tokens += data.usage.prompt_tokens ?? 0;
        usage.out_tokens += data.usage.completion_tokens ?? 0;
      }

      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      messages.push(msg);

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) break;   // 模型没再调工具，收工

      for (const call of calls) {
        usage.tool_calls += 1;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
        } catch { /* 保留空对象，下面按非法处理 */ }

        const isEmit = call.function?.name === "emit";
        const record = {
          kind: "tool_call",
          name: call.function?.name,
          gated: isEmit,                 // 我们能拦的只有自己声明的工具
          input: args,
        };
        observations.push(record);
        observe(id, record);

        let toolResult;
        if (!isEmit) {
          // 未声明的工具 —— 拒绝，理由回传模型（◇B2 纵深防御）
          toolResult = `错误：工具 ${call.function?.name} 未声明，不可调用。`;
        } else if (!ports.includes(args.port)) {
          // ★第一不变量：只能选，不能构造
          toolResult = `错误：port "${args.port}" 未声明。允许值：${ports.join(", ")}`;
        } else {
          emissions.push({ port: args.port, payload: args.payload ?? {} });
          toolResult = "ok";
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResult,
        });
      }

      if (emissions.length > 0) break;  // 已拿到合法输出
    }

    if (emissions.length === 0) termination = "INVALID_OUTPUT";
  } catch (err) {
    if (ac.signal.aborted) {
      termination = "CANCELLED";
    } else {
      termination = "FAILED";
      observe(id, { kind: "error", message: String(err.message ?? err) });
      diagnostics.error = String(err.message ?? err);
    }
  } finally {
    inflight.delete(id);
  }

  usage.wall_clock_seconds = (Date.now() - started) / 1000;
  out({
    type: "result", execution_id: id,
    result: { execution_id: id, emissions, artifacts: [], usage,
              termination, session_handle: null, observations, diagnostics },
  });
}

// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    return out({ type: "error", message: `bad json: ${String(err)}` });
  }
  if (msg.type === "run") {
    try {
      await handleRun(msg.request);
    } catch (err) {
      out({ type: "error", execution_id: msg.request?.execution_id,
            message: String(err.message ?? err) });
    }
    return;
  }
  if (msg.type === "cancel") {
    inflight.get(msg.execution_id)?.abort();   // ◇C1
    return;
  }
  out({ type: "error", message: `unknown message type: ${msg.type}` });
});
rl.on("close", () => process.exit(0));
