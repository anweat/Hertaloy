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
      traceid: "job-1",
      nodeId: "w",
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

  it("超时在 WSL 里也能杀掉", async () => {
    const runner = new WslRunner();
    const backend = new SandboxBackend({ runner });
    const result = await backend.run({
      executionId: "exec-timeout",
      traceid: "job-1",
      nodeId: "w",
      agentSpec: { argv: ["sleep", "120"] } as never,
      vars: {},
      outputContract: { allowedEmitPorts: ["out"] },
      limits: { wallClockSeconds: 3 },
    });
    expect(result.termination).toBe("BUDGET");
  }, 120_000);
});
