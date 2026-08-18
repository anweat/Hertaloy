/**
 * 批 G2：子槽回程 —— 剧本帧 8 → 12 → 13 的**自动**链路。
 *
 * 之前这条链是断的：`settle` 只释放锁、不叫醒父容器，所以汇聚要靠人手动
 * 往 merge 节点发消息。真实工作流里没人会手动发。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

/** 子容器：干活 → 写产物 → 什么都不发（干完就完） */
const coderSpec = {
  nodes: {
    work: {
      kind: "handler",
      handler: "code",
      ports: {
        in: { direction: "receive", servo: { vars: { task: { type: "short", from: "$.task" } } } },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let merged: unknown[];
let notices: string[];

function build(withExit: boolean): void {
  store = new ObjectStore();
  const coder = registerContainerTemplate(store, "coder", coderSpec);
  const root = registerContainerTemplate(
    store,
    "root",
    {
      nodes: {
        plan: {
          kind: "handler",
          handler: "plan",
          ports: {
            in: {
              direction: "receive",
              servo: { vars: { tasks: { type: "short", from: "$.tasks" } } },
            },
          },
        },
        merge: {
          kind: "handler",
          handler: "merge",
          ports: {
            done: {
              direction: "receive",
              servo: { vars: { slot: { type: "short", from: "$.slot" } } },
            },
            again: { direction: "emit" },
          },
        },
      },
      edges: {},
      children: {
        coders: {
          template: coder,
          entry: { node: "work", port: "in" },
          ...(withExit ? { exit: { node: "merge", port: "done" } } : {}),
        },
      },
      subscriptions: {},
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(root, "job-1");
  rt = new Runtime(store, reg);
  merged = [];
  notices = [];

  rt.registerHandler("plan", (vars, ctx) => {
    const tasks = vars.tasks as string[];
    tasks.forEach((task, i) => ctx.spawn("coders", `coder-${i + 1}`, { task }));
    return {};
  });
  rt.registerHandler("code", (vars, ctx) => {
    ctx.put("result", "result", { task: vars.task ?? null });
    return {};
  });
  rt.registerHandler("merge", (vars, ctx) => {
    notices.push(String(vars.slot));
    // 通知只带"谁完了"，内容靠 collect 从版本层取（C5）
    const all = ctx.collect("job-1", "result");
    if (all.length < 3) return {};
    // 幂等靠**版本历史**，不靠节点里的计数器（C5：版本历史即状态）。
    // 三个子同批 settle → 三条通知，产物那时都已齐备，三条都满足 >= 3。
    if (ctx.history("epoch").length > 0) return {};
    ctx.put("epoch", "marker", { at: all.length });
    merged.push(all.map((o) => o.body.task ?? null));
    return {};
  });
}

/** 跑到没活为止：drain → settle → 再 drain（settle 会产生新通知）。 */
function runToQuiescence(): void {
  for (let i = 0; i < 20; i += 1) {
    rt.drain();
    if (rt.settleAll().length === 0 && rt.pending().length === 0) return;
  }
  throw new Error("没有收敛");
}

describe("★ 帧 8 → 12：扇出后自动汇聚", () => {
  beforeEach(() => build(true));

  it("三个 coder 干完 → 各自 settle → 父被通知三次 → 第三次才汇聚", () => {
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: ["a", "b", "c"] });
    runToQuiescence();

    // 三个子各投一条回程通知 —— 一个子一条，不多不少
    expect(notices).toEqual(["coders", "coders", "coders"]);
    // 但只汇聚一次：幂等由 `epoch` 的版本历史挡住，不是靠只收到一条通知
    expect(merged).toEqual([["a", "b", "c"]]);
    expect(reg.get("job-1").status).toBe("TERMINAL");
    rt.checkInvariants();
  });

  it("通知只带谁完了，不带产出 —— 内容在资产里（C5）", () => {
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: ["x"] });
    rt.drain();
    rt.settleAll();

    const notice = rt.messages().find((m) => m.target.node === "merge");
    expect(notice?.payload).toEqual({
      slot: "coders",
      traceid: "job-1/coder-1",
      status: "TERMINAL",
    });
  });

  it("父容器在子完成前不会自然终止（child 锁挡着）", () => {
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: ["a"] });
    rt.drain();
    expect(rt.canTerminate("job-1")).toBe(false);
    expect(rt.terminationBlockers("job-1")[0]).toMatch(/锁 child/);
  });
});

describe("★ 没声明 exit 就是断链 —— 这正是修之前的状态", () => {
  beforeEach(() => build(false));

  it("子干完了，父的 merge 节点永远等不到触发", () => {
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: ["a", "b", "c"] });
    runToQuiescence();

    expect(store.collect("job-1", "result")).toHaveLength(3); // 活干完了
    expect(merged).toEqual([]); // 但没人汇聚
  });
});

describe("注册期校验：exit 指本模板，entry 指子模板", () => {
  it("exit 指向不存在的本地节点 → 拒绝并说清方向", () => {
    const s = new ObjectStore();
    const coder = registerContainerTemplate(s, "coder", coderSpec);
    expect(() =>
      registerContainerTemplate(s, "bad", {
        nodes: {},
        edges: {},
        children: { k: { template: coder, exit: { node: "ghost", port: "in" } } },
        subscriptions: {},
      }),
    ).toThrow(/exit 指本模板，entry 才指子模板/);
  });
});
