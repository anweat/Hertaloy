/** 无模型调用的可见性实验。--interactive 等待门文件，便于浏览器观察各阶段。 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, scene } from "../../packages/cli/src/state-commands.ts";
import { define, definitions, validateDefinition } from "../../packages/cli/src/template-commands.ts";
import { listen } from "../../packages/cli/src/serve.ts";
import { RunState } from "../../packages/state/src/run-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const dir = mkdtempSync(join(tmpdir(), "hertaloy-s6-visibility-"));
const interactive = process.argv.includes("--interactive");
const HUMAN = { kind: "human", id: "local" } as const;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (name: string, test: () => boolean | Promise<boolean>, ms = 30000) => {
  const until = Date.now() + ms;
  while (!(await test())) { if (Date.now() > until) throw new Error(`timeout: ${name}`); await delay(100); }
};
const gate = async (name: string) => {
  if (interactive) await waitFor(name, () => existsSync(join(dir, name)), 15 * 60 * 1000);
};
const agent = `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const control = ${JSON.stringify(dir)};
const again = fs.existsSync(path.join(control, 'attempted'));
fs.writeFileSync(path.join(control, 'attempted'), 'yes');
const tool = (...args) => cp.execFileSync(process.execPath, ['../.hertaloy/bin/hertaloy.mjs', ...args]);
(async () => {
  if (again) {
    const until = Date.now() + 900000;
    while (!fs.existsSync(path.join(control, 'retry'))) {
      if (Date.now() > until) throw new Error('retry gate timeout');
      await new Promise(r => setTimeout(r, 100));
    }
  }
  tool('progress', '1', '3', '正在读取实验输入');
  if (!again) {
    const until = Date.now() + 900000;
    while (!fs.existsSync(path.join(control, 'more'))) {
      if (Date.now() > until) throw new Error('gate timeout');
      await new Promise(r => setTimeout(r, 100));
    }
    tool('progress', '2', '3', '正在验证第二阶段');
    while (!fs.existsSync(path.join(control, 'fail'))) {
      if (Date.now() > until) throw new Error('gate timeout');
      await new Promise(r => setTimeout(r, 100));
    }
    process.stderr.write('EXPECTED FIRST ATTEMPT FAILURE');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync('../.hertaloy/artifacts/reports', {recursive:true});
  fs.writeFileSync('../.hertaloy/artifacts/reports/answer.md', 'VISIBILITY VERIFIED: retry produced this artifact.');
  tool('progress', '3', '3', '验证完成，产物已生成');
  tool('emit', 'out', JSON.stringify({result:'verified'}));
})().catch(e => { process.stderr.write(String(e)); process.exitCode = 1; });
`;

const scenario = {
  templates: [
    { id: "leaf", spec: { nodes: { placeholder: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } } } },
    { id: "mid", spec: { children: { nested: { template: "leaf@1" } } } },
    { id: "root", kind: "root_config", spec: {
      nodes: { work: { kind: "handler", agent: { argv: [process.execPath, "-e", agent] }, ports: { in: { direction: "receive", servo: { vars: {} } }, out: { direction: "emit" } } } },
      children: { future: { template: "mid@1" } },
    } },
  ],
  root: { id: "visibility", template: "root" },
  send: [{ traceid: "visibility", node: "work", port: "in", payload: {} }],
};
assert.equal(init(dir, HUMAN, scenario).code, 0);
assert.equal(define(dir, HUMAN, "leaf", {}).code, 0);
assert.deepEqual(Object.keys(definitions(dir, HUMAN).data as object).sort(), ["leaf@1", "mid@1", "root@1"]);
const invalid = validateDefinition(dir, HUMAN, "draft", { children: { broken: { template: "absent@1" } } });
assert.equal(invalid.code, 1);

const page = readFileSync(join(repo, "packages/cli/src/page.html"), "utf8");
let server = await listen({ dir, actor: HUMAN, runner: "local", page, intervalMs: 100 });
const port = server.port();
let active: ReturnType<typeof spawn> | undefined;
const run = () => {
  active = spawn(process.execPath, ["--import", "tsx", "packages/cli/src/main.ts", "drain", dir, "--runner", "local", "--json"], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  active.stdout!.on("data", (b) => { output += b.toString(); });
  active.stderr!.on("data", (b) => { output += b.toString(); });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    active!.once("error", reject);
    active!.once("exit", (code) => resolve({ code, output }));
  });
};
const get = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-hertaloy-token": server.token } });
  assert.equal(r.status, 200);
  return r.json();
};
const info = { dir, url: `http://127.0.0.1:${port}/` };
writeFileSync(join(here, "session.json"), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
const results: Record<string, unknown> = { baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), mode: "real Node + LocalRunner + CLI process + HTTP", paidModelCalls: 0 };
try {
  const first = run();
  await waitFor("live journal", async () => {
    const s = await get("/status");
    if (s.running.length === 0) return false;
    const d = await get(`/execution?id=${s.running[0].executionId}`);
    return d.live?.available && d.live.entries.length > 0;
  });
  results.running = await get("/execution?id=exec-1");
  console.log("PHASE running");
  await gate("more");
  writeFileSync(join(dir, "more"), "go");
  await waitFor("second journal", async () => (await get("/execution?id=exec-1")).live.entries.length >= 2);
  results.liveUpdated = await get("/execution?id=exec-1");
  assert.match(JSON.stringify(results.liveUpdated), /正在验证第二阶段/);
  console.log("PHASE live-updated");
  await gate("fail");
  writeFileSync(join(dir, "fail"), "go");
  // drain 会自动重试：第二次真实进程先在 retry 门等待，保留可观察的中间态。
  await waitFor("automatic retry", async () => (await get("/status")).running.some((r: any) => r.executionId === "exec-2"));
  results.failed = await get("/execution?id=exec-1");
  assert.equal((results.failed as any).execution.termination, "FAILED");
  results.failedScene = scene(dir, HUMAN).data;
  console.log("PHASE failed");
  await gate("retry");
  writeFileSync(join(dir, "retry"), "go");
  const second = await first;
  assert.equal(second.code, 0, second.output);
  results.settled = await get("/execution?id=exec-2");
  assert.equal((results.settled as any).execution.termination, "DONE");
  const finalScene = await get("/scene");
  const node = finalScene.cells.find((c: any) => c.id === "visibility#work");
  assert.equal(node.execution, "exec-2");
  assert.equal(node.phase, "done");
  assert.equal(node.progress.note, "验证完成，产物已生成");
  results.finalNode = node;
  const artifact = (results.settled as any).artifacts.find((a: any) => a.ref === "visibility/reports/answer.md@1");
  assert.ok(artifact);
  assert.equal((results.settled as any).artifacts.length, 1);
  results.artifact = await get(`/object?ref=${encodeURIComponent(artifact.ref)}`);
  assert.match(JSON.stringify(results.artifact), /VISIBILITY VERIFIED/);
  const msgId = (results.settled as any).execution.claimed[0];
  results.message = await get(`/message?id=${encodeURIComponent(msgId)}`);
  assert.equal((results.message as any).message.state, "CONSUMED");
  assert.ok((results.message as any).lastFailure);
  results.operations = await get("/operations");
  assert.ok((results.operations as any).actions.every((a: any) => a.reasons.some((r: any) => r.code === "read_only_transport")));
  results.definitions = await get("/definitions");
  assert.ok((results.definitions as any)["leaf@1"]);
  assert.equal((results.definitions as any)["leaf@2"], undefined);
  console.log("PHASE settled");
  await gate("restart");
  const oldToken = server.token;
  await server.close();
  server = await listen({ dir, actor: HUMAN, runner: "local", page, port, intervalMs: 100 });
  let staleStatus = 0;
  // 原连接池可能先收到 ECONNRESET；等待新连接，不能把断流当成鉴权答复。
  await waitFor("new listener", async () => {
    try {
      const stale = await fetch(`http://127.0.0.1:${port}/scene`, { headers: { "x-hertaloy-token": oldToken } });
      staleStatus = stale.status;
      await stale.text();
      return true;
    } catch { return false; }
  }, 5000);
  assert.equal(staleStatus, 401);
  results.restartedOldTokenStatus = staleStatus;
  console.log("PHASE restarted");
  const denied = await listen({ dir, actor: { kind: "agent", id: "no-access" } });
  try {
    const res = await fetch(`http://127.0.0.1:${denied.port()}/scene/stream`, { headers: { "x-hertaloy-token": denied.token } });
    assert.equal(res.status, 403);
    results.deniedStreamStatus = res.status;
  } finally { await denied.close(); }
  const state = RunState.open(dir, { readOnly: true });
  try { state.runtime.checkInvariants(); } finally { state.close(); }
  results.invariants = "passed";
  results.validation = invalid.data;
  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2));
  if (process.argv.includes("--hold-result")) await waitFor("stop", () => existsSync(join(dir, "stop")), 15 * 60 * 1000);
  await gate("stop");
  console.log("PASS visibility experiment");
} finally {
  if (active && active.exitCode === null) active.kill();
  await server.close();
}
