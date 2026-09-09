/** 同步 handler 首次失败、成功后回收、HTTP 正文和浏览器检查。 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerContainerTemplate } from "../../packages/kernel/src/index.ts";
import { RunState } from "../../packages/state/src/run-state.ts";
import { listen } from "../../packages/cli/src/serve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const dir = mkdtempSync(join(tmpdir(), "hertaloy-handler-review-"));
const actor = { kind: "human", id: "local" } as const;
const state = RunState.open(dir);
let failed: string, recovered: string;
try {
  const node = { kind: "handler", handler: "noop", ports: { in: { direction: "receive", servo: {
    vars: { value: { type: "short", from: "$.value" } },
  } } } };
  state.registry.createRoot(registerContainerTemplate(state.store, "root", {
    nodes: { failed: node, recovered: node, idle: node, filler: node },
  }, "root_config"), "handler-review");
  state.runtime.registerHandler("noop", () => ({}));
  failed = state.runtime.send({ instance: "handler-review/failed", port: "in" }, {});
  state.runtime.send({ instance: "handler-review/recovered", port: "in" }, {});
  state.runtime.drain();
  recovered = state.runtime.send({ instance: "handler-review/recovered", port: "in" }, { value: "RECOVERED" });
  state.runtime.drain();
  for (let i = 0; i < 405; i++) state.runtime.send({ instance: "handler-review/filler", port: "in" }, { value: i });
  state.runtime.drain();
  assert.equal(state.runtime.messages().some((m) => m.id === recovered), false);
  state.runtime.checkInvariants();
  state.persist();
} finally { state.close(); }

const h = await listen({ dir, actor, page: readFileSync(join(repo, "packages/cli/src/page.html"), "utf8") });
const url = `http://127.0.0.1:${h.port()}`;
writeFileSync(join(here, "handler-session.json"), JSON.stringify({ dir, url }, null, 2));
console.log(JSON.stringify({ dir, url }));
const get = async (path: string) => {
  const res = await fetch(url + path, { headers: { "x-hertaloy-token": h.token } });
  assert.equal(res.status, 200);
  return res.json();
};
try {
  const scene = await get("/scene");
  const node = (name: string) => scene.cells.find((c: any) => c.id === `handler-review#${name}`);
  assert.equal(node("failed").phase, "failed");
  assert.equal(node("idle").phase, "idle");
  assert.equal(node("recovered").phase, "done");
  assert.deepEqual(node("recovered").result.message, { id: recovered, available: false });
  const detail = await get(`/message?id=${failed}`);
  assert.match(detail.lastFailure, /value/);
  const commit = await get(`/object?ref=${encodeURIComponent(node("recovered").result.commit)}`);
  assert.deepEqual(commit.body.consumed, [recovered]);
  const results = {
    baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    mode: "real synchronous handlers + persist/reopen + HTTP",
    sceneSummary: { cells: scene.cells, tethers: scene.tethers, flowCount: scene.flows.length },
    detail, commit, invariants: "passed",
  };
  writeFileSync(join(here, "handler-results.json"), JSON.stringify(results, null, 2));
  console.log("PASS handler feedback");
  if (process.argv.includes("--hold-result")) {
    const until = Date.now() + 15 * 60 * 1000;
    while (!existsSync(join(dir, "stop"))) {
      if (Date.now() > until) throw new Error("stop gate timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
} finally { await h.close(); }
