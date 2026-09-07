/**
 * WSL 运行器 —— 沙箱住在 **Linux 文件系统里**。
 *
 * 对应 FOUNDATION_V5.md §14.1 / §14.5。
 *
 * ```
 * 沙箱（WSL 内）   /tmp/hertaloy-abc
 * 宿主机可见       \wsl.localhost\Ubuntu\tmp\hertaloy-abc     ← Node 的 fs 走这个
 * 命令与 git       wsl -d Ubuntu --cd /tmp/hertaloy-abc/workspace -- …
 * ```
 *
 * **为什么不把沙箱放在 Windows 侧再挂 `/mnt/d`**：那样 agent 看到的是
 * Windows 文件系统语义 —— 大小写不敏感、没有权限位、软链行为不同。
 * 一个在 Linux 上写好的 agent 到这里会以各种奇怪方式失败。
 * 沙箱住在 WSL 自己的盘里，这些全对。
 *
 * 代价是宿主机的 fs 访问要走 UNC（9P 协议），比本地盘慢。对沙箱这点开销可接受。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { freshDir, locateSandbox, type RunOutcome, type RunSpec, type Runner, safeId } from "./runner.js";

export interface WslOptions {
  /** 发行版名。默认 `Ubuntu`。 */
  readonly distro?: string;
  /** 沙箱在 WSL 里的父目录。 */
  readonly innerRoot?: string;
}

/** UNC 前缀 ⇄ Linux 路径。`\\\\wsl.localhost\\Ubuntu\\tmp\\x` ⇄ `/tmp/x` */
const UNC_PREFIX = "\\\\wsl.localhost\\";

export function toInnerPath(hostPath: string, distro: string): string {
  const prefix = `${UNC_PREFIX}${distro}`;
  const normalized = hostPath.split("/").join("\\");
  if (!normalized.startsWith(prefix)) {
    throw new Error(`路径 ${hostPath} 不在 WSL 发行版 ${distro} 里，无法翻译`);
  }
  const rest = normalized.slice(prefix.length).split("\\").join("/");
  return rest === "" ? "/" : rest;
}

export function toHostPath(innerPath: string, distro: string): string {
  return `${UNC_PREFIX}${distro}${innerPath.split("/").join("\\")}`;
}

/** POSIX shell 单引号转义 —— 引号只在这里转一次，不经 wsl.exe 再解析一遍。 */
function shQuote(value: string): string {
  // 单引号内不能再有单引号：闭合 → 转义的字面单引号 → 重开，即 '\''
  return `'${value.split("'").join("'\\''")}'`;
}

export class WslRunner implements Runner {
  readonly kind = "wsl";
  /** 文件系统与进程隔离 —— 与 `local` 的实质差别就在这。 */
  readonly isolates = true;
  /** WSL 跟宿主机共用一张网，拦不住出网 —— 要控出网得用 docker。 */
  readonly enforcesNetwork = false;
  readonly #distro: string;
  readonly #innerRoot: string;

  constructor(options: WslOptions = {}) {
    this.#distro = options.distro ?? "Ubuntu";
    this.#innerRoot = options.innerRoot ?? "/tmp";
  }

  get distro(): string {
    return this.#distro;
  }

