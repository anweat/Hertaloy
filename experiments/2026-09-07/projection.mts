import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunState, exportSnapshot } from "../../packages/state/src/index.js";
import { init, drain, templates } from "../../packages/cli/src/state-commands.js";

const actor = { kind: "human", id: "local" } as const;
const root = mkdtempSync(join(tmpdir(), "hertaloy-projection-audit-"));
const progressDir = join(root, "progress");
const agentNode = { kind: "handler", agent: { argv: ["unused"] },
  ports: { in: { direction: "receive" } } };
assert.equal(init(progressDir, actor, {
  templates: [{ id: "root", kind: "root_config", spec: { nodes: { a: agentNode, b: agentNode } } }],
  root: { id: "job", template: "root" },
  send: ["a", "b"].map((node) => ({ traceid: "job", node, port: "in", payload: {} })),
} as never).code, 0);
const result = await drain(progressDir, actor, {
  async run(request) {
    return { executionId: request.executionId, termination: "DONE", emissions: {},
      diagnostics: { progress: { done: request.nodeId === "a" ? 1 : 9, total: 10, note: request.nodeId } } };
  }, async cancel() {},
});
assert.equal(result.code, 0, result.text);
const progressState = RunState.open(progressDir, { readOnly: true });
let progress;
try {
  progress = { expected: { a: 1, b: 9 }, projected: exportSnapshot(progressState, actor).records,
    evidence: progressState.store.history("job/$exec") };
} finally { progressState.close(); }

const templatesDir = join(root, "templates");
assert.equal(init(templatesDir, actor, {
  templates: [
    { id: "worker", kind: "container_template", spec: { nodes: {
      work: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
    } } },
    { id: "root", kind: "root_config", spec: { nodes: {}, children: {
      workers: { template: "worker@1", entry: { node: "work", port: "in" } },
    } } },
  ], root: { id: "job", template: "root" },
} as never).code, 0);
const before = templates(templatesDir, actor).data;
const s = RunState.open(templatesDir);
try {
  s.control.spawn(actor, "job", "workers", "child");
  s.persist();
} finally { s.close(); }
const after = templates(templatesDir, actor).data;
const report = { root, progress, templates: { before, after,
  pageBehavior: "page.html fetches /templates once before opening /scene/stream" } };
writeFileSync(new URL("./projection-results.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
