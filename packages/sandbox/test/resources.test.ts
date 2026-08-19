/**
 * 资源别名与工作区注入：**agent 拿到的是名字，不是位置**。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRequest } from "@nodeflow/contracts";
import { SandboxBackend } from "../src/backend.js";
import { createSandbox } from "../src/layout.js";
import { LocalRunner } from "../src/runner.js";
import { resolveProfile } from "../src/profile.js";
import {
  ResourceError,
  inheritWorkspace,
  provisionResources,
  provisionWorkspace,
  type ResourceRegistry,
} from "../src/resources.js";

let home: string;
let repo: string;
let docs: string;

const git = (argv: readonly string[], cwd: string): string =>
  execFileSync("git", [...argv], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hertaloy-res-"));

  // 一个真仓库，两个提交
  repo = join(home, "the-real-repo");
  mkdirSync(repo);
  git(["init", "--quiet", "-b", "main"], repo);
  git(["config", "user.email", "a@b"], repo);
  git(["config", "user.name", "a"], repo);
  writeFileSync(join(repo, "README.md"), "第一版", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "--quiet", "-m", "one"], repo);
  writeFileSync(join(repo, "README.md"), "第二版", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "--quiet", "-m", "two"], repo);

  docs = join(home, "handbook");
  mkdirSync(docs);
  writeFileSync(join(docs, "guide.md"), "参考资料", "utf8");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function registry(): ResourceRegistry {
  return {
    primary: { kind: "git", path: repo, defaultBase: "main" },
    handbook: { kind: "dir", path: docs },
  };
}

describe("★ 工作区注入", () => {
  it("按别名物化成工作树，落在配置的默认 base 上", () => {
    const target = join(home, "ws");
    const got = provisionWorkspace(registry(), { source: "primary" }, target);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("第二版");
    expect(got.base).toBe("main");
    expect(got.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("能钉在指定 commit 上 —— 基线可复查", () => {
    const first = git(["rev-list", "--max-parents=0", "HEAD"], repo).trim();
    const target = join(home, "ws");
    const got = provisionWorkspace(registry(), { source: "primary", base: first }, target);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("第一版");
    expect(got.commit).toBe(first);
  });

  it("--no-hardlinks：沙箱里的对象库不与源仓库共享 inode", () => {
    const target = join(home, "ws");
    provisionWorkspace(registry(), { source: "primary" }, target);
    // 在沙箱里 gc + 改历史，源仓库不受影响
    git(["reset", "--hard", "HEAD~1"], target);
    git(["gc", "--prune=now", "--quiet"], target);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("第二版");
    expect(git(["rev-list", "--count", "HEAD"], repo).trim()).toBe("2");
  });

  it("★ 未知别名 → 拒绝，并列出已配置的名字", () => {
    expect(() => provisionWorkspace(registry(), { source: "nope" }, join(home, "x"))).toThrow(
      ResourceError,
    );
    expect(() => provisionWorkspace(registry(), { source: "nope" }, join(home, "x"))).toThrow(
      /已配置：primary、handbook/,
    );
  });

  it("类型不符也拒绝 —— dir 当不了工作区", () => {
    expect(() => provisionWorkspace(registry(), { source: "handbook" }, join(home, "x"))).toThrow(
      /需要 git/,
    );
  });
});

describe("★ 参考资料", () => {
  it("目录源按别名拷进去，agent 只看到别名不看到路径", () => {
    const dir = join(home, "res");
    const placed = provisionResources(registry(), { manual: "handbook" }, dir, (_k, a) => a);
    expect(placed).toEqual({ manual: "manual" });
    expect(readFileSync(join(dir, "manual", "guide.md"), "utf8")).toBe("参考资料");
  });

  it("git 源当参考资料时**不带历史** —— 翻不出别的分支和别人的提交", () => {
    const dir = join(home, "res");
    provisionResources(registry(), { code: "primary" }, dir, (_k, a) => a);
    expect(readFileSync(join(dir, "code", "README.md"), "utf8")).toBe("第二版");
    expect(existsSync(join(dir, "code", ".git"))).toBe(false);
  });
});

describe("★ 端到端：agent 在真仓库里干活，观察只报它的改动", () => {
  it("工作区已就位，且 baseline 之后的 diff 不含仓库原有内容", async () => {
    const backend = new SandboxBackend({
      runner: new LocalRunner(home),
      resources: registry(),
      cleanup: false,
    });
    const request: ExecutionRequest = {
      executionId: "exec-1",
      traceid: "job-1",
      nodeId: "coder",
      agentSpec: {
        argv: [
          "node",
          "-e",
          [
            "const fs=require('fs');",
            "fs.writeFileSync('NEW.txt','agent 加的');",
            "fs.writeFileSync('README.md','agent 改的');",
            "fs.writeFileSync('../.hertaloy/emit.json','{}');",
          ].join(""),
        ],
        workspace: { source: "primary" },
        resources: { manual: "handbook" },
      },
      vars: {},
      outputContract: { allowedEmitPorts: [] },
      limits: {},
    };

    const result = await backend.run(request);
    const d = result.diagnostics as unknown as {
      workspace?: { source: string; commit: string };
      observation?: { changes: { status: string; path: string }[] };
    };

    expect(result.termination).toBe("DONE");
    // 基线可复查：从哪个具名源、哪个 commit 起的
    expect(d.workspace?.source).toBe("primary");
    expect(d.workspace?.commit).toMatch(/^[0-9a-f]{40}$/);

    // ★ 观察只报 agent 干的两件事，不报仓库原有的内容
    const paths = (d.observation?.changes ?? []).map((c) => c.path).sort();
    expect(paths).toEqual(["NEW.txt", "README.md"]);
  }, 120_000);

  it("模板引用未配置的源 → FAILED，理由说清是配置问题", async () => {
    const backend = new SandboxBackend({ runner: new LocalRunner(home), resources: {} });
    const result = await backend.run({
      executionId: "exec-2",
      traceid: "job-1",
      nodeId: "coder",
      agentSpec: { argv: ["true"], workspace: { source: "primary" } },
      vars: {},
      outputContract: { allowedEmitPorts: [] },
      limits: {},
    });
    expect(result.termination).toBe("FAILED");
    const d = result.diagnostics as unknown as { stderrTail: string };
    expect(d.stderrTail).toContain("资源物化失败");
    expect(d.stderrTail).toContain("未知资源");
  }, 60_000);
});


describe("★ 别名当宏：同一个名字，profile 决定落在哪", () => {
  it("skill 在 claude-code 下进 .claude/skills，在自家 agent 下进 .hertaloy/skills", () => {
    const claude = resolveProfile("claude-code");
    const own = resolveProfile("hertaloy-agent");
    expect(claude.place("skill", "review")).toBe("workspace/.claude/skills/review");
    expect(own.place("skill", "review")).toBe(".hertaloy/skills/review");
  });

  it("普通资料两边都落缺省位置 —— 不进工作树，免得被算成改动", () => {
    for (const name of ["claude-code", "codex", "hertaloy-agent"]) {
      expect(resolveProfile(name).place("dir", "docs")).toBe(".hertaloy/resources/docs");
    }
  });

  it("★ codex 没有标准技能目录就落回缺省 —— 不编一个约定", () => {
    expect(resolveProfile("codex").place("skill", "review")).toBe(".hertaloy/resources/review");
  });

  it("物化真的按 profile 说的位置放", () => {
    const box = join(home, "box");
    const placed = provisionResources(
      { helper: { kind: "skill", path: docs } },
      { review: "helper" },
      box,
      (k, a) => resolveProfile("claude-code").place(k, a),
    );
    expect(placed.review).toBe("workspace/.claude/skills/review");
    expect(
      readFileSync(join(box, "workspace", ".claude", "skills", "review", "guide.md"), "utf8"),
    ).toBe("参考资料");
  });
});

describe("★ 工作区交接：子流程能成立的关键", () => {
  it("下游拿到上游工作区的**内容**，包括未提交的改动", () => {
    const up = join(home, "up");
    provisionWorkspace(registry(), { source: "primary" }, up);
    writeFileSync(join(up, "README.md"), "上游改过了", "utf8");

    const down = join(home, "down");
    const got = inheritWorkspace(up, "edit", down);
    expect(readFileSync(join(down, "README.md"), "utf8")).toBe("上游改过了");
    expect(got.source).toContain("edit");
  });

  it("★ 是拷贝不是共享 —— 两个并行下游各拿一份，互不踩", () => {
    const up = join(home, "up");
    provisionWorkspace(registry(), { source: "primary" }, up);

    const a = join(home, "a");
    const b = join(home, "b");
    inheritWorkspace(up, "edit", a);
    inheritWorkspace(up, "edit", b);
    writeFileSync(join(a, "README.md"), "A 改的", "utf8");

    expect(readFileSync(join(b, "README.md"), "utf8")).toBe("第二版");
    expect(readFileSync(join(up, "README.md"), "utf8")).toBe("第二版");
  });

  it("git 历史一并接过去 —— 下游能在上游基础上提交", () => {
    const up = join(home, "up");
    provisionWorkspace(registry(), { source: "primary" }, up);
    const down = join(home, "down");
    const got = inheritWorkspace(up, "edit", down);
    expect(got.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["rev-list", "--count", "HEAD"], down).trim()).toBe("2");
  });

  it("上游没跑过 → 说清楚是接不到，不是别的错", () => {
    expect(() => inheritWorkspace(join(home, "不存在"), "edit", join(home, "x"))).toThrow(
      /接不到上游节点/,
    );
  });

  it("接过来的不是 git 仓库也不炸，只是没有 commit", () => {
    const plain = join(home, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.txt"), "x", "utf8");
    expect(inheritWorkspace(plain, "edit", join(home, "out")).commit).toBe("");
  });
});
