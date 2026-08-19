/**
 * 运行器 —— 在某种隔离环境里跑一条命令行。
 *
 * 对应 FOUNDATION_V5.md §14.1 / §14.5。三种运行器同一形状：
 * **隔离环境里跑 argv + 挂一个目录**。差别只在隔离强度与网络控制。
 *
 * 运行器**只报事实**（退出码、是否超时、是否被杀），不做语义判断 ——
 * 「退出码 3 算 FAILED 还是 INVALID_OUTPUT」是 backend 的事（§14.6）。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunSpec {
  readonly argv: readonly string[];
  /**
   * **交给这条命令的目录**，cwd 落在 `<root>/workspace`。
   *
   * 不一定等于 `allocate()` 的返回值：调用方可以只交出一个子目录。
   * backend 就是这么做的 —— 只交 `box/`，把记录仓留在分配根下不给 agent
   * （见 layout.ts）。docker 按这个值决定挂什么，local 与 wsl 只能拿它当 cwd，
   * 挡不住 `cd ..`，这与它们 `isolates` 的实际含义一致。
   */
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
  /** 超时即杀 —— 这是 `ExecutionLimits.wallClockSeconds` 的真落点。 */
  readonly timeoutSeconds?: number;
  /** 取消。气密性仍靠 generation fence，这里只是 best effort（不变量 L3）。 */
  readonly signal?: AbortSignal;
}

export interface RunOutcome {
  /** 正常退出的码；被杀时为 null。 */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly wallClockSeconds: number;
}

export interface Runner {
  readonly kind: string;
  /** **是不是安全边界。**`local` 为 false —— 这条要一路透传到文档与告警。 */
  readonly isolates: boolean;

  /**
   * 能不能**强制**出网策略。
   *
   * 必填、不给默认值：默认成 true 就等于让"忘了实现"冒充"实现了"。
   * `local` / `wsl` 跟宿主机同一张网，只能声明不能强制 —— 它们报 false，
   * backend 把这条写进 diagnostics（§14.5）。
   */
  readonly enforcesNetwork: boolean;

  /**
   * 分配一个沙箱根，返回**宿主机可见**的路径（Node 的 fs 用它）。
   *
   * 沙箱住哪归 runner 管：`local` 放宿主机临时目录，`wsl` 放 **WSL 自己的
   * 文件系统**（宿主机通过 UNC 访问）。后者让 agent 拿到真 Linux 语义 ——
   * 大小写敏感、权限位、软链都对，不必绕 `/mnt/d` 那层 Windows 语义。
   *
   * 给了 `id` 就用**确定性路径**，沙箱因此可被再次找到 —— 这是"沙箱留着"
   * 的前提（跑完即删的时候随机名无所谓，留着的时候必须能对上是谁的）。
   * 不给就还是随机名。
   */
  allocate(id?: string): string;
  release(hostRoot: string): void;

  /** 跑 agent：带超时与取消。 */
  run(spec: RunSpec): Promise<RunOutcome>;

  /**
   * 宿主机路径 → **运行环境内**的路径。
   *
   * `local` 是恒等；`wsl` 把 UNC 翻成 Linux 路径。缺了这个，传给 git 的
   * `--git-dir` / `--work-tree` 会是宿主机路径，而 git 在 Linux 里跑 ——
   * 真跑 WSL 的测试第一次就撞到了这条。
   */
  toInner(hostPath: string): string;

  /**
   * 跑**辅助命令**（目前只有 git）。
   *
   * 单独一个口子，是为了让 git 跟 agent 在**同一个环境**里跑。
   * 否则 WSL 沙箱会被宿主机的 git 观察，换行、权限位、大小写全对不上 ——
   * 那正是"落在 Linux 上避免不一致"要躲的绕弯。
   *
   * **argv 与 cwd 一律用运行环境内的路径**（先经 `toInner`）。混用宿主机路径
   * 与内部路径是这块最容易出的错，所以这里只认一种。
   */
  exec(argv: readonly string[], innerCwd: string): string;
}

