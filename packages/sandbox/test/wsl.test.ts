/**
 * S6：WSL 运行器（FOUNDATION_V5.md §14.1 / §14.5）。
 *
 * 路径映射是纯函数，永远跑；真跑 WSL 的部分在没装发行版时自动跳过。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionRequest } from "@nodeflow/contracts";
import { SandboxBackend, type SandboxDiagnostics } from "../src/backend.js";
import { createSandbox } from "../src/layout.js";
import { WslRunner, toHostPath, toInnerPath, wslAvailable } from "../src/wsl.js";

const HAS_WSL = wslAvailable("Ubuntu");

describe("路径映射（纯函数）", () => {
  // 反斜杠字面量在这条工具链上会被吃掉，用字符码显式拼
  const BS = String.fromCharCode(92);

  it("UNC ⇄ Linux 路径互转", () => {
    const host = toHostPath("/tmp/hertaloy-box-abc", "Ubuntu");
    expect(host).toBe(`${BS}${BS}wsl.localhost${BS}Ubuntu${BS}tmp${BS}hertaloy-box-abc`);
    expect(toInnerPath(host, "Ubuntu")).toBe("/tmp/hertaloy-box-abc");
  });

  it("正斜杠写法也认", () => {
    expect(toInnerPath("//wsl.localhost/Ubuntu/tmp/x", "Ubuntu")).toBe("/tmp/x");
  });

  it("★ 不在该发行版里的路径直接拒 —— 免得把宿主机路径当 Linux 路径传进去", () => {
    expect(() => toInnerPath(`D:${BS}code${BS}x`, "Ubuntu")).toThrow(/不在 WSL 发行版/);
    expect(() => toInnerPath(toHostPath("/tmp/x", "Debian"), "Ubuntu")).toThrow();
  });
});

describe("隔离声明", () => {
  it("★ wsl 自报是安全边界 —— 与 local 的实质差别就在这", () => {
    const r = new WslRunner();
    expect(r.isolates).toBe(true);
    expect(r.kind).toBe("wsl");
  });
});

describe.skipIf(!HAS_WSL)("真跑 WSL", () => {
  it("★ 沙箱住在 Linux 文件系统里，宿主机经 UNC 读写", () => {
    const runner = new WslRunner();
    const root = runner.allocate();
    try {
      expect(toInnerPath(root, "Ubuntu").startsWith("/tmp/hertaloy-box-")).toBe(true);
      const p = createSandbox(root);
      writeFileSync(join(p.workspace, "from-windows.txt"), "宿主机写的", "utf8");

      // WSL 侧看得到
      const inner = toInnerPath(p.workspace, "Ubuntu");
      expect(runner.exec(["cat", `${inner}/from-windows.txt`], p.workspace).trim()).toBe(
        "宿主机写的",
      );
    } finally {
      runner.release(root);
      expect(existsSync(root)).toBe(false);
    }
  }, 60_000);

  it("★ 拿到的是真 Linux 语义 —— 大小写敏感", () => {
    const runner = new WslRunner();
    const root = runner.allocate();
    try {
      const p = createSandbox(root);
      const inner = toInnerPath(p.workspace, "Ubuntu");
      runner.exec(["sh", "-c", `echo lower > ${inner}/case.txt; echo UPPER > ${inner}/CASE.txt`], p.workspace);
      // Windows 文件系统会把这两个当同一个文件；Linux 不会
      const listed = runner.exec(["ls", inner], p.workspace);
      expect(listed).toMatch(/CASE\.txt/);
      expect(listed).toMatch(/case\.txt/);
    } finally {
      runner.release(root);
    }
  }, 60_000);

  it("★ 端到端：agent 在 Linux 里跑，git 也在 Linux 里观察", async () => {
    const runner = new WslRunner();
    const backend = new SandboxBackend({ runner });
    const request: ExecutionRequest = {
      executionId: "exec-wsl",
      instance: "job-1/w",
      priorExecutions: {},
      agentSpec: {
        argv: [
          "sh",
          "-c",
          "echo 'linux 干的' > made-in-linux.txt; " +
            'printf \'{"out":{"uname":"%s"}}\' "$(uname -s)" > ../.hertaloy/emit.json',
        ],
      } as never,
      vars: {},
      outputContract: { allowedEmitPorts: ["out"] },
      limits: {},
    };

    const result = await backend.run(request);
    expect(result.termination).toBe("DONE");
    expect((result.emissions as { out: { uname: string } }).out.uname).toBe("Linux");

    const diag = result.diagnostics as never as SandboxDiagnostics;
    expect(diag.isolates).toBe(true);
    expect(diag.observation?.changes.map((c) => c.path)).toEqual(["made-in-linux.txt"]);
  }, 120_000);

  /**
   * ★ 取消要按**本次执行**取消，不是按命令行匹配。
   *
   * 原实现是 `pkill -9 -f <完整 argv>`，同一行里藏着两个 bug：
   *
   *   1. 两个沙箱跑同一条命令时命令行一模一样 —— 取消一个会把另一个打掉，
   *      而后者只是莫名其妙被杀，自己并不知道
   *   2. `pkill -f` 的模式是**正则**。argv 里带 `{}`（JSON、shell 花括号，
   *      到处都是）时 pkill 直接 `regex error` 什么都没杀 —— 而 wsl.exe 被杀了，
   *      于是**外面看起来是 CANCELLED，里面的 Linux 进程还活着**
   *
   * 两条都由"按进程组取消"一并修掉。下面两条用例各钉一条。
   */
  it("★ 同命令并发时，取消只打到本次执行", async () => {
    const runner = new WslRunner();
    const backend = new SandboxBackend({ runner });
    // 命令里**不含正则元字符**，否则会撞上第二个 bug 而掩盖这一条
    const argv = ["sh", "-c", "sleep 6; touch done.txt"];

    const start = (executionId: string) =>
      backend.run({
        executionId,
        instance: "job-1/w",
        priorExecutions: {},
        agentSpec: { argv } as never,
        vars: {},
        outputContract: { allowedEmitPorts: [] },
        limits: {},
      });

    const first = start("exec-cancel-a");
    const second = start("exec-cancel-b");
    await new Promise((r) => setTimeout(r, 2500)); // 等两个都真起来
    await backend.cancel("exec-cancel-a");

    const [a, b] = await Promise.all([first, second]);
    expect(a.termination).toBe("CANCELLED");
    // ★ 另一个跑完了自己那 6 秒 —— 退出码 0，不是被杀的 9
    expect((b.diagnostics as never as SandboxDiagnostics).exitCode).toBe(0);
  }, 180_000);

  it("★ argv 里带 `{}` 也真的杀得掉 —— 模式当正则用会 regex error 后静默放过", async () => {
    const runner = new WslRunner();
    const backend = new SandboxBackend({ runner });
    // 一次性标记，跑完再去 WSL 里查这个进程还在不在
    const tag = `hertaloy-rx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const argv = ["sh", "-c", `echo '{}' > /dev/null; sleep 20; touch ${tag}`];

    const running = backend.run({
      executionId: "exec-regex",
      instance: "job-1/w",
      priorExecutions: {},
      agentSpec: { argv } as never,
      vars: {},
      outputContract: { allowedEmitPorts: [] },
      limits: {},
    });
    await new Promise((r) => setTimeout(r, 2500));
    await backend.cancel("exec-regex");
    const result = await running;
    expect(result.termination).toBe("CANCELLED");

    // ★ 关键：外面报 CANCELLED 不算数，去 WSL 里看那个进程是不是真没了
    await new Promise((r) => setTimeout(r, 1000));
    const probe = `[${tag.slice(0, 1)}]${tag.slice(1)}`;
    // `pgrep -f` 会匹配到检查命令自己 —— 方括号让检查命令的命令行不匹配这个正则
    const alive = runner.exec(["sh", "-c", `pgrep -f ${probe} | wc -l`], "/");
    expect(alive.trim()).toBe("0");
  }, 180_000);

  it("超时在 WSL 里也能杀掉", async () => {
    const runner = new WslRunner();
    const backend = new SandboxBackend({ runner });
    const result = await backend.run({
      executionId: "exec-timeout",
      instance: "job-1/w",
      priorExecutions: {},
      agentSpec: { argv: ["sleep", "120"] } as never,
      vars: {},
      outputContract: { allowedEmitPorts: ["out"] },
      limits: { wallClockSeconds: 3 },
    });
    expect(result.termination).toBe("BUDGET");
  }, 120_000);
});
