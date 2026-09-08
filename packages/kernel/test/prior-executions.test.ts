/**
 * ★ 上游定位表 —— 执行面靠它找到"上一次那个节点留下了什么"（`workspace.from`）。
 *
 * 它替换掉的是 sandbox backend 进程内的一张 Map。那张 Map 与执行记录记的是
 * 同一件事，只是**活得更短**：不落盘、不重建，换个进程就空了。第二拷贝活得比
 * 权威短，就是"重启后工作区交接必然失败"的全部原因。
 *
 * V6 阶段 5 之后它读的是 `<traceid>/$exec`（只追加）+ 在途表，
 * 所以最后一条性质变强了：不只是 restore 之后还在，**换一个 Runtime 也还在**。
 */

import { beforeEach, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

const agentNode = { kind: "handler", agent: { argv: ["x"] }, ports: { in: { direction: "receive" } } };
const TEMPLATE = { nodes: { build: agentNode, test: agentNode }, edges: {}, children: {} };

let store: ObjectStore; let reg: InstanceRegistry;
beforeEach(() => {
  store = new ObjectStore();
  reg = new InstanceRegistry(store);
  const ref = registerContainerTemplate(store, "root", TEMPLATE, "root_config");
  reg.createRoot(ref, "job-1");
});

/** 跑完一次，返回它的 executionId。 */
function runOnce(rt: Runtime, trace: string, node: string, termination = "DONE"): string {
  rt.send({ traceid: trace, node, port: "in" }, {});
  const claimed = rt.claimAgent();
  if (claimed.kind !== "claimed") throw new Error(`没 claim 到 ${node}`);
  const id = claimed.record.executionId;
  rt.applyAgentResult(id, { executionId: id, emissions: {}, termination });
  return id;
}

/** 下一次 claim 拿到的上游表。 */
function priorOf(rt: Runtime, trace: string, node: string): Record<string, string> {
  rt.send({ traceid: trace, node, port: "in" }, {});
  const claimed = rt.claimAgent();
  if (claimed.kind !== "claimed") throw new Error("没 claim 到");
  return { ...claimed.request.priorExecutions };
}

it("同一节点后写的覆盖先写的", () => {
  const rt = new Runtime(store, reg);
  runOnce(rt, "job-1", "build");
  const second = runOnce(rt, "job-1", "build");
  expect(priorOf(rt, "job-1", "test").build).toBe(second);
});

it("多个节点各占一格", () => {
  const rt = new Runtime(store, reg);
  const b = runOnce(rt, "job-1", "build");
  const t = runOnce(rt, "job-1", "test");
  expect(priorOf(rt, "job-1", "build")).toEqual({ build: b, test: t });
});

it("★ VOIDED 不进表 —— 那个状态的意思正是「这次不算数」", () => {
  const rt = new Runtime(store, reg);
  const good = runOnce(rt, "job-1", "build");

  /**
   * 直接在对象库里放一版 VOIDED —— 那正是 `#apply` 的冲突域复核会写出的形状
   * （`#settleExecution({...record, status: "VOIDED"})`）。
   *
   * 不走运行时构造它：`truncate` 与 `reconcile` 都会先把在途记录结算掉，
   * 迟到的 apply 于是撞在 `#closedResult` 上而不是冲突域复核上。
   */
  store.put("job-1/$exec", "execution", {
    execution_id: "exec-voided", node: "build",
    status: "VOIDED", claimed: [], generation: 0,
  }, { traceid: "job-1", node_id: "build", execution_id: "exec-voided", derived_from: [] });

  // 表回退到上一次真正算数的
  expect(priorOf(rt, "job-1", "test").build).toBe(good);
});

it("★ 按实例限定 —— 兄弟实例的执行不串过来", () => {
  const leaf = registerContainerTemplate(store, "leaf", TEMPLATE);
  const rootRef = registerContainerTemplate(store, "root2",
    { nodes: {}, edges: {}, children: { k: { template: leaf } } }, "root_config");
  const reg2 = new InstanceRegistry(store);
  reg2.createRoot(rootRef, "job");
  reg2.spawn("job", "k", "a");
  reg2.spawn("job", "k", "b");
  const rt = new Runtime(store, reg2);

  const a = runOnce(rt, "job/a", "build");
  runOnce(rt, "job/b", "build");
  expect(priorOf(rt, "job/a", "test").build).toBe(a);
  expect(priorOf(rt, "job/b", "test").build).not.toBe(a);
});

it("★ 换一个 Runtime 仍然在 —— 它在只追加的对象库里，不在进程内存里", () => {
  const first = new Runtime(store, reg);
  const build = runOnce(first, "job-1", "build");

  // 新 Runtime、同一个对象库：这正是"重启后工作区交接"的场景
  const reborn = new Runtime(store, reg);
  expect(priorOf(reborn, "job-1", "test").build).toBe(build);
});
