/**
 * 批 P：profile 渲染器（FOUNDATION_V5.md §14.3）。
 *
 * 适配不是特例代码，是配置 —— 每个 profile 只是"把上下文写成谁认识的文件"。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionRequest } from "@nodeflow/contracts";
import { SandboxBackend } from "../src/backend.js";
import { LocalRunner } from "../src/runner.js";
import { PROFILE_NAMES, resolveProfile } from "../src/profile.js";

const input = {
  vars: { rules: "遵守 PEP 8", budget: 1000 },
  allowedEmitPorts: ["out", "err"] as const,
  emitPath: "../.hertaloy/emit.json",
  artifactsDir: "../.hertaloy/artifacts",
  traceid: "job-1/coder-1",
  nodeId: "work",
};

describe("三个 profile 各写各家认识的文件", () => {
  it("claude-code 写 workspace/CLAUDE.md", () => {
    const files = resolveProfile("claude-code").render(input);
    expect(Object.keys(files)).toContain("workspace/CLAUDE.md");
    expect(files["workspace/CLAUDE.md"]).toMatch(/遵守 PEP 8/);
  });

  it("codex 写 workspace/AGENTS.md", () => {
    expect(Object.keys(resolveProfile("codex").render(input))).toContain("workspace/AGENTS.md");
  });

  it("hertaloy-agent 全放 .hertaloy/context/（原生懂契约）", () => {
    const files = resolveProfile("hertaloy-agent").render(input);
    expect(Object.keys(files).every((k) => k.startsWith(".hertaloy/"))).toBe(true);
  });

  it("未知 profile 报错并列出可用", () => {
    expect(() => resolveProfile("gpt-cli")).toThrow(/可用：/);
    expect(PROFILE_NAMES).toEqual(["claude-code", "codex", "hertaloy-agent"]);
  });
});

describe("★ 输出契约靠注入教给外部 agent", () => {
  it("每个 profile 都带上端口白名单与 emit 位置 —— 不改 agent，只告诉它规矩", () => {
    for (const name of PROFILE_NAMES) {
      const text = Object.values(resolveProfile(name).render(input)).join("\n");
      expect(text, name).toMatch(/emit\.json/);
      expect(text, name).toMatch(/`out`/);
      expect(text, name).toMatch(/`err`/);
      expect(text, name).toMatch(/artifacts/);
    }
  });

  it("变量都进了人读的段落", () => {
    const md = resolveProfile("claude-code").render(input)["workspace/CLAUDE.md"] ?? "";
    expect(md).toMatch(/## rules/);
    expect(md).toMatch(/## budget/);
  });
});

describe("★ 渲染发生在打基线之前 —— CLAUDE.md 不会被当成 agent 的改动", () => {
  it("端到端：agent 什么都不改，观察结果为空", async () => {
    const backend = new SandboxBackend({ runner: new LocalRunner() });
    const request: ExecutionRequest = {
      executionId: "exec-p",
      traceid: "job-1",
      nodeId: "w",
      agentSpec: {
        argv: [
          "node",
          "-e",
          "require('fs').writeFileSync('../.hertaloy/emit.json', JSON.stringify({out:{}}))",
        ],
        profile: "claude-code",
      } as never,
      vars: { rules: "注入的规则" },
      outputContract: { allowedEmitPorts: ["out"] },
      limits: {},
    };

    const result = await backend.run(request);
    expect(result.termination).toBe("DONE");
    // CLAUDE.md 在基线里，不是改动
    const diag = result.diagnostics as never as { observation?: { changes: unknown[] } };
    expect(diag.observation?.changes).toEqual([]);
  }, 30_000);

  it("agent 真改了文件才算改动", async () => {
    const backend = new SandboxBackend({ runner: new LocalRunner() });
    const result = await backend.run({
      executionId: "exec-p2",
      traceid: "job-1",
      nodeId: "w",
      agentSpec: {
        argv: [
          "node",
          "-e",
          "const fs=require('fs');fs.writeFileSync('made.txt','x');fs.writeFileSync('../.hertaloy/emit.json',JSON.stringify({out:{}}))",
        ],
        profile: "claude-code",
      } as never,
      vars: {},
      outputContract: { allowedEmitPorts: ["out"] },
      limits: {},
    });
    const diag = result.diagnostics as never as { observation?: { changes: { path: string }[] } };
    expect(diag.observation?.changes.map((c) => c.path)).toEqual(["made.txt"]);
  }, 30_000);
});
