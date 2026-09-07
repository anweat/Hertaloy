import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunState } from "@nodeflow/state";
import { drain, init, scene, send, status, truncate } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-driver-"));
  expect(init(dir, HUMAN, {
    templates: [{ id: "root", kind: "root_config", spec: { nodes: {
      a: { kind: "handler", agent: { argv: ["unused"] }, ports: { in: { direction: "receive" } } },
    } } }],
    root: { id: "job", template: "root" },
    send: [{ traceid: "job", node: "a", port: "in", payload: {} }],
  }).code).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("两个进程 drain 同一 run：只允许一个驱动，send/truncate 仍能进入", async () => {
  const child = fork(fileURLToPath(new URL("./fixtures/drain-worker.mts", import.meta.url)), [dir], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href],
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  try {
    const started = await Promise.race([
      once(child, "message").then(([value]) => value),
      exited.then(() => { throw new Error(`驱动未启动：${stderr}`); }),
    ]);
    expect(started).toEqual({ started: "exec-1" });
    let duplicateStarts = 0;
    const second = await drain(dir, HUMAN, {
      async run(request) {
        duplicateStarts += 1;
        return { executionId: request.executionId, termination: "DONE", emissions: {} };
      },
      async cancel() {},
    });
    expect(second.code).toBe(1);
    expect(second.text).toContain("driver.lock");
    expect(duplicateStarts).toBe(0);
    expect(status(dir, HUMAN).text).toContain("在跑的 execution 1 个");
    expect(send(dir, HUMAN, "job", "a", "in", {}).code).toBe(0);
    expect(truncate(dir, HUMAN, "job", "test stop").code).toBe(0);
    const completed = once(child, "message");
    child.send("release");
    await completed;
    await exited;
    expect(existsSync(join(dir, "driver.lock"))).toBe(false);
    const state = RunState.open(dir, { readOnly: true });
    try {
      expect(state.runtime.records()).toHaveLength(1);
      state.runtime.checkInvariants();
    } finally { state.close(); }
    expect((await drain(dir, HUMAN)).code).toBe(0); // 完成后可再次进入
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}, 15_000);

it("无权 drain 不得在授权之前恢复遗留执行，失败也释放驱动锁", async () => {
  const state = RunState.open(dir);
  let before: unknown;
  try {
    expect(state.runtime.claimAgent().kind).toBe("claimed");
    state.persist();
    before = state.runtime.snapshot();
  } finally { state.close(); }
  const result = await drain(dir, { kind: "agent", id: "unprivileged" });
  expect(result.code).toBe(1);
  expect(result.text).toContain("拒绝");
  expect(existsSync(join(dir, "driver.lock"))).toBe(false);
  const after = RunState.open(dir, { readOnly: true });
  try { expect(after.runtime.snapshot()).toEqual(before); }
  finally { after.close(); }
});

/**
 * ★ 被信号打断也要放锁。
 *
 * `finally` 挡得住异常与正常返回，**挡不住信号** —— Node 收到没有监听器的
 * SIGINT 会直接终止进程。而 `driver.lock` 跨越整个 agent 执行（分钟级），
 * Ctrl-C 恰好最可能发生在那段时间：残留的锁会让之后每次 drain 都失败，
 * 而且没有内建的清理出路。
 */
it("★ drain 在 agent 执行中被中断 → 驱动锁被放掉，后续 drain 能接着跑", async () => {
  const child = fork(fileURLToPath(new URL("./fixtures/drain-worker.mts", import.meta.url)), [dir], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href],
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");

  const started = await Promise.race([
    once(child, "message").then(([value]) => value),
    exited.then(() => { throw new Error(`驱动未启动：${stderr}`); }),
  ]);
  expect(started).toEqual({ started: "exec-1" });
  expect(existsSync(join(dir, "driver.lock"))).toBe(true);

  child.send("interrupt");
  const [code] = await exited;
  // 按信号的约定退出，不改变 Ctrl-C 的语义
  expect(code).toBe(130);
  // ★ 锁没有残留
  expect(existsSync(join(dir, "driver.lock"))).toBe(false);

  // 而且后面真的能接着跑 —— 这才是"没被卡住"的证据
  const again = await drain(dir, HUMAN, {
    async run(request) {
      return { executionId: request.executionId, termination: "DONE", emissions: {} };
    },
    async cancel() {},
  });
  expect(again.code).toBe(0);
}, 30_000);

it("★ 残留的驱动锁在 status 里看得见 —— 此前只能靠人想起来去 ls 目录", () => {
  writeFileSync(join(dir, "driver.lock"), JSON.stringify({ pid: 99999, since: "2026-01-01T00:00:00Z" }));
  const r = status(dir, HUMAN);
  expect(r.code).toBe(0);
  expect(r.text).toContain("driver.lock");
  expect(r.text).toContain("pid 99999");
  expect(r.text).toContain("推进权被它占着");
  const data = r.data as { dirLocks: { name: string }[] };
  expect(data.dirLocks.map((l) => l.name)).toContain("driver.lock");
});

it("锁文件内容坏掉时报「读不出」，不假装没有锁", () => {
  writeFileSync(join(dir, "driver.lock"), "这不是 JSON");
  expect(status(dir, HUMAN).text).toContain("（读不出）");
});

/**
 * ★ 坏的可选观测不该毁掉整张图（审核 F06 的接缝那一半）。
 *
 * 导出侧挡住坏进度已经在 state 那侧验了；这里验**整条链**：
 * `exportSnapshot → parseSnapshot → buildScene`。原来一次坏采集会让
 * `parseSnapshot` 整份拒绝，于是 `hertaloy scene` 直接不可用。
 */
it("★ backend 报了坏进度，scene 仍然出得来", async () => {
  const result = await drain(dir, HUMAN, {
    async run(request) {
      return {
        executionId: request.executionId,
        emissions: {},
        termination: "DONE",
        // 合法 JSON，但不是合法进度
        diagnostics: { runner: "fixture", progress: { done: "九", total: 10 } } as never,
      };
    },
    async cancel() {},
  });
  expect(result.code).toBe(0);

  const r = scene(dir, HUMAN);
  expect(r.code).toBe(0);
  const built = JSON.parse(r.text) as { cells: { id: string }[] };
  // 图照常出得来，节点也在
  expect(built.cells.map((c) => c.id)).toContain("job#a");
}, 30_000);
