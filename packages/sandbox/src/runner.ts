/**
 * 运行器 —— 在某种隔离环境里跑一条命令行。
 *
 * 对应 FOUNDATION_V5.md §14.1 / §14.5。三种运行器同一形状：
 * **隔离环境里跑 argv + 挂一个目录**。差别只在隔离强度与网络控制。
 *
 * 运行器**只报事实**（退出码、是否超时、是否被杀），不做语义判断 ——
 * 「退出码 3 算 FAILED 还是 INVALID_OUTPUT」是 backend 的事（§14.6）。
 */

import { spawn } from "node:child_process";

export interface RunSpec {
  readonly argv: readonly string[];
  /** 沙箱根目录。命令的 cwd 落在 `<root>/workspace`。 */
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
  run(spec: RunSpec): Promise<RunOutcome>;
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
 * 本机运行器 —— **目录限定，不是隔离**。
 *
 * 只适合本机开发与离线测试：流氓 agent 能读出沙箱、能任意出网。
 * 真隔离要 docker / wsl（§14.5）。`isolates: false` 就是这条的机器可读形式。
 */
export class LocalRunner implements Runner {
  readonly kind = "local";
  readonly isolates = false;

  async run(spec: RunSpec): Promise<RunOutcome> {
    const [command, ...args] = spec.argv;
    if (command === undefined) throw new Error("argv 不能为空");

    const started = Date.now();
    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(command, args, {
        cwd: `${spec.root}/workspace`,
        env: { ...process.env, ...spec.env },
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
