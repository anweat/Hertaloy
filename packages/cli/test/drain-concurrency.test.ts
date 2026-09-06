import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunState } from "@nodeflow/state";
import { drain, init, send, status, truncate } from "../src/state-commands.js";

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
