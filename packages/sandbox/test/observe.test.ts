/**
 * S3：沙箱外的 git 观察（FOUNDATION_V5.md §14.4）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, destroySandbox, type SandboxPaths } from "../src/layout.js";
import { baseline, gitAvailable, initObserver, observe, type ObserverPaths } from "../src/observe.js";
import { LocalRunner } from "../src/runner.js";

/** 观察器现在经 runner 的 exec 走 —— 让 git 跟 agent 在同一环境。 */
const runner = new LocalRunner();
const exec = (argv: readonly string[], cwd: string): string => runner.exec(argv, cwd);

let root: string;
let gitHome: string;
let p: SandboxPaths;
let obs: ObserverPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hertaloy-obs-"));
  gitHome = mkdtempSync(join(tmpdir(), "hertaloy-git-"));
  p = createSandbox(root);
  obs = { gitDir: join(gitHome, "record.git"), workTree: p.workspace };
});

afterEach(() => {
  destroySandbox(root);
  rmSync(gitHome, { recursive: true, force: true });
});

describe("外置 git", () => {
  it("git 可用（前置条件）", () => {
    expect(gitAvailable(exec, p.workspace)).toBe(true);
  });

  it("★ 沙箱里看不到任何 .git —— agent 不知道自己被观察", () => {
    writeFileSync(join(p.workspace, "a.txt"), "原有内容", "utf8");
    initObserver(obs, exec);

    expect(existsSync(join(p.workspace, ".git"))).toBe(false);
    expect(readdirSync(p.workspace)).toEqual(["a.txt"]);
    expect(existsSync(obs.gitDir)).toBe(true);
  });

  it("★ 基线包含开工前的文件 —— 否则原有内容会被算成 agent 改的", () => {
    writeFileSync(join(p.workspace, "existing.txt"), "项目本来就有", "utf8");
    initObserver(obs, exec);

    // 什么都没干
    expect(observe(obs, exec).changes).toEqual([]);
  });
});

describe("观察改动", () => {
  beforeEach(() => {
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n", "utf8");
    initObserver(obs, exec);
  });

  it("新增 / 修改 / 删除都认得出", () => {
    writeFileSync(join(p.workspace, "new.txt"), "新文件\n", "utf8");
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n加了一行\n", "utf8");
    const o = observe(obs, exec);

    const byPath = Object.fromEntries(o.changes.map((c) => [c.path, c.status]));
    expect(byPath["new.txt"]).toBe("A");
    expect(byPath["keep.txt"]).toBe("M");
    expect(o.insertions).toBeGreaterThan(0);
  });

  it("删除也记得下", () => {
    rmSync(join(p.workspace, "keep.txt"));
    const byPath = Object.fromEntries(observe(obs, exec).changes.map((c) => [c.path, c.status]));
    expect(byPath["keep.txt"]).toBe("D");
  });

  it("多级目录里的改动照样看得见", () => {
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n", "utf8");
    const sub = join(p.workspace, "src", "deep");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.ts"), "export const x = 1;\n", "utf8");
    expect(observe(obs, exec).changes.map((c) => c.path)).toContain("src/deep/x.ts");
  });

  it("★ 打新基线之后只看得到新一轮的改动 —— 每次执行各算各的", () => {
    writeFileSync(join(p.workspace, "round1.txt"), "第一轮\n", "utf8");
    expect(observe(obs, exec).changes.map((c) => c.path)).toEqual(["round1.txt"]);

    baseline(obs, exec, "第一轮完成");
    writeFileSync(join(p.workspace, "round2.txt"), "第二轮\n", "utf8");

    expect(observe(obs, exec).changes.map((c) => c.path)).toEqual(["round2.txt"]);
  });

  it("契约目录不在工作树内，所以注入的东西不会被当成改动", () => {
    writeFileSync(join(p.context, "rules.md"), "注入的规则", "utf8");
    writeFileSync(join(p.emit), JSON.stringify({ out: {} }), "utf8");
    expect(observe(obs, exec).changes).toEqual([]);
  });
});

