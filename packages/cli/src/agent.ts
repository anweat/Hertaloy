/**
 * `hertaloy agent` —— 我们自己的 agent 命令行（批 A2，平权的另一半）。
 *
 * 它与 `claude` / `codex` **完全同级**：同一个沙箱、同一份契约目录、
 * 同一条 argv。第五次归约说"agent 就是命令行"，这个就是那句话的自证 ——
 * 如果我们自己的 agent 需要任何特殊通道，那条归约就是假的。
 *
 * 那它凭什么存在？**因为它原生懂契约，于是能做外部 CLI 做不到的三件事**：
 *
 * 1. **资产置入**：产物名在写出去之前就按内核的规则校验（多级标识符路径、
 *    不含 `..`）。外部 agent 只能等内核拒绝，整次执行作废；我们当场改。
 * 2. **网络适配**：读得到 `environment.networkEnforced`，出网被挡时直接
 *    告诉模型"别想着查文档"，而不是让它试到超时。
 * 3. **原生接触数据**：变量、资源落点、端口白名单都是**结构化**读进来的，
 *    不经过 markdown 渲染那一层损耗。
 *
 * 还有一条最实在的：**本地自校验重试**。模型选了没声明的端口时，
 * 在沙箱里就把错误喂回去重来一次 —— 一次内核级 attempt 都不烧。
 * 这与 G1 的自我修正是同一个循环，只是发生在更内层。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** 沙箱契约目录里 `request.json` 的形状（backend 写、agent 读）。 */
export const AgentRequest = z
  .object({
    executionId: z.string(),
    traceid: z.string(),
    nodeId: z.string(),
    allowedEmitPorts: z.array(z.string()),
    limits: z
      .object({ tokenBudget: z.number().optional(), wallClockSeconds: z.number().optional() })
      .partial()
      .default({}),
    emitPath: z.string(),
    artifactsDir: z.string(),
    environment: z
      .object({
        networkEnforced: z.boolean(),
        isolates: z.boolean(),
        runner: z.string(),
      })
      .optional(),
    resources: z.record(z.string()).default({}),
  })
  .passthrough();

export type AgentRequest = z.infer<typeof AgentRequest>;

/** 模型该还给我们的东西。**端口是白名单，产物名有规则。** */
export const AgentResponse = z
  .object({
    emit: z.record(z.unknown()),
    artifacts: z
      .array(z.object({ name: z.string(), content: z.string() }).strict())
      .default([]),
    notes: z.string().optional(),
  })
  .strict();

export type AgentResponse = z.infer<typeof AgentResponse>;

/**
 * 产物名规则 —— **与内核的 `namespacedId` 同一条**。
 *
 * 在这里先校验，是为了让"名字不合规"在沙箱内就被改掉，而不是等内核把
 * 整次执行判成 INVALID_OUTPUT。外部 agent 没有这一层，所以它们更容易整次作废。
 */
const ASSET_SEGMENT = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function checkAssetName(name: string): string | null {
  if (name === "") return "产物名不能为空";
  for (const seg of name.split("/")) {
    if (seg === ".." || !ASSET_SEGMENT.test(seg)) {
      return `产物名 ${JSON.stringify(name)} 非法：只允许多级标识符路径，不得含空段或 \`..\``;
    }
  }
  return null;
}

