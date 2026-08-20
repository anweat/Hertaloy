/** 临时脚本：造一个覆盖四种元素的真实 run，落盘后把 head 打出来。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "./src/run-state.js";

const dir = mkdtempSync(join(tmpdir(), "fixture-"));
const s = RunState.open(dir);

// 子模板：一个 worker，往隧道上发现问题
const worker = registerContainerTemplate(s.store, "worker", {
  nodes: {
    scan: {
      kind: "handler",
      handler: "emit",
      ports: {
        in: { direction: "receive", servo: { vars: {} } },
        found: { direction: "emit", tunnel: "findings" },
        out: { direction: "emit" },
      },
    },
    wrap: {
      kind: "handler",
      handler: "noop",
      ports: { got: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: { e: { from: { node: "scan", port: "out" }, to: { node: "wrap", port: "got" } } },
  children: {},
  subscriptions: {},
});

const root = registerContainerTemplate(
  s.store,
  "root",
  {
    nodes: {
      plan: {
        kind: "handler",
        handler: "emit",
        ports: {
          start: { direction: "receive", servo: { vars: {} } },
          out: { direction: "emit" },
        },
      },
      merge: {
        kind: "handler",
        handler: "noop",
        ports: {
          got: { direction: "receive", servo: { vars: {} } },
          exit: { direction: "receive", servo: { vars: {} } },
        },
      },
      watch: {
        kind: "handler",
        handler: "noop",
        ports: { heard: { direction: "receive", servo: { vars: {} } } },
      },
      idle: {
        kind: "handler",
        handler: "noop",
        ports: { never: { direction: "receive", servo: { vars: {} } } },
      },
    },
    edges: { p: { from: { node: "plan", port: "out" }, to: { node: "merge", port: "got" } } },
    children: {
      a: { template: worker, entry: { node: "scan", port: "in" }, exit: { node: "merge", port: "exit" } },
      b: { template: worker, entry: { node: "scan", port: "in" }, exit: { node: "merge", port: "exit" } },
    },
    subscriptions: {
      listen: { tunnel: "findings", to: { node: "watch", port: "heard" } },
      // 声明了但从没人往这儿发 —— certainty 恒 0 的那根须
      quiet: { tunnel: "silence", to: { node: "idle", port: "never" } },
    },
  },
  "root_config",
);

s.registry.createRoot(root, "job-1");
s.runtime.registerHandler("emit", (_v, ctx) => {
  ctx.put(`note-${ctx.nodeId}`, "artifact", { text: `${ctx.nodeId} 的产出` });
  return { out: { ok: true }, ...(ctx.port === "in" ? { found: { what: "看这儿" } } : {}) };
});
s.runtime.registerHandler("noop", () => ({}));

s.runtime.send({ traceid: "job-1", node: "plan", port: "start" }, {});
const a = s.registry.spawn("job-1", "a", "a1");
const b = s.registry.spawn("job-1", "b", "b1");
s.runtime.send({ traceid: a.traceid, node: "scan", port: "in" }, {});
s.runtime.send({ traceid: b.traceid, node: "scan", port: "in" }, {});
s.runtime.drain();
s.persist();

import { exportSnapshot } from "./src/snapshot.js";
console.log(JSON.stringify(exportSnapshot(s), null, 1));
s.close();
