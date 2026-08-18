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

import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import type { RunOutcome, RunSpec, Runner } from "./runner.js";

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

export class WslRunner implements Runner {
  readonly kind = "wsl";
  /** 文件系统与进程隔离 —— 与 `local` 的实质差别就在这。 */
  readonly isolates = true;
  readonly #distro: string;
  readonly #innerRoot: string;

  constructor(options: WslOptions = {}) {
    this.#distro = options.distro ?? "Ubuntu";
    this.#innerRoot = options.innerRoot ?? "/tmp";
  }

  get distro(): string {
    return this.#distro;
  }

  allocate(): string {
    const inner = `${this.#innerRoot}/hertaloy-box-${Math.random().toString(36).slice(2, 10)}`;
    this.#wsl(["mkdir", "-p", inner]);
    return toHostPath(inner, this.#distro);
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
    const args = [
      "-d",
      this.#distro,
      "--cd",
      innerWorkspace,
      "--",
      ...(envPairs.length > 0 ? ["env", ...envPairs] : []),
      ...spec.argv,
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
       * 内核里的另一棵树。所以两边都要动：`pkill` 进去清，再杀本地的 wsl.exe。
       */
      const kill = (): void => {
        try {
          this.#wsl(["pkill", "-9", "-f", spec.argv.join(" ")]);
        } catch {
          /* 可能已经退了 */
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
