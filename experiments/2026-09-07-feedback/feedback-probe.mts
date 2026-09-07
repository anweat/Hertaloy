/** Audit only: isolated runs, actual projection code, page data functions, local HTTP. */
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { RunState, exportSnapshot } from "../../packages/state/src/index.js";
import { buildScene, parseSnapshot, diffScenes, emptyScene } from "../../packages/scene/src/index.js";
import { init } from "../../packages/cli/src/state-commands.js";
import { listen } from "../../packages/cli/src/serve.js";

const actor = { kind: "human", id: "local" } as const;
const root = process.argv[3] ?? mkdtempSync(join(tmpdir(), "hertaloy-feedback-"));
const page = readFileSync(new URL("../../packages/cli/src/page.html", import.meta.url), "utf8");
function seed(dir: string) {
  const r = init(dir, actor, {
    templates: [{ id: "root", kind: "root_config", spec: { nodes: {
      work: { kind: "handler", agent: { argv: ["fixture"] },
        ports: { in: { direction: "receive" } } },
    } } }], root: { id: "job", template: "root" },
    send: [{ traceid: "job", node: "work", port: "in", payload: {} }],
  } as never);
  assert.equal(r.code, 0, r.text);
}

if (process.argv[2] === "stream-worker") {
  const server = await listen({ dir: root, actor: { kind: "agent", id: "denied-reader" }, intervalMs: 20 });
  process.send?.({ port: server.port(), token: server.token });
  process.once("message", async () => { await server.close(); process.disconnect?.(); });
} else {
  const report: Record<string, unknown> = {
    base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), root,
  };
  const dir = join(root, "retry");
  seed(dir);
  const s = RunState.open(dir);
  try {
    const cursor = () => {
      const h = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
      return { seq: h.runtime.seq, objects: h.objectCursor, config: "unchanged" };
    };
    const before = cursor();
    const first = s.runtime.claimAgent();
    assert.equal(first.kind, "claimed");
    if (first.kind !== "claimed") throw new Error("fixture failed to claim");
    s.persist();
    const after = cursor();
    report.draftCursor = { before, after, changed: JSON.stringify(before) !== JSON.stringify(after),
      messageState: s.runtime.messages()[0]?.state, executionStatus: s.runtime.records()[0]?.status };

    s.runtime.applyAgentResult(first.record.executionId, {
      executionId: first.record.executionId, termination: "FAILED", emissions: {},
      diagnostics: { progress: { done: 1, total: 10 }, stderrTail: "first attempt failed" },
    });
    const second = s.runtime.claimAgent();
    assert.equal(second.kind, "claimed");
    if (second.kind !== "claimed") throw new Error("fixture failed to retry");
    const during = buildScene(parseSnapshot(exportSnapshot(s, actor))).cells.find((c) => c.id === "job#work");
    s.runtime.applyAgentResult(second.record.executionId, {
      executionId: second.record.executionId, termination: "DONE", emissions: {},
      diagnostics: { progress: { done: 9, total: 10 } },
      artifacts: [{ object_id: "reports/result.md", kind: "artifact", body: { text: "report" }, derived_from: [] }],
    });
    s.persist();
    const snap = exportSnapshot(s, actor);
    const afterScene = buildScene(parseSnapshot(snap));
    report.latestAttempt = { records: s.runtime.records(), snapshotRecords: snap.records,
      whileSecondRunning: { phase: during?.phase, progress: during?.progress },
      afterSecondSucceeded: afterScene.cells.find((c) => c.id === "job#work"),
      messageFact: s.runtime.messages()[0], messageProjection: snap.messages[0] };
    const artifact = s.store.head("job/reports/result.md");
    const card = afterScene.cards.find((c) => c.id === artifact.object_id);
    report.artifactOwner = { actualOwner: artifact.provenance.traceid, card,
      projectedOwnerExists: afterScene.cells.some((c) => c.id === card?.owner) };
  } finally { s.close(); }

  // Execute only the existing page's data functions in a VM; no browser/DOM interaction.
  const module = page.split('<script type="module">')[1]!.split("</script>")[0]!;
  const tail = 'main().catch((e) => status("出错：" + e.message));';
  assert.ok(module.includes(tail));
  let fetches = 0;
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener() {} }) }, addEventListener() {},
    fetch: async () => { fetches++; return { ok: true, json: async () => ({ "root@1": {} }) }; },
  });
  vm.runInContext(module.replace(tail, "") + `\n globalThis.audit = {
    apply, topUpTemplates, snapshot: () => JSON.parse(JSON.stringify(scene)),
    reset: (next) => { scene = next; }
  };`, context);
  const client = context.audit;
  const waiting = { ...emptyScene("job"), tethers: [{ from: "job", to: "job/child", relation: "waits", because: "child" }] };
  client.reset(emptyScene("job"));
  client.apply(diffScenes(emptyScene("job"), waiting as never));
  const removal = diffScenes(waiting as never, emptyScene("job"));
  client.apply(removal);
  report.waitRemoval = { serverRemoved: removal.tethers.removed, clientRemaining: client.snapshot().tethers };

  const rootCell = { id: "job", parent: null, kind: "instance", identity: "root@1" };
  const oldFlow = { id: "signal:msg-1", from: null, to: { cell: "job#work", port: "in" },
    certainty: 1, activity: 1, at: [1] };
  const oldScene = { ...emptyScene("job"), cells: [rootCell], flows: [oldFlow] };
  const currentScene = { ...emptyScene("job"), cells: [rootCell] };
  client.reset(oldScene);
  // Each new watchScene connection emits a delta from an empty scene.
  // The old flow may have left the bounded message window while disconnected.
  client.apply(diffScenes(emptyScene("job"), currentScene as never));
  report.reconnectBaseline = { currentServerFlows: [], clientFlowsAfterNewBaseline: client.snapshot().flows };

  client.reset({ ...emptyScene("job"), cells: [
    { kind: "instance", identity: "root@1" }, { kind: "slot", identity: "worker@1" },
  ] });
  await client.topUpTemplates();
  await client.topUpTemplates();
  report.unspawnedSlot = { missingRef: "worker@1", topUps: 2, templateRequests: fetches,
    note: "The actual /templates endpoint only supplies templates of existing instances." };

  // Same local HTTP port, new process lifetime/token: the old page credential is stale.
  let server = await listen({ dir, actor, page, intervalMs: 20 });
  const port = server.port();
  const oldToken = server.token;
  await server.close();
  server = await listen({ dir, actor, page, intervalMs: 20, port });
  try {
    const get = (token: string) => fetch(`http://127.0.0.1:${port}/scene`, { headers: { "x-hertaloy-token": token } });
    report.restartCredential = { oldPageStatus: (await get(oldToken)).status,
      freshPageStatus: (await get(server.token)).status };
  } finally { await server.close(); }

  const badDir = join(root, "malformed-progress");
  seed(badDir);
  const badState = RunState.open(badDir);
  try {
    const claimed = badState.runtime.claimAgent();
    if (claimed.kind !== "claimed") throw new Error("fixture failed to claim");
    badState.runtime.applyAgentResult(claimed.record.executionId, {
      executionId: claimed.record.executionId, termination: "DONE", emissions: {},
      diagnostics: { progress: { done: "three", total: 10 } },
    });
    badState.persist();
    let projectionError: string | null = null;
    try { parseSnapshot(exportSnapshot(badState, actor)); }
    catch (error) { projectionError = String(error); }
    report.optionalTelemetry = { execution: badState.runtime.records()[0], projectionError };
  } finally { badState.close(); }

  // An intentionally denied reader must receive an error without killing the observer server.
  const child = fork(fileURLToPath(import.meta.url), ["stream-worker", dir], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href], silent: true,
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (c) => { stderr += String(c); });
  const watchdog = setTimeout(() => child.kill(), 12_000);
  try {
    const [address] = await once(child, "message") as [{ port: number; token: string }];
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "x-hertaloy-token": address.token };
    const singleStatus = (await fetch(base + "/scene", { headers })).status;
    let streamStatus: number | null = null;
    let streamError: string | null = null;
    try {
      const response = await fetch(base + "/scene/stream", { headers });
      streamStatus = response.status;
      await response.text();
    } catch (e) { streamError = String(e); }
    const [exitCode, signal] = await exited;
    report.deniedStream = { singleStatus, streamStatus, streamError, exitCode, signal,
      stderr: stderr.slice(-2500) };
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
  writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
