import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "../src/run-state.js";
import * as objects from "../src/objects.js";
import * as heads from "../src/head.js";

let dir: string;
const opened: RunState[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hertaloy-commit-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const state of opened.splice(0)) state.close();
  rmSync(dir, { recursive: true, force: true });
});
function open(readOnly = false): RunState {
  const state = RunState.open(dir, { readOnly });
  opened.push(state);
  return state;
}
function seed(): RunState {
  const state = open();
  const ref = registerContainerTemplate(state.store, "root", { nodes: {}, edges: {}, children: {} }, "root_config");
  state.registry.createRoot(ref, "job");
  state.store.put("job/memo", "note", { text: "committed" });
  state.persist();
  return state;
}
function blockHead(): void { mkdirSync(join(dir, "head.json.tmp")); }
function unblockHead(): void { rmSync(join(dir, "head.json.tmp"), { recursive: true }); }

it("刷对象后 head 发布失败：读者保留旧快照；重放不同正文，不复活无关孤儿", () => {
  const first = seed();
  first.store.put("job/memo", "note", { text: "uncommitted" });
  first.store.put("abandoned", "note", { text: "orphan" });
  blockHead();
  expect(() => first.persist()).toThrow();
  // 真正跨过了刷对象边界，失败不能发生在什么都没写之前。
  expect(existsSync(join(dir, "objects/job/memo/@2.json"))).toBe(true);
  const reader = open(true);
  expect(reader.store.head("job/memo").body).toEqual({ text: "committed" });
  expect(reader.store.has("abandoned")).toBe(false);
  expect(reader.registry.rootTrace).toBe("job");
  reader.close();
  first.close();
  unblockHead();

  const replay = open();
  replay.store.put("job/memo", "note", { text: "replayed differently" });
  for (let n = 0; n < 4; n++) replay.store.put(`other-${n}`, "note", { n });
  replay.persist();
  replay.close();
  const recovered = open();
  expect(recovered.store.head("job/memo").version).toBe(2);
  expect(recovered.store.head("job/memo").body).toEqual({ text: "replayed differently" });
  expect(recovered.store.has("abandoned")).toBe(false);
});

it("首次 head 尚不存在时中断，重开为空；重新使用版本路径保存新正文", () => {
  const first = open();
  first.store.put("memo", "note", { text: "old attempt" });
  blockHead();
  expect(() => first.persist()).toThrow();
  first.close();
  unblockHead();
  const second = open();
  expect(second.store.appendCount).toBe(0);
  second.store.put("memo", "note", { text: "new attempt" });
  second.persist();
  second.close();
  expect(open().store.head("memo").body).toEqual({ text: "new attempt" });
});

it("保存失败后内存事务回滚，再次提交同一版本号时不能跳过刷盘", () => {
  const state = seed();
  const before = state.store.snapshot();
  state.store.put("job/memo", "note", { text: "rolled back" });
  blockHead();
  expect(() => state.persist()).toThrow();
  state.store.restore(before);
  unblockHead();
  state.store.put("job/memo", "note", { text: "retry" });
  state.persist();
  state.close();
  expect(open().store.head("job/memo").body).toEqual({ text: "retry" });
});

it("只加载提交清单：未发布的半截临时文件与无关文件不污染读取", () => {
  seed().close();
  writeFileSync(join(dir, "objects/job/memo/@2.json.tmp"), '{"body":');
  mkdirSync(join(dir, "objects/orphan"));
  writeFileSync(join(dir, "objects/orphan/@1.json"), '{"body":');
  expect(open().store.head("job/memo").body).toEqual({ text: "committed" });
});

it("格式 1 首次升级：先发布旧版本清单，刷新新对象途中失败也能读旧状态", () => {
  seed().close();
  const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
  head.format = 1;
  delete head.objectHeads;
  writeFileSync(join(dir, "head.json"), JSON.stringify(head));
  const state = open();
  state.store.put("job/memo", "note", { text: "new" });
  const flush = objects.flushObjects;
  vi.spyOn(objects, "flushObjects").mockImplementationOnce((...args) => {
    flush(...args);
    throw new Error("simulated interruption after object flush");
  });
  expect(() => state.persist()).toThrow(/simulated interruption/);
  state.close();
  expect(open().store.head("job/memo").body).toEqual({ text: "committed" });
});