describe("★ 隐藏 ref 快照：存得下，但看不见", () => {
  it("快照落在 refs/hertaloy 下 —— git branch 里没有它", () => {
    initObserver(obs, exec);
    writeFileSync(join(obs.workTree, "a.txt"), "改了", "utf8");
    const snap = observe(obs, exec, "exec-1");

    expect(snap.ref).toBe("refs/hertaloy/snapshots/exec-1");
    expect(snap.snapshot).toMatch(/^[0-9a-f]{40}$/);

    // 分支列表里干干净净
    const branches = exec(["git", `--git-dir=${obs.gitDir}`, "branch", "--list"], obs.workTree);
    expect(branches).not.toContain("exec-1");
    expect(branches).not.toContain("hertaloy");
  });

  it("默认 git log 走不到 —— 但 `--all` 走得到（实测，别写反）", () => {
    initObserver(obs, exec);
    writeFileSync(join(obs.workTree, "a.txt"), "改了", "utf8");
    const snap = observe(obs, exec, "exec-1");
    const log = (...extra: string[]): string =>
      exec(["git", `--git-dir=${obs.gitDir}`, "log", ...extra, "--format=%H"], obs.workTree);

    // 默认走 HEAD，快照不在那条线上
    expect(log()).not.toContain(snap.snapshot);
    // `--all` 是"refs/ 下全部"，不是只有分支 —— 主动去看就看得到，
    // 这正是我们要的：快照是证据，不是秘密
    expect(log("--all")).toContain(snap.snapshot);
  });

  it("但内容确实存下来了 —— 按 ref 取得到，且是改动后的树", () => {
    initObserver(obs, exec);
    writeFileSync(join(obs.workTree, "a.txt"), "改动后的内容", "utf8");
    const snap = observe(obs, exec, "exec-1");

    const shown = exec(
      ["git", `--git-dir=${obs.gitDir}`, "show", `${snap.ref as string}:a.txt`],
      obs.workTree,
    );
    expect(shown.trim()).toBe("改动后的内容");
  });

  it("HEAD 没有被推进 —— commit-tree 只造对象，不动任何分支", () => {
    initObserver(obs, exec);
    const before = exec(["git", `--git-dir=${obs.gitDir}`, "rev-parse", "HEAD"], obs.workTree);
    writeFileSync(join(obs.workTree, "a.txt"), "改了", "utf8");
    observe(obs, exec, "exec-1");
    const after = exec(["git", `--git-dir=${obs.gitDir}`, "rev-parse", "HEAD"], obs.workTree);
    expect(after).toBe(before);
  });

  it("多次执行各占一条 ref，互不覆盖", () => {
    initObserver(obs, exec);
    writeFileSync(join(obs.workTree, "a.txt"), "第一次", "utf8");
    const first = observe(obs, exec, "exec-1");
    writeFileSync(join(obs.workTree, "a.txt"), "第二次", "utf8");
    const second = observe(obs, exec, "exec-2");

    expect(first.snapshot).not.toBe(second.snapshot);
    const refs = exec(
      ["git", `--git-dir=${obs.gitDir}`, "for-each-ref", "--format=%(refname)", "refs/hertaloy"],
      obs.workTree,
    );
    expect(refs).toContain("refs/hertaloy/snapshots/exec-1");
    expect(refs).toContain("refs/hertaloy/snapshots/exec-2");
  });

  it("不传 snapshotId 就只算 diff，不留快照（旧行为不变）", () => {
    initObserver(obs, exec);
    writeFileSync(join(obs.workTree, "a.txt"), "改了", "utf8");
    const snap = observe(obs, exec);
    expect(snap.snapshot).toBeUndefined();
    expect(snap.changes).toHaveLength(1);
  });
});