/** 校验模型输出。**不合规就带着理由回去重来**，不写盘。 */
export function validateResponse(
  raw: unknown,
  allowedEmitPorts: readonly string[],
): { ok: true; value: AgentResponse } | { ok: false; reason: string } {
  const parsed = AgentResponse.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `输出结构不对：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
    };
  }
  const ports = Object.keys(parsed.data.emit);
  const bad = ports.filter((p) => !allowedEmitPorts.includes(p));
  if (bad.length > 0) {
    return {
      ok: false,
      reason:
        `端口 ${bad.map((p) => `\`${p}\``).join("、")} 没有声明。` +
        `只能用：${allowedEmitPorts.map((p) => `\`${p}\``).join("、") || "（无）"}。`,
    };
  }
  for (const a of parsed.data.artifacts) {
    const issue = checkAssetName(a.name);
    if (issue !== null) return { ok: false, reason: issue };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 组装给模型的提示。**纯函数**，所以"告诉了模型什么"是可测的 ——
 * 这套东西最容易出错的地方就是提示里少说了一句关键的。
 */
export function buildPrompt(
  request: AgentRequest,
  vars: Readonly<Record<string, unknown>>,
  retryReason?: string,
): string {
  const out: string[] = [
    "你是一个在受控沙箱里干活的 agent。工作目录是 `workspace/`，改动会被沙箱外的 git 记录。",
    "",
    "# 任务变量",
    "",
    "```json",
    JSON.stringify(vars, null, 2),
    "```",
    "",
    "# 输出格式（必须严格遵守）",
    "",
    "只回一个 JSON 对象，不要包在代码块里，不要有别的话：",
    "",
    "```json",
    JSON.stringify(
      {
        emit: { [request.allowedEmitPorts[0] ?? "out"]: { 结果: "……" } },
        artifacts: [{ name: "report", content: "要留档的正文" }],
        notes: "可选，给人看的一句话",
      },
      null,
      2,
    ),
    "```",
    "",
    `\`emit\` 的键**只能**是：${request.allowedEmitPorts.map((p) => `\`${p}\``).join("、") || "（无）"}。`,
    "`artifacts` 的 `name` 只能是多级标识符路径（如 `report` 或 `docs/api`），不得含 `..`。",
    "",
  ];

  const env = request.environment;
  if (env !== undefined) {
    out.push("# 环境", "");
    out.push(
      env.networkEnforced
        ? "**没有外网**。别去装依赖、别去查文档 —— 拿不到的东西直接说拿不到，比试到超时好。"
        : `出网未被强制限制（运行器 ${env.runner}）。但仍应把网络当作可能不可达。`,
    );
    if (!env.isolates) {
      out.push("注意：当前运行器**不是安全边界**，只做了目录限定。别做有副作用的事。");
    }
    out.push("");
  }

  const resources = Object.entries(request.resources);
  if (resources.length > 0) {
    out.push("# 可用资料", "");
    for (const [alias, rel] of resources) out.push(`- \`${alias}\` → \`${rel}\``);
    out.push("", "它们是只读参考，改了不会被收走。", "");
  }

  const limits: string[] = [];
  if (request.limits.tokenBudget !== undefined) {
    limits.push(`token 预算 ${String(request.limits.tokenBudget)}`);
  }
  if (request.limits.wallClockSeconds !== undefined) {
    limits.push(`墙钟 ${String(request.limits.wallClockSeconds)} 秒后进程会被杀`);
  }
  if (limits.length > 0) out.push(`# 限额`, "", limits.join("，") + "。", "");

  if (retryReason !== undefined) {
    out.push(
      "# 上一次的输出被拒绝",
      "",
      retryReason,
      "",
      "**照着上面的格式重来一次。**",
      "",
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------

/**
 * **把任意命令行包成一个合规的 agent 节点** —— `hertaloy agent --exec <命令>`。
 *
 * 第五次归约说"agent 就是命令行"。反过来推论就是：`git commit`、
 * `codegraph index`、`pnpm test` 这些**本身就是命令行的东西，
 * 不该为了当一个节点而先套一个模型**。它们缺的只是"按契约写 emit.json"。
 *
 * 出口按退出码选，而**端口仍然是白名单**：
 *
 *   退出 0     → `ok` 端口（没声明就用第一个允许的）
 *   退出非 0   → `err` 端口（**没声明就真失败**，让内核按 FAILED 重试）
 *
 * 最后半句是有意的：失败没有声明出口时不该被悄悄路由成"成功走了另一条边"。
 * 想处理失败就显式声明 `err` 端口 —— 这样"这条流程会怎么处理失败"
 * 写在模板里看得见，而不是藏在某个默认行为里。
 *
 * 条件分支因此仍然落在端口 + 边上（M1 没被绕过）：
 * exec 节点只是**选端口**，路由还是边说了算。
 */
export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<ExecOutcome>;

/** 退出码 → 走哪个端口。返回 null 表示"没有出口，这是真失败"。 */
export function pickExecPort(
  code: number,
  allowedEmitPorts: readonly string[],
): string | null {
  if (code === 0) {
    return allowedEmitPorts.includes("ok") ? "ok" : (allowedEmitPorts[0] ?? null);
  }
  return allowedEmitPorts.includes("err") ? "err" : null;
}

const TAIL = 4000;

/** 只留尾部 —— 一次 `pnpm test` 的输出能有几兆，全塞进消息载荷没意义。 */
function tail(text: string): string {
  return text.length <= TAIL ? text : `…（略去前 ${String(text.length - TAIL)} 字）
${text.slice(-TAIL)}`;
}

export async function runExec(
  io: AgentIO,
  argv: readonly string[],
  run: CommandRunner,
): Promise<number> {
  let request: AgentRequest;
  try {
    request = AgentRequest.parse(JSON.parse(io.read("../.hertaloy/request.json")));
  } catch (error) {
    io.log(`读不到契约：${(error as Error).message}`);
    return 2;
  }
  if (argv.length === 0) {
    io.log("--exec 后面要跟一条命令");
    return 2;
  }

  const outcome = await run(argv, io.cwd);
  const port = pickExecPort(outcome.code, request.allowedEmitPorts);
  if (port === null) {
    io.log(
      `命令退出 ${String(outcome.code)}，而本节点没有声明 \`err\` 端口 —— ` +
        `按真失败处理。想在流程里处理失败就显式声明一个 err 端口。
${tail(outcome.stderr)}`,
    );
    return outcome.code === 0 ? 1 : outcome.code;
  }

  io.write(
    request.emitPath,
    `${JSON.stringify(
      { [port]: { exitCode: outcome.code, stdout: tail(outcome.stdout), stderr: tail(outcome.stderr) } },
      null,
      2,
    )}
`,
  );
  return 0;
}

/**
 * 真的起进程。`shell: false` —— argv 原样执行，不被 shell 二次解释。
 *
 * 这与运行器的选择一致：让 shell 插一脚意味着模板里的一个字符串
 * 可能变成三条命令，而模板是 agent 也能写的东西。
 */
export function spawnRunner(): CommandRunner {
  return async (argv, cwd) =>
    await new Promise<ExecOutcome>((resolve) => {
      const [command, ...rest] = argv;
      const child = spawn(command as string, rest, { cwd, shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export interface ModelClient {
  complete(prompt: string): Promise<string>;
}

export interface AgentIO {
  readonly cwd: string;
  read(rel: string): string;
  write(rel: string, content: string): void;
  exists(rel: string): boolean;
  log(line: string): void;
}

export function nodeIO(cwd: string): AgentIO {
  return {
    cwd,
    read: (rel) => readFileSync(join(cwd, rel), "utf8"),
    write: (rel, content) => {
      const target = join(cwd, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    },
    exists: (rel) => existsSync(join(cwd, rel)),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

/**
 * OpenAI 兼容的最小客户端。
 *
 * 只认 `chat/completions` —— 换供应商改 base URL 与 model 即可，
 * **不为每家写一个适配器**（那正是第五次归约删掉的 Backend 矩阵）。
 * 密钥从环境变量来，不从任何配置文件来（§17.7）。
 */
export function openAiClient(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
}): ModelClient {
  return {
    async complete(prompt: string): Promise<string> {
      const res = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`模型返回 ${String(res.status)}：${(await res.text()).slice(0, 400)}`);
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("模型响应里没有 choices[0].message.content");
      return text;
    },
  };
}

/** 从模型回答里挖出 JSON —— 它常常还是会包一层代码块。 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  return JSON.parse(candidate) as unknown;
}

export interface AgentOptions {
  /** 本地自校验重试次数。**这是原生 agent 的主要价值** —— 见文件头。 */
  readonly maxAttempts?: number;
}

/**
 * 跑一次。返回退出码：0 成功，非 0 由 backend 判成 FAILED / INVALID_OUTPUT。
 *
 * 契约路径**全部从 request.json 读**，一个都不硬编码 ——
 * 硬编码就意味着契约改了这里不知道，而那正好是上一轮撞到的坑。
 */
export async function runAgent(
  io: AgentIO,
  client: ModelClient,
  options: AgentOptions = {},
): Promise<number> {
  let request: AgentRequest;
  try {
    request = AgentRequest.parse(JSON.parse(io.read("../.hertaloy/request.json")));
  } catch (error) {
    io.log(`读不到契约：${(error as Error).message}`);
    return 2;
  }

  const vars = io.exists("../.hertaloy/context/vars.json")
    ? (JSON.parse(io.read("../.hertaloy/context/vars.json")) as Record<string, unknown>)
    : {};

  const maxAttempts = options.maxAttempts ?? 2;
  let reason: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let text: string;
    try {
      text = await client.complete(buildPrompt(request, vars, reason));
    } catch (error) {
      io.log(`模型调用失败：${(error as Error).message}`);
      return 1;
    }

    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch {
      reason = "上次回的不是合法 JSON。只回一个 JSON 对象，不要有别的话。";
      io.log(`第 ${String(attempt)} 次：${reason}`);
      continue;
    }

    const checked = validateResponse(raw, request.allowedEmitPorts);
    if (!checked.ok) {
      reason = checked.reason;
      io.log(`第 ${String(attempt)} 次被本地校验拦下：${reason}`);
      continue;
    }

    // 校验通过才落盘 —— 半份输出比没有输出更难查
    for (const a of checked.value.artifacts) {
      io.write(`${request.artifactsDir}/${a.name}`, a.content);
    }
    io.write(request.emitPath, `${JSON.stringify(checked.value.emit, null, 2)}\n`);
    if (checked.value.notes !== undefined) io.log(checked.value.notes);
    return 0;
  }

  io.log(`本地重试 ${String(maxAttempts)} 次仍未通过校验，放弃。最后一次：${reason ?? "未知"}`);
  return 1;
}
