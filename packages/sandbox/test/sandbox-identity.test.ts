import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalRunner, safeId } from "../src/runner.js";
import { DockerRunner } from "../src/docker.js";
import { WslRunner } from "../src/wsl.js";
import { createSandbox } from "../src/layout.js";
import { SandboxBackend } from "../src/backend.js";

const roots: string[] = [];
function workRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hertaloy-identity-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  ["job/a/exec-1", "job-a/exec-1"],
  ["run:a", "run-a"],
  ["A", "a"],
  ["任务甲", "任务乙"],
  ["a b", "a?b"],
])("不同身份 %s / %s 在大小写不敏感文件系统上也不合并", (a, b) => {
  expect(safeId(a).toLowerCase()).not.toBe(safeId(b).toLowerCase());
});

it("文件名有界、合法、可重复定位，不依赖截断后的前缀", () => {
  const id = "job/" + "a".repeat(1000);
  expect(safeId(id)).toMatch(/^[a-z0-9_.-]+$/);
  expect(safeId(id).length).toBeLessThan(100);
  expect(safeId(id)).toBe(safeId(id));
  expect(safeId(id)).not.toBe(safeId(id + "b"));
});

it.each(["local", "docker"])("%s 分配字符折叠碰撞的两个身份，不清掉第一个的文件", (kind) => {
  const base = workRoot();
  const runner = kind === "local" ? new LocalRunner(base) : new DockerRunner({ workRoot: base });
  const first = runner.allocate("job/a/exec-1");
  const marker = join(first, "keep.txt");
  writeFileSync(marker, "first");
  const second = runner.allocate("job-a/exec-1");
  expect(second.toLowerCase()).not.toBe(first.toLowerCase());
  expect(readFileSync(marker, "utf8")).toBe("first");
});

it("WSL 与其他运行器使用相同的身份区分规则", () => {
  const runner = new WslRunner();
  expect(runner.locate("job/a/exec-1")).not.toBe(runner.locate("job-a/exec-1"));
});

function legacy(base: string, claimed = "job/a"): string {
  const root = join(base, "hertaloy-box-job-a-work-exec-1");
  const paths = createSandbox(root);
  writeFileSync(paths.request, JSON.stringify({ traceid: claimed, nodeId: "work", executionId: "exec-1" }));
  writeFileSync(join(paths.workspace, "keep.txt"), "legacy");
  return root;
}

it.each(["local", "docker"])("%s 可核对旧工作区归属，新分配不清理旧目录", (kind) => {
  const base = workRoot();
  const old = legacy(base);
  const runner = kind === "local" ? new LocalRunner(base) : new DockerRunner({ workRoot: base });
  expect(runner.locate("job/a/work/exec-1")).toBe(old);
  const fresh = runner.allocate("job/a/work/exec-1");
  expect(fresh).not.toBe(old);
  expect(runner.locate("job/a/work/exec-1")).toBe(fresh);
  expect(readFileSync(join(old, "box/workspace/keep.txt"), "utf8")).toBe("legacy");
});

it.each(["wrong-owner", "missing", "malformed"])("旧目录 %s 无法确认归属时拒绝交接，保留现场", (mode) => {
  const base = workRoot();
  const old = legacy(base, mode === "wrong-owner" ? "job-a" : "job/a");
  const request = join(old, "box/.hertaloy/request.json");
  if (mode === "missing") rmSync(request);
  if (mode === "malformed") writeFileSync(request, "{");
  expect(() => new LocalRunner(base).locate("job/a/work/exec-1")).toThrow(/归属/);
  expect(existsSync(join(old, "box/workspace/keep.txt"))).toBe(true);
});

it.each(["local", "docker"])("%s 重复分配同一身份直接拒绝，不删除旧现场", (kind) => {
  const base = workRoot();
  const make = () => kind === "local" ? new LocalRunner(base) : new DockerRunner({ workRoot: base });
  const root = make().allocate("job/a/exec-1");
  const marker = join(root, "keep.txt");
  writeFileSync(marker, "already running");
  expect(() => make().allocate("job/a/exec-1")).toThrow(/已存在.*拒绝覆盖/);
  expect(readFileSync(marker, "utf8")).toBe("already running");
});

it("新布局的身份标记不匹配时也拒绝定位", () => {
  const base = workRoot();
  const runner = new LocalRunner(base);
  const root = runner.allocate("job/a/exec-1");
  writeFileSync(join(root, "hertaloy.identity.json"), JSON.stringify({ id: "other" }));
  expect(() => runner.locate("job/a/exec-1")).toThrow(/归属/);
});

it("新 backend 可从已验证的旧布局继承工作区，原文件保持不变", async () => {
  const base = workRoot();
  const old = legacy(base);
  const backend = new SandboxBackend({ workRoot: base });
  const result = await backend.run({
    traceid: "job/a", nodeId: "next", executionId: "exec-2", priorExecutions: { work: "exec-1" },
    agentSpec: {
      workspace: { from: "work" },
      argv: [process.execPath, "-e", 'const fs=require("node:fs"); fs.writeFileSync("../.hertaloy/emit.json", JSON.stringify({out:{text:fs.readFileSync("keep.txt","utf8")}}))'],
    },
    vars: {}, limits: {}, outputContract: { allowedEmitPorts: ["out"] },
  });
  expect(result.termination).toBe("DONE");
  expect(result.emissions).toEqual({ out: { text: "legacy" } });
  expect(readFileSync(join(old, "box/workspace/keep.txt"), "utf8")).toBe("legacy");
}, 30_000);
