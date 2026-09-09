/**
 * ★ V6 阶段 1a：同步节点也留执行记录。
 *
 * `ExecutionRecord` 今天只覆盖 agent 节点。理由一直写成"三段式的账是给
 * '外面有进程在跑、崩了要接管'用的，同步 handler 没有这个需要"——
 * 那句话解释的是**为什么需要 RUNNING 这个状态**，不是**为什么不该有记录**。
 *
 * 后果是渲染层拿不到"这个节点跑过没有、怎么结束的"，只能从 `$run` 与消息
 * 状态里拼——本轮已经为此打了三块补丁（`RunSnapshot.commits`、
 * `stateOfNode` 的重建、`Cell.result`）。
 *
 * V6 模型里节点就是实例，实例跑一次就是一次执行。所以补的不是投影，
 * 是**那条本来就该有的记录**。
 */

import { beforeEach, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

const TEMPLATE = {
  nodes: {
    ok: {
      kind: "handler", handler: "pass",
      ports: {
        in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } },
        out: { direction: "emit" },
      },
    },
    sink: { kind: "handler", handler: "noop", ports: { got: { direction: "receive" } } },
    idle: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
  },
  edges: { e: { from: { node: "ok", port: "out" }, to: { node: "sink", port: "got" } } },
  children: {},
};

let store: ObjectStore; let reg: InstanceRegistry; let rt: Runtime;
beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "root", TEMPLATE, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job");
  rt = new Runtime(store, reg);
  rt.registerHandler("pass", (vars) => ({ out: { v: vars.v ?? null } }));
  rt.registerHandler("noop", () => ({}));
});

it("★ 同步节点跑完留一条执行记录：SETTLED / DONE，认领的是那条消息", () => {
  rt.send({ instance: "job/ok", port: "in" }, { v: 1 });
  rt.drain();

  const records = rt.records();
  expect(records.map((r) => r.nodeId).sort()).toEqual(["ok", "sink"]);
  const ok = records.find((r) => r.nodeId === "ok");
  expect(ok?.status).toBe("SETTLED");
  expect(ok?.termination).toBe("DONE");
  expect(ok?.claimed).toHaveLength(1);
  expect(ok?.traceid).toBe("job");
  // 没跑过的节点仍然一条都没有 —— 记录是"跑过"的证据，不是"存在"的证据
  expect(records.some((r) => r.nodeId === "idle")).toBe(false);
});

it("★ 入站校验失败也留记录 —— 首次就失败的节点不能看起来像没跑过", () => {
  // servo 取不到 $.v
  rt.send({ instance: "job/ok", port: "in" }, { 别的: 1 });
  rt.drain();

  const ok = rt.records().find((r) => r.nodeId === "ok");
  expect(ok).toBeDefined();
  expect(ok?.status).toBe("SETTLED");
  expect(ok?.termination).not.toBe("DONE");
  expect(rt.message("msg-1").state).toBe("FAILED");
});

it("同步记录不产生义务，也不挡住终止 —— 它已经是 SETTLED", () => {
  rt.send({ instance: "job/ok", port: "in" }, { v: 1 });
  rt.drain();
  expect(rt.obligations("job").filter((o) => o.kind === "execution")).toEqual([]);
  expect(rt.canTerminate("job")).toBe(true);
  rt.checkInvariants();
});

it("记录随事务回滚 —— handler 抛异常不留半条", () => {
  rt.registerHandler("boom", () => { throw new Error("炸"); });
  const ref = registerContainerTemplate(store, "boom", {
    nodes: { n: { kind: "handler", handler: "boom", ports: { in: { direction: "receive" } } } },
    edges: {}, children: {},
  }, "root_config");
  const s2 = new ObjectStore();
  const r2 = registerContainerTemplate(s2, "boom", {
    nodes: { n: { kind: "handler", handler: "boom", ports: { in: { direction: "receive" } } } },
    edges: {}, children: {},
  }, "root_config");
  void ref;
  const reg2 = new InstanceRegistry(s2);
  reg2.createRoot(r2, "job2");
  const rt2 = new Runtime(s2, reg2);
  rt2.registerHandler("boom", () => { throw new Error("炸"); });
  rt2.send({ instance: "job2/n", port: "in" }, {});
  expect(() => rt2.drain()).toThrow("炸");
  expect(rt2.records()).toEqual([]);
});
