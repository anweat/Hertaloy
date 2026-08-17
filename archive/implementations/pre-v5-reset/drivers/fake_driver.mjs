#!/usr/bin/env node
/**
 * 假 driver —— 用于测试适配层本身，不依赖任何 vendor。
 *
 * 行为由 request.agent_spec.fake 驱动，使探针能构造各种情形：
 *   emit         [{port, payload}]        输出提案
 *   artifacts    [{kind, object_id, body}]
 *   toolCalls    [{name, gated}]          gated:false = 拦不住、只能观测的内部 tool
 *   compactions  n                        模拟 backend 擅自压缩（判据 A3/A4）
 *   hang         true                     挂起直到收到 cancel（判据 C1）
 *   echoContext  true                     把收到的 context 原样回传，供 P1/P7 断言
 *   leakHistory  true                     故意违约：自行往历史里塞东西（负向用例）
 *   kernelToolCalls [{name, arguments}]   逐个回调编排面内核工具（P0-6），
 *                                         结果放进 diagnostics.kernel_results
 */

import readline from "node:readline";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** 未完成的执行：execution_id -> 完成回调 */
const pending = new Map();
/** 内核工具桥：tool_call_id -> resolve */
const kernelPending = new Map();

function observe(executionId, observation) {
  out({ type: "observation", execution_id: executionId, observation });
}

let toolCallSeq = 0;
function callKernelTool(executionId, name, arguments_) {
  const toolCallId = `kt-${++toolCallSeq}`;
  return new Promise((resolve, reject) => {
    kernelPending.set(toolCallId, { resolve, reject });
    out({ type: "kernel_tool", execution_id: executionId,
          tool_call_id: toolCallId, name, arguments: arguments_ ?? {} });
  });
}

function finish(executionId, req, fake, termination, kernelResults = []) {
  const emissions = (fake.emit ?? []).map((e) => ({
    port: e.port,
    payload: e.payload,
  }));
  const artifacts = (fake.artifacts ?? []).map((a) => ({
    kind: a.kind,
    object_id: a.object_id,
    body: a.body,
  }));

  const observations = (fake.toolCalls ?? []).map((t) => ({
    kind: "tool_call",
    name: t.name,
    gated: t.gated !== false,
    input: t.input ?? {},
  }));

  const diagnostics = {};
  if (fake.echoContext) {
    diagnostics.received_context = req.context;
    diagnostics.received_tools = req.agent_spec?.tools ?? [];
    diagnostics.received_system = req.agent_spec?.systemPrompt ?? null;
  }
  diagnostics.kernel_results = kernelResults;

  out({
    type: "result",
    execution_id: executionId,
    result: {
      execution_id: executionId,
      emissions,
      artifacts,
      usage: {
        in_tokens: fake.in_tokens ?? 0,
        out_tokens: fake.out_tokens ?? 0,
        cost: 0,
        wall_clock_seconds: 0,
        tool_calls: observations.length,
        compactions: fake.compactions ?? 0,
      },
      termination,
      session_handle: fake.session_handle ?? null,
      observations,
      diagnostics,
    },
  });
}

async function handleRun(req) {
  const executionId = req.execution_id;
  const fake = req.agent_spec?.fake ?? {};

  // 工具调用先以事件流形式吐出（含拦不住的内部 tool）
  for (const t of fake.toolCalls ?? []) {
    observe(executionId, {
      kind: "tool_call",
      name: t.name,
      gated: t.gated !== false,
      input: t.input ?? {},
    });
  }
  if (fake.compactions) {
    observe(executionId, {
      kind: "compaction",
      count: fake.compactions,
      note: "backend 自行压缩了上下文",
    });
  }

  if (fake.hang) {
    pending.set(executionId, () => finish(executionId, req, fake, "CANCELLED"));
    return; // 等 cancel
  }

  // 内核工具桥：逐个回调编排面，结果回填 diagnostics（P0-6）
  const kernelResults = [];
  for (const kc of fake.kernelToolCalls ?? []) {
    kernelResults.push({
      call: kc,
      result: await callKernelTool(executionId, kc.name, kc.arguments ?? {}),
    });
  }
  finish(executionId, req, fake, fake.termination ?? "DONE", kernelResults);
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
      out({
        type: "error",
        execution_id: msg.request?.execution_id,
        message: String(err),
      });
    });
    return;
  }

  if (msg.type === "kernel_tool_result") {
    const call = kernelPending.get(msg.tool_call_id);
    if (call) {
      kernelPending.delete(msg.tool_call_id);
      if (msg.error) call.reject(new Error(msg.error));
      else call.resolve(msg.result);
    }
    return;
  }

  if (msg.type === "cancel") {
    const done = pending.get(msg.execution_id);
    if (done) {
      pending.delete(msg.execution_id);
      done();
    }
    return;
  }

  out({ type: "error", message: `unknown message type: ${msg.type}` });
});

rl.on("close", () => process.exit(0));
