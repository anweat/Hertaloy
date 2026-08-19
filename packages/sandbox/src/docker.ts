/**
 * docker 运行器 —— 目前唯一能**强制**出网策略的运行器。
 *
 * 对应 FOUNDATION_V5.md §14.1 / §14.5。与 wsl 的分工：
 *
 * | | wsl | docker |
 * |---|---|---|
 * | 文件系统隔离 | 有 | 有 |
 * | 真 Linux 语义 | 有 | 有 |
 * | **出网控制** | **无**（跟宿主机同一张网） | **有**（`--network`） |
 * | 环境可复现 | 装什么算什么 | 镜像即环境 |
 *
 * 一次 `run` = 一个一次性容器（`--rm`）。**没有常驻容器**：常驻就要管
 * 生命周期、健康检查、重启策略，而实例的生命周期已经由内核管了（C4），
 * 再来一套是第二套状态机。
 *
 * `exec`（git 观察）跑**另一个**一次性容器，挂同一个目录、且一律 `--network
 * none` —— 观察不需要网络，给了就是白给的攻击面。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type NetworkPolicy,
  ensureInternalNetwork,
  networkArgs,
  networkNameFor,
} from "./network.js";
import { freshDir, type RunOutcome, type RunSpec, type Runner, safeId } from "./runner.js";

export interface DockerOptions {
  /** 镜像即环境。默认一个带 git 的小镜像。 */
  readonly image?: string;
  readonly network?: NetworkPolicy;
  /** `internal` 时用哪张内网。一般由 `networkNameFor(根 traceid)` 给。 */
  readonly networkName?: string;
  /**
   * 容器内以谁的身份跑。
   *
   * **Linux 宿主机上不给会踩坑**：容器里的 root 写出来的文件在宿主机上也归
   * root，`release()` 删不掉，沙箱泄漏。给 `"<uid>:<gid>"` 就对上了。
   * Windows / macOS 的 Docker Desktop 由 VM 层做映射，不受影响。
   */
  readonly user?: string;
  readonly workRoot?: string;
  readonly docker?: string;
}

/** 沙箱在容器里的挂载父目录。每个沙箱一个唯一子目录 —— 好让 `toInner` 能反查。 */
const INNER_ROOT = "/sandbox";

const DEFAULT_IMAGE = "alpine/git:latest";

/**
 * 把 argv 变成"原样执行"的 docker 参数。
 *
 * **必须覆盖 ENTRYPOINT**：镜像的 entrypoint 会把 argv 当成自己的参数接在后面。
 * 默认镜像 `alpine/git` 的 entrypoint 就是 `git`，于是 `["cat","x"]` 变成
 * `git cat x` —— 第一次真起容器就撞上了。runner 的契约是**跑给定的命令行**，
 * 不是"跑镜像作者设想的那条"，所以这里一律显式接管。
 */
function splitArgv(argv: readonly string[]): {
  /** 放在**镜像名之前**：`--entrypoint <cmd>` */
  readonly flag: readonly string[];
  /** 放在**镜像名之后**：其余参数 */
  readonly rest: readonly string[];
} {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error("argv 不能为空");
  return { flag: ["--entrypoint", command], rest };
}

function slash(p: string): string {
  return p.split("\\").join("/");
}

export class DockerRunner implements Runner {
  readonly kind = "docker";
  readonly isolates = true;
  /** 与 local / wsl 的实质差别：这台能**强制**出网策略，那两台只能声明。 */
  readonly enforcesNetwork = true;
  readonly network: NetworkPolicy;

  readonly #image: string;
  readonly #networkName: string;
  readonly #user: string | undefined;
  readonly #prefix: string;
  readonly #docker: string;
  /** 宿主机路径 → 容器内路径。`toInner` / `exec` 都靠它反查。 */
  readonly #mounts = new Map<string, string>();

