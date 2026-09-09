/**
 * ★ V6 阶段 5（记录那半）：终态执行归 append-only 的对象库，头只留在途。
 *
 * 阶段 1a 之后每条消息都留一条记录，而**头每次提交全量重写**、记录没有任何
 * 上界（队列还有 `keepConsumedMessages` 压着）。实测 M=2000 → head.json
 * 761 KiB / 记录 2000 条（`experiments/2026-09-07-perf/head-growth.mts`）。
 *
 * 但真正的判据不是规模，是**一次终态执行被记了两遍**：
 *
 *   ExecutionLedger.#records   {executionId, traceid, nodeId, status, termination, claimed, generation, usage}
 *   <traceid>/$exec 一版        {execution_id, node,          termination,                          usage, diagnostics}
 *
 * 四个字段重叠，`termination` 是语义最重的那个。而 §10 给了判据：
 * **终态记录不参与任何控制决策**（义务只看 RUNNING、孤儿只看 RUNNING、
 * 冲突域只看 RUNNING）。它是历史，属于只追加的对象库，不属于可变头。
 */

import { beforeEach, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

const TEMPLATE = {
  nodes: { n: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {}, children: {},
};

let store: ObjectStore; let reg: InstanceRegistry; let rt: Runtime;
beforeEach(() => {
  store = new ObjectStore();
  reg = new InstanceRegistry(store);
  reg.createRoot(registerContainerTemplate(store, "root", TEMPLATE, "root_config"), "job");
  rt = new Runtime(store, reg);
  rt.registerHandler("noop", () => ({}));
});

it("★ 终态记录不留在头里 —— 落盘形状只装在途的", () => {
  for (let i = 0; i < 5; i += 1) rt.send({ instance: "job/n", port: "in" }, {});
  rt.drain();

  const head = rt.snapshot() as { records: Map<string, unknown> };
  expect(head.records.size).toBe(0);
  // 而对象库里一次执行一版
  expect(store.history("job/n/$exec")).toHaveLength(5);
});

it("★ 查得到照旧 —— records() 与 record(id) 合并在途与历史", () => {
  rt.send({ instance: "job/n", port: "in" }, {});
  rt.drain();

  const all = rt.records();
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("SETTLED");
  expect(all[0]?.termination).toBe("DONE");
  expect(all[0]?.nodeId).toBe("n");
  expect(rt.record(all[0]!.executionId).termination).toBe("DONE");
});

it("在途的仍然在头里 —— 那是崩溃恢复要的唯一一份", () => {
  const backend = { async run() { return await new Promise<never>(() => {}); }, async cancel() {} };
  const rt2 = new Runtime(store, reg, { backend });
  const agentRef = registerContainerTemplate(store, "agent", {
    nodes: { a: { kind: "handler", agent: { argv: ["x"] }, ports: { in: { direction: "receive" } } } },
    edges: {}, children: {},
  }, "root_config");
  const reg2 = new InstanceRegistry(store);
  reg2.createRoot(agentRef, "job2");
  const rt3 = new Runtime(store, reg2, { backend });
  rt3.send({ instance: "job2/a", port: "in" }, {});
  const claimed = rt3.claimAgent();
  expect(claimed.kind).toBe("claimed");

  const head = rt3.snapshot() as { records: Map<string, unknown> };
  expect(head.records.size).toBe(1);
  expect(rt3.records().filter((r) => r.status === "RUNNING")).toHaveLength(1);
  void rt2;
});

it("义务与不变量只看在途的 —— 终态搬走不影响它们", () => {
  for (let i = 0; i < 3; i += 1) rt.send({ instance: "job/n", port: "in" }, {});
  rt.drain();
  expect(rt.obligations("job").filter((o) => o.kind === "execution")).toEqual([]);
  expect(rt.canTerminate("job")).toBe(true);
  rt.checkInvariants();
});
