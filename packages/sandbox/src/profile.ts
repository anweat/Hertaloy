/**
 * Profile 渲染器 —— **把上下文渲染成各家 agent CLI 认识的文件**。
 *
 * 对应 FOUNDATION_V5.md §14.3。适配**不是特例代码，是配置**：
 * `claude` 认 `CLAUDE.md`，`codex` 认 `AGENTS.md`，我们自己的认 `.hertaloy/context/`。
 *
 * 最关键的一条：**让外部 agent 学会我们的输出契约，靠的就是注入本身**。
 * 我们不改 `claude`，只是往它读的文件里写一段"干完把结果写到 emit.json"。
 * 草稿 line 3 那句「之后调用直接上下文尾部补充，并落在 agent.md」说的就是这件事。
 *
 * 渲染出的路径**相对沙箱根**：`CLAUDE.md` 必须落在 `workspace/` 里 agent 才读得到，
 * 而它写在**打基线之前**，所以不会被 git 当成"agent 改的"。
 */

import type { Json } from "@nodeflow/contracts";

export interface ProfileInput {
  readonly vars: Readonly<Record<string, Json>>;
  readonly allowedEmitPorts: readonly string[];
  /** emit.json 相对 workspace 的路径 —— agent 的 cwd 就是 workspace。 */
  readonly emitPath: string;
  readonly artifactsDir: string;
  readonly traceid: string;
  readonly nodeId: string;
}

export interface Profile {
  readonly name: string;
  /** 相对**沙箱根**的路径 → 文件内容。 */
  render(input: ProfileInput): Readonly<Record<string, string>>;
}

/** 变量渲染成人读的段落。长文本直接放，短值以 JSON 呈现。 */
function renderVars(vars: Readonly<Record<string, Json>>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    parts.push(`## ${name}`, "", body, "");
  }
  return parts.join("\n");
}

/**
 * 输出契约说明 —— 注入给**不懂我们契约**的外部 agent。
 *
 * 端口是白名单，写别的会被内核判 INVALID_OUTPUT（第一不变量）。
 * 这段文字是"适配"的全部内容：不改 agent，只告诉它规矩。
 */
function emitInstruction(input: ProfileInput): string {
  return [
    "# 输出契约（必须遵守）",
    "",
    `干完之后，把结果写成 JSON 到 \`${input.emitPath}\`，形如：`,
    "",
    "```json",
    `{ ${JSON.stringify(input.allowedEmitPorts[0] ?? "out")}: { "你的结果": "……" } }`,
    "```",
    "",
    `顶层的键**只能**是这些端口之一：${input.allowedEmitPorts.map((p) => `\`${p}\``).join("、") || "（无）"}。`,
    "写别的端口名会被判为无效输出。",
    "",
    `需要留下版本化产物就写进 \`${input.artifactsDir}\`，目录里的每个文件会被收成一份资产。`,
    "",
    `本次执行：\`${input.traceid}\` 的节点 \`${input.nodeId}\`。`,
    "",
  ].join("\n");
}

function varsJson(input: ProfileInput): string {
  return `${JSON.stringify(input.vars, null, 2)}\n`;
}

/** 我们自己的 agent：原生懂契约，全放 `.hertaloy/context/`。 */
export const hertaloyAgentProfile: Profile = {
  name: "hertaloy-agent",
  render: (input) => ({
    ".hertaloy/context/vars.json": varsJson(input),
    ".hertaloy/context/contract.md": emitInstruction(input),
  }),
};

/** Claude Code：认 `CLAUDE.md`（必须在工作目录里）。 */
export const claudeCodeProfile: Profile = {
  name: "claude-code",
  render: (input) => ({
    "workspace/CLAUDE.md": [
      "# 本次任务上下文",
      "",
      renderVars(input.vars),
      emitInstruction(input),
    ].join("\n"),
    ".hertaloy/context/vars.json": varsJson(input),
  }),
};

/** Codex 一系：认 `AGENTS.md`。 */
export const codexProfile: Profile = {
  name: "codex",
  render: (input) => ({
    "workspace/AGENTS.md": [
      "# 本次任务上下文",
      "",
      renderVars(input.vars),
      emitInstruction(input),
    ].join("\n"),
    ".hertaloy/context/vars.json": varsJson(input),
  }),
};

export const PROFILES: Readonly<Record<string, Profile>> = {
  [hertaloyAgentProfile.name]: hertaloyAgentProfile,
  [claudeCodeProfile.name]: claudeCodeProfile,
  [codexProfile.name]: codexProfile,
};

export const PROFILE_NAMES: readonly string[] = Object.keys(PROFILES).sort();

export function resolveProfile(name: string): Profile {
  const found = PROFILES[name];
  if (found === undefined) {
    throw new Error(`未知 profile \u0060${name}\u0060。可用：${PROFILE_NAMES.join("、")}`);
  }
  return found;
}