  constructor(options: DockerOptions = {}) {
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.network = options.network ?? "none";
    this.#networkName = options.networkName ?? networkNameFor("default");
    this.#user = options.user;
    this.#prefix = join(options.workRoot ?? tmpdir(), "hertaloy-box-");
    this.#docker = options.docker ?? "docker";
  }

  allocate(id?: string): string {
    const host =
      id === undefined ? mkdtempSync(this.#prefix) : freshDir(`${this.#prefix}${safeId(id)}`);
    this.#mounts.set(slash(host), `${INNER_ROOT}/${basename(host)}`);
    if (this.network === "internal") {
      ensureInternalNetwork(this.#networkName, (argv) => this.#cli(argv));
    }
    return host;
  }

  release(hostRoot: string): void {
    this.#mounts.delete(slash(hostRoot));
    rmSync(hostRoot, { recursive: true, force: true });
  }

  toInner(hostPath: string): string {
    const target = slash(hostPath);
    for (const [host, inner] of this.#mounts) {
      if (target === host) return inner;
      if (target.startsWith(`${host}/`)) return inner + target.slice(host.length);
    }
    throw new Error(`路径 ${hostPath} 不在任何已分配的沙箱里，无法翻译`);
  }

  /** 容器内路径 → 该沙箱的宿主机根。`exec` 要靠它知道挂什么。 */
  #hostRootOf(innerPath: string): string {
    for (const [host, inner] of this.#mounts) {
      if (innerPath === inner || innerPath.startsWith(`${inner}/`)) return host;
    }
    throw new Error(`容器内路径 ${innerPath} 不属于任何已分配的沙箱`);
  }

  exec(argv: readonly string[], innerCwd: string): string {
    const host = this.#hostRootOf(innerCwd);
    const inner = this.#mounts.get(host);
    if (inner === undefined) throw new Error(`沙箱 ${host} 已释放`);
    const { flag, rest } = splitArgv(argv);
    return this.#cli([
      "run",
      "--rm",
      "--network",
      "none", // 观察不需要网络
      ...(this.#user === undefined ? [] : ["--user", this.#user]),
      "-v",
      `${host}:${inner}`,
      "-w",
      innerCwd,
      ...flag,
      this.#image,
      ...rest,
    ]);
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    /**
     * 挂的是 `spec.root` **本身**，不是它所属的分配根。
     *
     * 于是调用方可以只交出一个子目录（backend 交的是 `box/`），
     * 而记录仓留在分配根下、不进容器。`exec`（git 观察）走另一个容器、
     * 挂整个分配根，所以它读得到记录仓 —— **两个容器挂不同的东西**，
     * 这正是"观察对象改不了观察记录"的落点。
     */
    const host = slash(spec.root);
    const inner = this.toInner(spec.root);

    const name = `hertaloy-${basename(host)}`;
    const envArgs = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const { flag, rest } = splitArgv(spec.argv);
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      ...networkArgs(this.network, this.#networkName),
      ...(this.#user === undefined ? [] : ["--user", this.#user]),
      ...envArgs,
      "-v",
      `${host}:${inner}`,
      "-w",
      `${inner}/workspace`,
      ...flag,
      this.#image,
      ...rest,
    ];

    const started = Date.now();
    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(this.#docker, args, { shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      /**
       * 杀容器，不是杀 `docker` 这个客户端。
       *
       * 杀掉本地的 docker CLI 只是断了它跟守护进程的连接，**容器照跑** ——
       * 跟 WSL 那条"另一个内核里的另一棵树"是同一类错。所以先 `docker kill`。
       */
      const kill = (): void => {
        try {
          this.#cli(["kill", name]);
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
        stderr += `\n启动 docker 失败：${err.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }

  #cli(argv: readonly string[]): string {
    return execFileSync(this.#docker, [...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/** 守护进程在不在（不只是 CLI 装没装）。 */
export function dockerAvailable(docker = "docker"): boolean {
  try {
    execFileSync(docker, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
