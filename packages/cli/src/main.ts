#!/usr/bin/env node
/**
 * hertaloy —— 命令行入口。
 *
 * 两类命令：
 *
 *   无状态（进程内跑完就完）
 *     validate <template.json>   干跑校验，不落库  ← G1 自我修正的出口
 *     run <scenario.json>        一次性跑完并报告
 *
 *   有状态（作用在磁盘上的 run，见 §17）
 *     status / show / history / send / drain
 *
 *   人的放行没有专用命令：`status` 看谁在等，`send` 投消息放行（第四次归约）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, validate } from "./commands.js";
import { nodeIO, openAiClient, runAgent, runExec, spawnRunner } from "./agent.js";
import { diagnose, formatChecks } from "./doctor.js";
import type { ExecutionBackend, Principal } from "@nodeflow/contracts";
import { DockerRunner, LocalRunner, SandboxBackend, WslRunner } from "@nodeflow/sandbox";
import { loadResources } from "@nodeflow/state";
import {
  type CommandResult,
  drain,
  history,
  init,
  permissions,
  reclaim,
  resources,
  send,
  show,
  status,
  truncate,
  why,
} from "./state-commands.js";

const USAGE = `hertaloy —— Nodeflow V5 命令行

用法：
  hertaloy doctor                     环境自检（node / git / wsl / docker / profiles）
  hertaloy validate <template.json>   校验容器模板，不落库
  hertaloy run <scenario.json>        跑一个一次性场景并打印报告
  hertaloy agent [--dry-run]          在沙箱里跑我们自己的 agent（读契约目录）
       配置来自环境：HERTALOY_BASE_URL / HERTALOY_MODEL / HERTALOY_API_KEY
  hertaloy agent --exec <命令...>     把任意命令行包成合规节点（不调模型）
       退出 0 → ok 端口；非 0 → err 端口，没声明 err 就是真失败

作用在磁盘上的 run（<dir> 是状态目录）：
  hertaloy init    <dir> <scenario.json>        从场景文件建一个持久化的 run
  hertaloy status  <dir>                        实例树 / 阻塞原因 / 在途消息 / 死锁
  hertaloy show    <dir> <object-id[@n]>        读一个对象版本
  hertaloy history <dir> <object-id>            某对象的版本历史
  hertaloy send    <dir> <traceid> <node> <port> [json]   投一条消息（人的放行走这条）
  hertaloy drain   <dir> [--runner local|wsl|docker]  推进到静止
       不给 --runner 就没有执行面：agent 节点不会被推进
  hertaloy why     <dir> <message-id>           这条消息由哪些消息导致（因果反查）
  hertaloy reclaim <dir> [保留个数]             回收沙箱，默认保留最近 5 个
  hertaloy permissions <dir> [init]             看授权表；加 init 写出一份可改的
  hertaloy resources <dir> [add|remove ...]     看/登记资源别名（动态上载）
       add <别名> <git|dir|skill|mcp> <路径> [说明]
  hertaloy truncate <dir> <traceid> [原因]      强制截断实例及其子树

输出：任何有状态命令可加 --json，打印机器可读的结果（流程驱动流程时读它）。

主体：任何命令可加 --as <principal>（如 --as agent:coder-1），默认 human:local。
授权来自状态目录下的 permissions.json；没有该文件时缺省为「人类全权，agent 无权」。

场景文件形如：
  { "templates": [{"id": "root", "kind": "root_config", "spec": {…}}],
    "root": {"template": "root", "id": "job-1"},
    "send": [{"traceid": "job-1", "node": "n", "port": "in", "payload": {}}] }
`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** 有状态命令。参数不够就返回用法错误，而不是往下掉进"读文件"那条路。 */
async function statefulCommand(
  command: string,
  args: readonly string[],
  actor: Principal,
  runner: string | undefined,
): Promise<CommandResult | null> {
  const [dir, a, b, c, d] = args;
  const need = (n: number): CommandResult | null =>
    args.length < n ? { text: `\`${command}\` 参数不够。

${USAGE}`, code: 2 } : null;

  switch (command) {
    case "status":
      return need(1) ?? status(dir as string, actor);
    case "show":
      return need(2) ?? show(dir as string, actor, a as string);
    case "history":
      return need(2) ?? history(dir as string, actor, a as string);
    case "drain":
      return need(1) ?? (await drain(dir as string, actor, makeBackend(runner, dir as string)));
    case "init": {
      const short = need(2);
      if (short !== null) return short;
      try {
        return init(dir as string, actor, readJson(a as string));
      } catch (error) {
        return { text: `读不了 ${String(a)}：${(error as Error).message}`, code: 2 };
      }
    }
    case "reclaim": {
      const short = need(1);
      if (short !== null) return short;
      const keep = a === undefined ? 5 : Number(a);
      if (!Number.isInteger(keep) || keep < 0) {
        return { text: `reclaim 的保留个数要是非负整数，收到 ${String(a)}`, code: 2 };
      }
      return reclaim(dir as string, actor, keep);
    }
    case "resources": {
      const short = need(1);
      if (short !== null) return short;
      const op = a === "add" ? "add" : a === "remove" ? "remove" : "list";
      return resources(dir as string, actor, op, args.slice(2));
    }
    case "permissions":
      return need(1) ?? permissions(dir as string, actor, a === "init");
    case "why":
      return need(2) ?? why(dir as string, actor, a as string);
    case "truncate":
      return need(2) ?? truncate(dir as string, actor, a as string, b ?? "人工截断");
    case "send": {
      const short = need(4);
      if (short !== null) return short;
      let payload: unknown = {};
      if (d !== undefined) {
        try {
          payload = JSON.parse(d);
        } catch (error) {
          return { text: `载荷不是合法 JSON：${(error as Error).message}`, code: 2 };
        }
      }
      return send(dir as string, actor, a as string, b as string, c as string, payload as never);
    }
    default:
      return null;
  }
}

