/**
 * S1：沙箱契约目录（FOUNDATION_V5.md §14.2）。
 *
 * 纯文件操作，离线可测，不依赖 docker / wsl / git。
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectArtifacts,
  createSandbox,
  destroySandbox,
  readEmit,
  safeJoin,
  sandboxPaths,
  writeContext,
  writeRequest,
  type SandboxPaths,
} from "../src/layout.js";

let root: string;
let p: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hertaloy-"));
  p = createSandbox(root);
});

afterEach(() => {
  destroySandbox(root);
});

describe("目录布局", () => {
  it("建出 workspace 与 .hertaloy 两块", () => {
    expect(existsSync(p.workspace)).toBe(true);
    expect(existsSync(p.context)).toBe(true);
    expect(existsSync(p.artifacts)).toBe(true);
  });

  it("★ .hertaloy 在 workspace 之外 —— git work-tree 只盯 workspace", () => {
    // 这条保证两件事：注入的内容不被 git 当成 agent 的改动；凭据不进 git
    expect(p.meta.startsWith(p.workspace)).toBe(false);
    expect(p.context.startsWith(p.workspace)).toBe(false);
  });

  it("销毁是幂等的", () => {
    destroySandbox(root);
    expect(existsSync(root)).toBe(false);
    expect(() => destroySandbox(root)).not.toThrow();
  });
});

describe("注入", () => {
  it("写多级路径，自动建目录", () => {
    writeContext(p, {
      "rules.md": "遵守 PEP 8",
      "skills/export/SKILL.md": "# 导出技能",
    });
    expect(readFileSync(join(p.context, "rules.md"), "utf8")).toBe("遵守 PEP 8");
    expect(readFileSync(join(p.context, "skills/export/SKILL.md"), "utf8")).toBe("# 导出技能");
  });

  it("★ 拒绝越出沙箱的路径 —— 模板由 AI 生成，别让手滑的路径写到外面", () => {
    expect(() => writeContext(p, { "../escape.md": "x" })).toThrow(/越出沙箱目录/);
    expect(() => safeJoin(p.context, "a/../../b")).toThrow(/越出沙箱目录/);
    expect(() => safeJoin(p.context, "")).toThrow();
  });

  it("request.json 是给 agent 看的：端口白名单、预算、traceid", () => {
    writeRequest(p, {
      executionId: "exec-1",
      traceid: "job-1/coder-1",
      allowedEmitPorts: ["out", "err"],
      limits: { tokenBudget: 1000 },
    });
    const back = JSON.parse(readFileSync(p.request, "utf8")) as Record<string, unknown>;
    expect(back.allowedEmitPorts).toEqual(["out", "err"]);
  });
});

describe("读回 agent 的输出", () => {
  it("emit.json 存在且合法就读出来", () => {
    writeFileSync(p.emit, JSON.stringify({ out: { ok: true } }), "utf8");
    expect(readEmit(p)).toEqual({ out: { ok: true } });
  });

  it("★ 不存在或不是合法 JSON 都返回 null —— 由调用方判成 INVALID_OUTPUT", () => {
    expect(readEmit(p)).toBeNull();
    writeFileSync(p.emit, "这不是 json", "utf8");
    expect(readEmit(p)).toBeNull();
  });

  it("artifacts 递归收，相对路径即资产名，顺序稳定", () => {
    mkdirSync(join(p.artifacts, "sub"), { recursive: true });
    writeFileSync(join(p.artifacts, "b.md"), "B", "utf8");
    writeFileSync(join(p.artifacts, "a.md"), "A", "utf8");
    writeFileSync(join(p.artifacts, "sub", "c.md"), "C", "utf8");

    expect(collectArtifacts(p)).toEqual([
      { name: "a.md", content: "A" },
      { name: "b.md", content: "B" },
      { name: "sub/c.md", content: "C" },
    ]);
  });

  it("没有产物就是空数组，不报错", () => {
    expect(collectArtifacts(p)).toEqual([]);
  });
});

describe("sandboxPaths 是纯函数", () => {
  it("不建目录也能算出路径", () => {
    const q = sandboxPaths("/nowhere");
    expect(q.workspace).toMatch(/workspace$/);
    expect(existsSync("/nowhere")).toBe(false);
  });
});
