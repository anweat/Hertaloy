/**
 * 批 G：容器工具 —— 从节点内建子容器（剧本帧 8）。
 *
 * 帧 8 的完整形状不只是"建三个 coder"，还包括**活怎么进去**：
 * 给 coder-1 派 task-1、给 coder-2 派 task-2。靠子槽声明的 `entry`。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepResult } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";

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
let coderRef: string;
let done: string[];

function buildRoot(entry: unknown): void {
  const rootRef = registerContainerTemplate(
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
      },
      edges: {},
      children: { coders: entry === undefined ? { template: coderRef } : { template: coderRef, entry } },
      subscriptions: {},
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(rootRef, "job-1");
  rt = new Runtime(store, reg);
  rt.registerHandler("code", (vars) => {
    done.push(String(vars.task));
    return {};
  });
}

beforeEach(() => {
  store = new ObjectStore();
  coderRef = registerContainerTemplate(store, "coder-flow", coderSpec);
  done = [];
});

describe("剧本帧 8：按 plan 扇出子容器并派活", () => {
  it("★ 一个 handler 建三个 coder，各拿各的任务", () => {
    buildRoot({ node: "work", port: "in" });
    rt.registerHandler("plan", (vars, ctx) => {
      const tasks = vars.tasks as string[];
      tasks.forEach((task, i) => {
        ctx.spawn("coders", `coder-${i + 1}`, { task });
      });
      return {};
    });

    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: ["a", "b", "c"] });
    rt.drain();

    expect(reg.children("job-1").map((i) => i.traceid)).toEqual([
      "job-1/coder-1",
      "job-1/coder-2",
      "job-1/coder-3",
    ]);
    expect(done).toEqual(["a", "b", "c"]);
    // 三个子容器各记一把 child 锁在父身上
    expect(rt.locks.held("job-1").filter((l) => l.kind === "child")).toHaveLength(3);
    rt.checkInvariants();
  });

  it("不传 payload 就只建空壳", () => {
    buildRoot({ node: "work", port: "in" });
    rt.registerHandler("plan", (_v, ctx) => {
      ctx.spawn("coders", "empty");
      return {};
    });
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: [] });
    rt.drain();
    expect(reg.has("job-1/empty")).toBe(true);
    expect(done).toEqual([]);
  });
});

describe("第一不变量：只能选已声明的槽", () => {
  it("未声明的槽被拒，并列出可用槽", () => {
    buildRoot({ node: "work", port: "in" });
    rt.registerHandler("plan", (_v, ctx) => {
      ctx.spawn("reviewers", "r1", {});
      return {};
    });
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: [] });
    expect(() => rt.drain()).toThrow(/未声明子槽 `reviewers`。可用子槽：coders/);
  });

  it("槽没声明 entry 就投不进初始载荷", () => {
    buildRoot(undefined);
    rt.registerHandler("plan", (_v, ctx) => {
      ctx.spawn("coders", "c1", { task: "x" });
      return {};
    });
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: [] });
    expect(() => rt.drain()).toThrow(/未声明 entry，无法投递初始载荷/);
  });
});

describe("跨模板校验：entry 指向子模板里的真实端点", () => {
  it("★ entry 指向不存在的节点 → 注册期拒绝并列出子模板可用节点", () => {
    expect(() =>
      registerContainerTemplate(store, "bad-entry", {
        nodes: {},
        edges: {},
        children: { coders: { template: coderRef, entry: { node: "ghost", port: "in" } } },
        subscriptions: {},
      }),
    ).toThrow(/无节点 `ghost`。可用节点：work/);
  });

  it("entry 指向 emit 端口 → 注册期拒绝", () => {
    const withEmit = registerContainerTemplate(store, "emitter", {
      nodes: {
        n: {
          kind: "handler",
          handler: "noop",
          ports: { in: { direction: "receive" }, out: { direction: "emit" } },
        },
      },
      edges: {},
      children: {},
      subscriptions: {},
    });
    expect(() =>
      registerContainerTemplate(store, "bad-dir", {
        nodes: {},
        edges: {},
        children: { k: { template: withEmit, entry: { node: "n", port: "out" } } },
        subscriptions: {},
      }),
    ).toThrow(/必须是子模板里已声明的 receive 端口。可用：in/);
  });
});

describe("spawn 随提交事务（批 0）", () => {
  it("★ 建完子容器后 handler 抛异常 → 子容器与 child 锁一并撤销", () => {
    buildRoot({ node: "work", port: "in" });
    rt.registerHandler("plan", (_v, ctx) => {
      ctx.spawn("coders", "doomed", { task: "x" });
      throw new Error("建完就炸");
    });
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: [] });

    expect(() => rt.drain()).toThrow("建完就炸");
    expect(reg.has("job-1/doomed")).toBe(false);
    expect(rt.locks.held("job-1")).toEqual([]);
    rt.checkInvariants();
  });
});

describe("与自然终止串起来", () => {
  it("子容器做完后 settleAll 自底向上收干净", () => {
    buildRoot({ node: "work", port: "in" });
    rt.registerHandler("plan", (_v, ctx) => {
      ctx.spawn("coders", "c1", { task: "a" });
      return {};
    });
    rt.send({ traceid: "job-1", node: "plan", port: "in" }, { tasks: [] });
    rt.drain();

    expect(rt.canTerminate("job-1")).toBe(false); // child 锁挡着
    expect(rt.settleAll()).toEqual(["job-1/c1", "job-1"]);
    expect(reg.get("job-1").status).toBe("TERMINAL");
    rt.checkInvariants();
  });
});