  #innerBox(suffix: string): string {
    return `${this.#innerRoot}/hertaloy-box-${suffix}`;
  }

  locate(id: string): string {
    return locateSandbox(toHostPath(this.#innerBox(""), this.#distro), id);
  }

  allocate(id?: string): string {
    const inner = this.#innerBox(
      id === undefined ? Math.random().toString(36).slice(2, 10) : safeId(id),
    );
    // 通过与 createSandbox 相同的 UNC 文件系统接口原子创建，绝不先 rm。
    return freshDir(toHostPath(inner, this.#distro), id);
  }

  release(hostRoot: string): void {
    try {
      this.#wsl(["rm", "-rf", toInnerPath(hostRoot, this.#distro)]);
    } catch {
      // 兜底：UNC 侧再删一次
      rmSync(hostRoot, { recursive: true, force: true });
    }
  }

  toInner(hostPath: string): string {
    return toInnerPath(hostPath, this.#distro);
  }

  /** argv 与 cwd 都已是 Linux 路径，直接透传。 */
  exec(argv: readonly string[], innerCwd: string): string {
    return this.#wsl([...argv], innerCwd);
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const innerWorkspace = `${toInnerPath(spec.root, this.#distro)}/workspace`;
    const started = Date.now();

    // 环境变量经 `env K=V …` 传进去 —— WSL 不继承宿主机的进程环境
    const envPairs = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);

    /**
     * 让本次执行**自成一个进程组**，并把组号写下来。
     *
     * 原来是取消时 `pkill -9 -f <完整 argv>`，一行里两个 bug：
     *
     *   1. 命令行不是身份。两个沙箱跑同一条命令时命令行一模一样，
     *      取消一个会把另一个也打掉 —— 而后者只是莫名其妙被杀。
     *   2. `pkill -f` 的模式是**正则**。argv 里带 `{}`（JSON、shell 花括号）
     *      时 pkill 直接 `regex error` 什么都没杀，而宿主机侧的 wsl.exe 被杀了：
     *      **外面报 CANCELLED，里面的 Linux 进程还活着。**
     *
     * `setsid --wait` 起一个新会话，`sh` 成为组长，`$$` 就是组号；`exec` 之后
     * 命令接替这个 pid，仍是组长。取消时 `kill -9 -<组号>` 打的是**这一组**，
     * 连带子进程一起 —— 比 pkill 精确，也比它覆盖得全。
     * `--wait` 让退出码照常透出来，否则 setsid 一 fork 就返回了。
     *
     * **启动脚本写成文件，不内联。**`wsl.exe` 会把 argv 拼成一条命令行再让
     * Linux 侧重新解析，嵌套引号过不去（实测 `exec "$@"` 里的 `$@` 是空的，
     * 报 `exec: : Permission denied`）。写成文件之后引号只在 Node 这边转义一次，
     * 传给 wsl 的参数是扁平的。
     *
     * 脚本与组号都放在 `box/` **之外**（沙箱根下），那一层不挂给 agent 容器。
     * 但 local/wsl 的 agent 本来就够得着整个文件系统（`isolates` 已如实报告
     * 这一点），所以这不是防篡改保证，只是不主动放进 agent 的工作目录。
     */
    const innerRoot = toInnerPath(spec.root, this.#distro);
    const pgidPath = `${innerRoot}/pgid`;
    const command = [...(envPairs.length > 0 ? ["env", ...envPairs] : []), ...spec.argv];
    writeFileSync(
      join(spec.root, "run.sh"),
      `echo $$ > ${shQuote(pgidPath)}
exec ${command.map(shQuote).join(" ")}
`,
      "utf8",
    );
    const args = [
      "-d",
      this.#distro,
      "--cd",
      innerWorkspace,
      "--",
      "setsid",
      "--wait",
      "sh",
      `${innerRoot}/run.sh`,
    ];

    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn("wsl", args, { shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      /**
       * 杀 WSL 里的进程树。
       *
       * 杀掉宿主机的 `wsl.exe` **不保证**里面的 Linux 进程也死 —— 那是另一个
       * 内核里的另一棵树。所以两边都要动：先按进程组清 Linux 侧，再杀 wsl.exe。
       */
      const kill = (): void => {
        try {
          /**
           * 组号在**宿主机侧**读（沙箱根经 UNC 就是同一个文件），
           * 传给 wsl 的是扁平参数 `kill -9 -<组号>`。
           *
           * 别在这儿写 `sh -c "p=$(cat …); kill …"`：`wsl.exe` 会把 argv 拼成
           * 一条命令行再让 Linux 侧重新解析，嵌套引号过不去 —— 启动那边已经
           * 栽过一次（`exec "$@"` 的 `$@` 是空的），这里同一个坑。
           *
           * 组号读不到（还没写下来 / 已经退了）就跳过，**不退回按命令行匹配** ——
           * 那正是要修掉的东西。
           */
          const pgid = readFileSync(join(spec.root, "pgid"), "utf8").trim();
          if (/^[0-9]+$/.test(pgid)) this.#wsl(["kill", "-9", `-${pgid}`]);
        } catch {
          /* 可能还没写下来，或者已经退了 */
        }
        child.kill("SIGKILL");
      };

      const timer =
        spec.timeoutSeconds === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill();
            }, spec.timeoutSeconds * 1000);

      const onAbort = (): void => {
        cancelled = true;
        kill();
      };
      spec.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onAbort);
        resolve({
          code,
          stdout,
          stderr,
          timedOut,
          cancelled,
          wallClockSeconds: (Date.now() - started) / 1000,
        });
      };

      child.on("error", (err) => {
        stderr += `\n启动 wsl 失败：${err.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }

  #wsl(argv: readonly string[], cwd?: string): string {
    const args = ["-d", this.#distro, ...(cwd === undefined ? [] : ["--cd", cwd]), "--", ...argv];
    return execFileSync("wsl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
}

/** WSL 里这个发行版在不在、能不能跑命令。 */
export function wslAvailable(distro = "Ubuntu"): boolean {
  try {
    execFileSync("wsl", ["-d", distro, "--", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