it("没有提交清单的旧目录若已有多余对象，不能猜测哪些应保留", () => {
  const state = seed();
  const cursor = state.store.appendCount;
  state.store.put("job/memo", "note", { text: "ambiguous" });
  objects.flushObjects(dir, state.store, cursor);
  state.close();
  const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
  head.format = 1;
  delete head.objectHeads;
  writeFileSync(join(dir, "head.json"), JSON.stringify(head));
  expect(() => open()).toThrow(/对不上/);
});

it("读者刚读到格式 1 时另一个写者完成升级，重取格式 2 快照后继续读取", () => {
  seed().close();
  const headFile = join(dir, "head.json");
  const legacy = JSON.parse(readFileSync(headFile, "utf8"));
  legacy.format = 1;
  delete legacy.objectHeads;
  writeFileSync(headFile, JSON.stringify(legacy));
  const writer = open();
  writer.store.put("job/memo", "note", { text: "upgraded" });
  const read = heads.readHead;
  vi.spyOn(heads, "readHead").mockImplementationOnce((root) => {
    const old = read(root);
    writer.persist();
    return old;
  });
  expect(open(true).store.head("job/memo").body).toEqual({ text: "upgraded" });
});

it.each(["readonly", "closed"] as const)("%s 实例不能绕过写锁发布新 head", (mode) => {
  const seedState = seed();
  seedState.close();
  const state = mode === "closed" ? seedState : open(true);
  state.store.put("job/memo", "note", { text: "forbidden write" });
  expect(() => state.persist()).toThrow(/写锁/);
  expect(open(true).store.head("job/memo").body).toEqual({ text: "committed" });
});

it.each([undefined, { "job/memo": -1 }, { "job/memo": 1.5 }, []])("格式 2 清单缺失或计数非法时拒绝装载：%j", (objectHeads) => {
  seed().close();
  const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
  writeFileSync(join(dir, "head.json"), JSON.stringify({ ...head, objectHeads }));
  expect(() => open()).toThrow(/清单/);
});

it("提交文件中的版本号必须与文件位置一致", () => {
  seed().close();
  const file = join(dir, "objects/job/memo/@1.json");
  const version = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...version, version: 2 }));
  expect(() => open()).toThrow(/版本号.*不符/);
});

it.each(["object", "head"])("在 %s 发布前强制结束真实写进程，旧状态仍可读且可继续保存", async (stage) => {
  seed().close();
  const child = fork(fileURLToPath(new URL("./fixtures/interrupted-persist.mts", import.meta.url)), [dir, stage], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href],
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  const timeout = AbortSignal.timeout(10_000);
  try {
    const boundary = await Promise.race([
      once(child, "message", { signal: timeout }).then(([value]) => value),
      exited.then(() => { throw new Error(`故障点未到达：${stderr}`); }),
    ]);
    expect(boundary).toEqual({ stage });
    const reader = open(true);
    expect(reader.store.head("job/memo").body).toEqual({ text: "committed" });
    reader.close();
    expect(child.kill("SIGKILL")).toBe(true);
    await exited;
    expect(open(true).store.head("job/memo").body).toEqual({ text: "committed" });
    // 仅清理已等待 exit、核对 PID 的本测试遗留锁；产品仍不自动抢锁。
    const lockFile = join(dir, "head.lock");
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(child.pid);
    rmSync(lockFile);
    const resumed = open();
    resumed.store.put("job/memo", "note", { text: "resumed" });
    resumed.persist();
    resumed.close();
    const reopened = open(true);
    expect(reopened.store.head("job/memo").body).toEqual({ text: "resumed" });
    expect(reopened.store.has("abandoned")).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
}, 15_000);
