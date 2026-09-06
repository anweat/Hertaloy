/** Read-only audit of product code; all executions use a fresh temporary run. */
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SandboxBackend } from "../../packages/sandbox/src/index.js";
import { RunState } from "../../packages/state/src/index.js";
import { init, drain, send } from "../../packages/cli/src/state-commands.js";
import { listen } from "../../packages/cli/src/serve.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const HUMAN = { kind: "human", id: "local" } as const;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("audit fixture timed out");
    await pause(50);
  }
}
function seed(dir: string, agent: string, extra: Record<string, unknown> = {}) {
  const result = init(dir, HUMAN, {
    templates: [{ id: "root", kind: "root_config", spec: { nodes: {
      work: { kind: "handler", agent: { argv: [process.execPath, agent], ...extra },
        ports: { in: { direction: "receive" } } },
    } } }],
    root: { id: "job", template: "root" },
    send: [{ traceid: "job", node: "work", port: "in", payload: {} }],
  } as never);
  assert.equal(result.code, 0, result.text);
}
function readRun(dir: string) {
  const s = RunState.open(dir, { readOnly: true });
  try {
    return {
      records: s.runtime.records(),
      objects: s.store.appended(0).filter((o) => o.kind === "artifact"),
    };
  } finally { s.close(); }
}
const [mode, param] = process.argv.slice(2);

if (mode === "signal-worker") {
  const root = param!;
  const backend = new SandboxBackend({ workRoot: join(root, "work") });
  process.on("message", (m) => { if (m === "interrupt") process.emit("SIGINT"); });
  await drain(join(root, "run"), HUMAN, backend);
  process.disconnect?.();
} else if (mode === "serve") {
  const root = mkdtempSync(join(tmpdir(), "hertaloy-ui-audit-"));
  const dir = join(root, "run");
  const result = init(dir, HUMAN, {
    templates: [{ id: "root", kind: "root_config", spec: { nodes: {
      gate: { kind: "handler", handler: "collect", ports: {
        in: { direction: "receive", servo: { vars: {
          value: { type: "short", from: "$.value" },
          expect: { type: "short", from: "$.expect" },
        } } }, done: { direction: "emit" },
      } },
    } } }], root: { id: "job", template: "root" },
  } as never);
  assert.equal(result.code, 0, result.text);
  let handle = await listen({ dir, actor: HUMAN, intervalMs: 100,
    page: readFileSync(new URL("../../packages/cli/src/page.html", import.meta.url), "utf8") });
  const port = handle.port();
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-hertaloy-token": handle.token };
  const channels: Record<string, unknown> = {};
  for (const path of ["/scene", "/templates", "/authz", "/status", "/objects", "/runs"])
    channels[path] = (await fetch(base + path, { headers })).status;
  channels.POST_scene = (await fetch(base + "/scene", { headers, method: "POST" })).status;
  channels.no_token_scene = (await fetch(base + "/scene")).status;
  const publicPage = await (await fetch(base)).text();
  const embedded = /const TOKEN = "([^"]+)"/.exec(publicPage)?.[1];
  channels.page_contains_current_token = embedded === handle.token;
  channels.token_from_public_page_can_read_scene = embedded
    ? (await fetch(base + "/scene", { headers: { "x-hertaloy-token": embedded } })).status
    : null;
  writeFileSync(join(here, "browser-session.json"), JSON.stringify({ root, dir, base, channels }, null, 2));
  console.log(JSON.stringify({ root, dir, base, channels }));
  let advanced = false;
  let restarted = false;
  const timer = setInterval(async () => {
    if (!advanced && existsSync(join(root, "advance"))) {
      advanced = true;
      const sent = send(dir, HUMAN, "job", "gate", "in", { value: "audit", expect: 1 });
      const result = await drain(dir, HUMAN);
      writeFileSync(join(root, "advanced.json"), JSON.stringify({ sent, result }, null, 2));
      console.log("advanced");
    }
    if (!restarted && existsSync(join(root, "restart"))) {
      restarted = true;
      await handle.close();
      await pause(250);
      handle = await listen({ dir, actor: HUMAN, port, intervalMs: 100,
        page: readFileSync(new URL("../../packages/cli/src/page.html", import.meta.url), "utf8") });
      console.log("restarted");
    }
    if (existsSync(join(root, "stop"))) {
      clearInterval(timer);
      await handle.close();
      console.log("stopped");
    }
  }, 100);
} else {
  const root = mkdtempSync(join(tmpdir(), "hertaloy-kernel-audit-"));
  const results: Record<string, unknown> = {
    base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), root,
  };
  const signalRoot = join(root, "signal");
  mkdirSync(signalRoot);
  const agent = join(signalRoot, "agent.mjs");
  const started = join(signalRoot, "started.json");
  const released = join(signalRoot, "release");
  const marker = join(signalRoot, "after-driver-exit");
  writeFileSync(agent, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const request=JSON.parse(readFileSync('../.hertaloy/request.json','utf8'));
    writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid,executionId:request.executionId}));
    const deadline=Date.now()+20000;
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(released)}) || Date.now()>deadline){
      writeFileSync(${JSON.stringify(marker)},'child completed after driver exit');
      writeFileSync('../.hertaloy/emit.json','{}'); clearInterval(timer);
    }},50);`);
  seed(join(signalRoot, "run"), agent);
  const child = fork(fileURLToPath(import.meta.url), ["signal-worker", signalRoot], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href],
    silent: true,
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await until(() => existsSync(started) || child.exitCode !== null);
    assert.ok(existsSync(started), stderr);
    const original = JSON.parse(readFileSync(started, "utf8"));
    child.send("interrupt");
    const [exitCode] = await exited;
    let originalAliveAtRetry = false;
    let retryExecution: string | undefined;
    const retry = await drain(join(signalRoot, "run"), HUMAN, {
      async run(request) {
        retryExecution = request.executionId;
        try { process.kill(original.pid, 0); originalAliveAtRetry = true; } catch {}
        return { executionId: request.executionId, termination: "DONE", emissions: {} };
      }, async cancel() {},
    });
    writeFileSync(released, "release only our fixture");
    await pause(500);
    results.signal = { exitCode, driverLockPresent: existsSync(join(signalRoot, "run", "driver.lock")),
      originalExecution: original.executionId, retryExecution, originalAliveAtRetry,
      childCompletedAfterDriverExit: existsSync(marker), retryCode: retry.code,
      state: readRun(join(signalRoot, "run")) };
  } finally {
    writeFileSync(released, "cleanup");
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
  for (const [name, files] of Object.entries({ dotfile: { ".gitignore": "ignore" },
    duplicate_stems: { "answer.txt": "text", "answer.md": "markdown" } })) {
    const dir = join(root, name);
    const script = join(root, `${name}.mjs`);
    writeFileSync(script, `import {mkdirSync,writeFileSync} from 'node:fs';
      mkdirSync('../.hertaloy/artifacts',{recursive:true});
      for(const [name,body] of Object.entries(${JSON.stringify(files)}))
        writeFileSync('../.hertaloy/artifacts/'+name,body);
      writeFileSync('../.hertaloy/emit.json','{}');`);
    seed(dir, script);
    const outcome = await drain(dir, HUMAN, new SandboxBackend({ workRoot: join(dir, "work") }));
    results[name] = { outcome, state: readRun(dir) };
  }
  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
