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

import type { Json, ResourceKind } from "@nodeflow/contracts";

export interface ProfileInput {
  readonly vars: Readonly<Record<string, Json>>;
  readonly allowedEmitPorts: readonly string[];
  /** emit.json 相对 workspace 的路径 —— agent 的 cwd 就是 workspace。 */
  readonly emitPath: string;
  readonly artifactsDir: string;
  readonly traceid: string;
  readonly nodeId: string;
  /** 工作区从哪个具名源、哪个 commit 起的。没有工作区时不给。 */
  readonly workspace?: { readonly source: string; readonly base: string; readonly commit: string };
  /** 限额。**要告诉 agent** —— 它才好决定花多少力气。 */
  readonly limits?: {
    readonly tokenBudget?: number | undefined;
    readonly wallClockSeconds?: number | undefined;
  };
  /** `.hertaloy/resources/` 下有哪些别名可用。 */
  readonly resources?: readonly string[];
  /** 改动是否被沙箱外的 git 观察。 */
  readonly observed?: boolean;
}

export interface Profile {
  readonly name: string;
  /** 相对 **box**（agent 可见的那一层）的路径 → 文件内容。 */
  render(input: ProfileInput): Readonly<Record<string, string>>;
  /**
   * 一个资源别名该落在哪 —— **这就是「别名当宏」**。
   *
   * 同一个 `skill:code-review`，在 claude-code 下展开成
   * `workspace/.claude/skills/code-review/`，在我们自己的 agent 下展开成
   * `.hertaloy/skills/code-review/`。模板里只写那个名字，
   * **放哪由 profile 决定，不由模板决定** —— 于是同一份模板换个 agent 就能跑。
   *
   * 返回相对 box 的目录路径。
   */
  place(kind: ResourceKind, alias: string): string;
}

/**
 * 缺省放置：一律进 `.hertaloy/resources/<别名>/`。
 *
 * 不落 `workspace/`：工作树是**被观察的**，参考资料混进去会被算成 agent 的改动。
 */
function defaultPlace(_kind: ResourceKind, alias: string): string {
  return `.hertaloy/resources/${alias}`;
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
    ...environment(input),
    `本次执行：\`${input.traceid}\` 的节点 \`${input.nodeId}\`。`,
    "",
  ].join("\n");
}


/**
 * 环境交代 —— agent 干活前**必须知道**的几件事。
 *
 * 之前这一段是没有的：agent 不知道工作区是哪个 commit、不知道自己有多少预算、
 * 不知道有哪些参考资料、更不知道自己的每一次文件改动都被沙箱外的 git 记着。
 * 一个不知道这些的 agent 只能瞎猜 —— 而瞎猜的代价由预算和重试付。
 *
 * 尤其是**被观察**这条要明说。不是为了吓它，是因为"改了什么"会成为不可变的证据，
 * 它应该据此决定改动的粒度（一次做完 vs 边试边改）。
 */
function environment(input: ProfileInput): readonly string[] {
  const out: string[] = ["# 环境", ""];

  if (input.workspace !== undefined) {
    out.push(
      `工作区是具名源 \`${input.workspace.source}\` 的一份克隆，起点 ` +
        `\`${input.workspace.base}\`（${input.workspace.commit.slice(0, 12)}）。` +
        "直接在里面改，不必也不要去动 remote。",
    );
  } else {
    out.push("工作区是空目录 —— 本次任务不基于任何仓库。");
  }

  if (input.resources !== undefined && input.resources.length > 0) {
    out.push(
      "",
      `参考资料在 \`../.hertaloy/resources/\` 下：${input.resources
        .map((r) => `\`${r}\``)
        .join("、")}。它们**只读参考**，改了不会被收走。`,
    );
  }

  const limits: string[] = [];
  if (input.limits?.tokenBudget !== undefined) {
    limits.push(`token 预算 ${String(input.limits.tokenBudget)}`);
  }
  if (input.limits?.wallClockSeconds !== undefined) {
    limits.push(`墙钟上限 ${String(input.limits.wallClockSeconds)} 秒（超时进程会被杀）`);
  }
  if (limits.length > 0) out.push("", `限额：${limits.join("，")}。`);

  if (input.observed === true) {
    out.push(
      "",
      "**你对工作区的每一次改动都被沙箱外的 git 记录**，形成不可变的快照。" +
        "这不是监视，是产出的凭据 —— 改动会被原样保留下来供人复查。",
    );
  }

  out.push("");
  return out;
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
  // 我们自己的 agent 原生懂契约，技能与 MCP 都从 .hertaloy 下读
  place: (kind, alias) =>
    kind === "skill"
      ? `.hertaloy/skills/${alias}`
      : kind === "mcp"
        ? `.hertaloy/mcp/${alias}`
        : defaultPlace(kind, alias),
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
  /**
   * Claude Code 认 `workspace/.claude/` 下的技能与 `.mcp.json`。
   * 技能必须在**工作目录内**才被发现 —— 这是它的约定，不是我们的选择。
   */
  place: (kind, alias) =>
    kind === "skill"
      ? `workspace/.claude/skills/${alias}`
      : kind === "mcp"
        ? `workspace/.claude/mcp/${alias}`
        : defaultPlace(kind, alias),
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
  /**
   * Codex 没有标准的技能目录 —— **不编一个**。落回缺省位置，
   * 并在环境交代里告诉 agent 去哪找。假装它有约定，只会让技能静默不生效。
   */
  place: defaultPlace,
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