/**
 * 沙箱 id → 文件名安全的一段。
 *
 * id 由 `<traceid>/<executionId>` 拼成，含 `/`。**必须带上 traceid**：
 * 每个 Runtime 的 executionId 都从 `exec-1` 起，沙箱跑完即删时这不要紧，
 * 一旦留着就会在共享目录里真的撞名 —— 两个 run 的第一次执行抢同一个目录。
 */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/**
 * 确定性路径必须**先清空再用**。
 *
 * 沙箱留着之后，同一个 id 第二次分配会撞上上次的残留 —— 而基线是在物化之后打的，
 * 于是残留文件被算进基线，agent 这次真改的东西反而 diff 不出来。
 * （现有的 profile 测试正是这么炸的：断言 `made.txt` 是改动，实际空。）
 *
 * 清空意味着**同 id 的旧沙箱会被顶掉**。这是可接受的：id 由
 * `<traceid>/<executionId>` 拼成，同 id 就是同一次执行，后来者是重跑。
 * 真正的隐患是 executionId 并非全局唯一（每个 Runtime 从 exec-1 起），
 * 那条单独记着 —— 但"顶掉旧的"至少是**响的**失败，比错误的观测好。
 */
export function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 杀进程**树**。
 *
 * agent CLI 几乎一定会派生子进程（模型客户端、语言服务、shell）。只杀父进程
 * 会留下孤儿继续跑、继续写沙箱、继续烧钱 —— 超时与取消都会形同虚设。
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 透传给沙箱的宿主机环境变量白名单。
 *
 * 之前这里是 `{ ...process.env, ...spec.env }` —— 把**编排进程的整个环境**
 * 摊进每个本地沙箱。编排器持有的模型 API key、云凭据，对每个本地 agent
 * 全部可见。`DockerRunner` 与 `WslRunner` 都只传显式 env，唯独 `local` 漏。
 *
 * 不能简单删掉：agent CLI 需要 `PATH` 才找得到自己，需要 `HOME` 才读得到
 * 用户级配置。所以是白名单，不是全禁。
 *
 * **白名单而不是黑名单**：黑名单要求穷举所有敏感变量名，而密钥的命名千奇百怪
 * （`FOO_TOKEN`、`MY_SECRET`、`sk_live_…`），漏一个就等于没有。
 * 白名单漏一个只会让某个 agent 跑不起来 —— 一个吵闹的失败胜过一次静默的泄漏。
 */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  // Windows 上没有 PATH 之外这几个就起不了进程
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "TEMP",
  "TMP",
];

/** 按白名单筛出宿主机环境，再叠上显式 env。 */
export function filterEnv(
  hostEnv: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...explicit };
}

/**
 * 本机运行器 —— **目录限定，不是隔离**。
 *
 * 只适合本机开发与离线测试：流氓 agent 能读出沙箱、能任意出网。
 * 真隔离要 docker / wsl（§14.5）。`isolates: false` 就是这条的机器可读形式。
 */
export class LocalRunner implements Runner {
  readonly kind = "local";
  readonly isolates = false;
  readonly enforcesNetwork = false;
  readonly #prefix: string;

  constructor(workRoot: string = tmpdir()) {
    this.#prefix = join(workRoot, "hertaloy-box-");
  }

  allocate(id?: string): string {
    if (id === undefined) return mkdtempSync(this.#prefix);
    return freshDir(`${this.#prefix}${safeId(id)}`);
  }

  release(hostRoot: string): void {
    rmSync(hostRoot, { recursive: true, force: true });
  }

  /** 本机无需翻译。 */
  toInner(hostPath: string): string {
    return hostPath;
  }

  exec(argv: readonly string[], innerCwd: string): string {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("argv 不能为空");
    return execFileSync(command, args, {
      cwd: innerCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const [command, ...args] = spec.argv;
    if (command === undefined) throw new Error("argv 不能为空");

    const started = Date.now();
    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(command, args, {
        cwd: `${spec.root}/workspace`,
        // 白名单，不是整个 process.env —— 见 ENV_ALLOWLIST 的说明
        env: filterEnv(process.env, spec.env ?? {}),
        detached: process.platform !== "win32",
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      const timer =
        spec.timeoutSeconds === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              if (child.pid !== undefined) killTree(child.pid);
            }, spec.timeoutSeconds * 1000);

      const onAbort = (): void => {
        cancelled = true;
        if (child.pid !== undefined) killTree(child.pid);
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
        stderr += `\n启动失败：${err.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }
}