/**
 * 解析 `--as <principal>`，并把它从参数里摘掉。
 *
 * 默认 `human:local`：本机开发工具，人是操作者。**agent 必须显式指定** ——
 * 它的每一份权限都得是给出来的，不是默认带的（第一不变量）。
 */
/** 摘出一个开关（没有值），返回它在不在与剩余参数。 */
function extractSwitch(
  argv: readonly string[],
  flag: string,
): { readonly present: boolean; readonly rest: readonly string[] } {
  const i = argv.indexOf(flag);
  if (i === -1) return { present: false, rest: argv };
  return { present: true, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
}

/**
 * 输出。`--json` 时打印机器可读的那一份。
 *
 * **没有 `data` 的命令在 `--json` 下退出码 2 并说清楚**，不悄悄打印空对象 ——
 * 一条流程照着空对象往下走，比当场报错难查得多。
 */
function emit(result: CommandResult, json: boolean): number {
  if (!json) {
    (result.code === 0 ? process.stdout : process.stderr).write(`${result.text}\n`);
    return result.code;
  }
  if (result.data === undefined) {
    process.stderr.write(
      JSON.stringify({ error: "这条命令还没有 JSON 形态", text: result.text }) + "\n",
    );
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  return result.code;
}

/** 摘出 `--flag value`，返回值与剩余参数。 */
function extractFlag(
  argv: readonly string[],
  flag: string,
): { readonly value: string | undefined; readonly rest: readonly string[] } {
  const i = argv.indexOf(flag);
  if (i === -1) return { value: undefined, rest: argv };
  const value = argv[i + 1];
  if (value === undefined) throw new Error(`${flag} 后面要跟一个值`);
  return { value, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

function extractActor(argv: readonly string[]): {
  readonly actor: Principal;
  readonly rest: readonly string[];
} {
  const i = argv.indexOf("--as");
  if (i === -1) return { actor: { kind: "human", id: "local" }, rest: argv };
  // `--as` 写了却没跟值 → 报错。静默回退成默认的 human:local 意味着
  // 一条本想降权执行的命令**以全权跑了**，而且不留痕迹。
  if (argv[i + 1] === undefined) throw new Error("--as 后面要跟一个主体，如 human:alice");
  const raw = argv[i + 1] as string;
  // 不用 split(":", 2)：JS 的 limit 是**丢弃**多余部分，不是合并 ——
  // `agent:a:b` 会被截成 id="a"，与授权表里的 `agent:a:b` 永远对不上
  const sep = raw.indexOf(":");
  const kind = sep === -1 ? raw : raw.slice(0, sep);
  const id = sep === -1 ? undefined : raw.slice(sep + 1);
  const known = ["human", "agent", "system", "service"] as const;
  if (!known.includes(kind as (typeof known)[number]) || id === undefined || id === "") {
    throw new Error(`--as 形如 human:alice / agent:coder-1，收到 ${raw}`);
  }
  return {
    actor: { kind: kind as Principal["kind"], id },
    rest: [...argv.slice(0, i), ...argv.slice(i + 2)],
  };
}

/**
 * 执行面。**不给 `--runner` 就没有执行面** —— agent 节点不被推进。
 *
 * 默认不给，是因为跑 agent 意味着起进程、可能出网、可能花钱。
 * 这种事不该是某个 flag 忘了写就悄悄发生的默认值。
 */
function makeBackend(runner: string | undefined, dir: string): ExecutionBackend | undefined {
  if (runner === undefined) return undefined;
  /**
   * 沙箱落在**状态目录下**，不是系统临时目录。
   *
   * 跑完就删的时候放 tmp 没问题；留着就不行 —— 一次重启、一次系统清理，
   * 现场就没了，而"现场还在"正是留它的全部理由。
   *
   * wsl 是例外：沙箱必须住在 Linux 文件系统里才有真 Linux 语义（§14.1），
   * 所以它仍由 runner 自己定位置，状态目录只管另外两个。
   */
  const workRoot = join(dir, "sandboxes");
  // 资源注册表从状态目录读 —— 登记过的别名才用得上（动态上载的另一半）
  const opts = { resources: loadResources(dir).registry };
  switch (runner) {
    case "local":
      return new SandboxBackend({ ...opts, runner: new LocalRunner(workRoot) });
    case "wsl":
      return new SandboxBackend({ ...opts, runner: new WslRunner() });
    case "docker":
      return new SandboxBackend({ ...opts, runner: new DockerRunner({ workRoot }) });
    default:
      throw new Error(`未知运行器 ${runner}，可选 local / wsl / docker`);
  }
}

/**
 * `hertaloy agent` —— 在沙箱里跑我们自己的 agent。
 *
 * 配置全从**环境变量**来，一个都不从配置文件来：密钥绝不落盘（§17.7），
 * 而 base URL 与 model 跟着密钥一起走最不容易配错。
 * backend 通过 `AgentSpec.env` 把它们注入沙箱。
 */
async function runOwnAgent(argv: readonly string[]): Promise<number> {
  const io = nodeIO(process.cwd());

  /**
   * `--exec` 把**任意命令行**包成合规节点 —— `git commit`、`pnpm test`、
   * `codegraph index` 都不必先套一个模型。`--exec` 之后的全部参数即命令。
   */
  const execAt = argv.indexOf("--exec");
  if (execAt !== -1) return await runExec(io, argv.slice(execAt + 1), spawnRunner());

  const dry = argv.includes("--dry-run");

  if (dry) {
    /**
     * 空跑：不调模型，按契约写一份最小合法输出。
     *
     * 给两种场合用 —— 验沙箱链路本身通不通，以及在没有密钥的机器上
     * 让端到端测试能跑。它走的是**与真跑完全相同**的校验与落盘路径。
     */
    return await runAgent(io, {
      complete: async () => {
        const req = JSON.parse(io.read("../.hertaloy/request.json")) as {
          allowedEmitPorts: string[];
        };
        return JSON.stringify({
          emit: { [req.allowedEmitPorts[0] ?? "out"]: { dryRun: true } },
          artifacts: [],
          notes: "空跑：没有调用模型",
        });
      },
    });
  }

  const baseUrl = process.env.HERTALOY_BASE_URL;
  const model = process.env.HERTALOY_MODEL;
  const apiKey = process.env.HERTALOY_API_KEY;
  if (baseUrl === undefined || model === undefined || apiKey === undefined) {
    process.stderr.write(
      "缺少配置：需要 HERTALOY_BASE_URL / HERTALOY_MODEL / HERTALOY_API_KEY。" +
        "它们由 AgentSpec.env 注入沙箱；密钥不进任何配置文件。" +
"\n（只想验链路就加 --dry-run）\n",
    );
    return 2;
  }
  return await runAgent(io, openAiClient({ baseUrl, model, apiKey }));
}

async function main(rawArgv: readonly string[]): Promise<number> {
  let actor: Principal;
  let argv: readonly string[];
  let runner: string | undefined;
  let json = false;
  try {
    ({ actor, rest: argv } = extractActor(rawArgv));
    ({ value: runner, rest: argv } = extractFlag(argv, "--runner"));
    ({ rest: argv, present: json } = extractSwitch(argv, "--json"));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}
`);
    return 2;
  }
  const [command, file] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "agent") return await runOwnAgent(argv.slice(1));
  if (command === "doctor") {
    const checks = diagnose();
    const blocked = checks.some((c) => !c.ok && c.blocking);
    (blocked ? process.stderr : process.stdout).write(`${formatChecks(checks)}
`);
    return blocked ? 1 : 0;
  }
  const rest = argv.slice(1);
  const stateful = await statefulCommand(command, rest, actor, runner);
  if (stateful !== null) return emit(stateful, json);

  if (file === undefined) {
    process.stderr.write(`缺少文件参数。\n\n${USAGE}`);
    return 2;
  }

  let payload: unknown;
  try {
    payload = readJson(file);
  } catch (error) {
    process.stderr.write(`读不了 ${file}：${(error as Error).message}\n`);
    return 2;
  }

  const result =
    command === "validate" ? validate(payload) : command === "run" ? run(payload) : null;

  if (result === null) {
    process.stderr.write(`未知命令 \`${command}\`。\n\n${USAGE}`);
    return 2;
  }
  (result.code === 0 ? process.stdout : process.stderr).write(`${result.text}\n`);
  return result.code;
}

process.exitCode = await main(process.argv.slice(2));
