/**
 * S3：沙箱外的 git 观察（FOUNDATION_V5.md §14.4）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, destroySandbox, type SandboxPaths } from "../src/layout.js";
import { baseline, gitAvailable, initObserver, observe, type ObserverPaths } from "../src/observe.js";

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
    expect(gitAvailable()).toBe(true);
  });

  it("★ 沙箱里看不到任何 .git —— agent 不知道自己被观察", () => {
    writeFileSync(join(p.workspace, "a.txt"), "原有内容", "utf8");
    initObserver(obs);

    expect(existsSync(join(p.workspace, ".git"))).toBe(false);
    expect(readdirSync(p.workspace)).toEqual(["a.txt"]);
    expect(existsSync(obs.gitDir)).toBe(true);
  });

  it("★ 基线包含开工前的文件 —— 否则原有内容会被算成 agent 改的", () => {
    writeFileSync(join(p.workspace, "existing.txt"), "项目本来就有", "utf8");
    initObserver(obs);

    // 什么都没干
    expect(observe(obs).changes).toEqual([]);
  });
});

describe("观察改动", () => {
  beforeEach(() => {
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n", "utf8");
    initObserver(obs);
  });

  it("新增 / 修改 / 删除都认得出", () => {
    writeFileSync(join(p.workspace, "new.txt"), "新文件\n", "utf8");
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n加了一行\n", "utf8");
    const o = observe(obs);

    const byPath = Object.fromEntries(o.changes.map((c) => [c.path, c.status]));
    expect(byPath["new.txt"]).toBe("A");
    expect(byPath["keep.txt"]).toBe("M");
    expect(o.insertions).toBeGreaterThan(0);
  });

  it("删除也记得下", () => {
    rmSync(join(p.workspace, "keep.txt"));
    const byPath = Object.fromEntries(observe(obs).changes.map((c) => [c.path, c.status]));
    expect(byPath["keep.txt"]).toBe("D");
  });

  it("多级目录里的改动照样看得见", () => {
    writeFileSync(join(p.workspace, "keep.txt"), "初始\n", "utf8");
    const sub = join(p.workspace, "src", "deep");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.ts"), "export const x = 1;\n", "utf8");
    expect(observe(obs).changes.map((c) => c.path)).toContain("src/deep/x.ts");
  });

  it("★ 打新基线之后只看得到新一轮的改动 —— 每次执行各算各的", () => {
    writeFileSync(join(p.workspace, "round1.txt"), "第一轮\n", "utf8");
    expect(observe(obs).changes.map((c) => c.path)).toEqual(["round1.txt"]);

    baseline(obs, "第一轮完成");
    writeFileSync(join(p.workspace, "round2.txt"), "第二轮\n", "utf8");

    expect(observe(obs).changes.map((c) => c.path)).toEqual(["round2.txt"]);
  });

  it("契约目录不在工作树内，所以注入的东西不会被当成改动", () => {
    writeFileSync(join(p.context, "rules.md"), "注入的规则", "utf8");
    writeFileSync(join(p.emit), JSON.stringify({ out: {} }), "utf8");
    expect(observe(obs).changes).toEqual([]);
  });
});
