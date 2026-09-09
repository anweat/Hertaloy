/**
 * 调度缝 —— 内核唯一真正的策略注入点。
 *
 * 这个文件要钉的不是"能不能换"，是**换了之后哪些性质仍然成立**：
 *
 *   1. 默认是 FIFO，行为与没有这条缝时逐字一样
 *   2. 换掉它能改变顺序 —— 缝是通的，不是"实现在、路不通"
 *   3. **换不坏不变量**：候选集由内核筛，调度器只排序不放行；
 *      返回候选集外的东西当场抛，而不是静默变成"本轮空闲"
 *
 * 第 3 条是这条缝敢开的全部理由。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepResult } from "../src/runtime.js";
import { type Candidate, type Scheduler, acceptedPick, fifo } from "../src/scheduling.js";
import { InvariantError } from "../src/errors.js";
import { containerOf, lastSegment } from "@nodeflow/contracts";

const leafSpec = {
  nodes: {
    a: {
      kind: "handler",
      handler: "sink",
      ports: { in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } } },
    },
    b: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: { in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } } },
    },
  },
  edges: {},
  children: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let seen: unknown[];

function build(scheduler?: Scheduler): Runtime {
  const rt = new Runtime(store, reg, scheduler === undefined ? {} : { scheduler });
  rt.registerHandler("sink", (vars) => {
    seen.push(vars.v);
    return {};
  });
  return rt;
}

beforeEach(() => {
  store = new ObjectStore();
  const leaf = registerContainerTemplate(store, "leaf", leafSpec);
  const root = registerContainerTemplate(
    store,
    "root",
    { nodes: {}, edges: {}, children: { kids: { template: leaf } } },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(root, "job-1");
  seen = [];
});

function sendThree(rt: Runtime): void {
  rt.spawn("job-1", "kids", "k1");
  for (const v of [1, 2, 3]) {
    rt.send({ instance: "job-1/k1/a", port: "in" }, { v });
  }
}

describe("默认 FIFO", () => {
  it("先到先跑", () => {
    const rt = build();
    sendThree(rt);
    rt.drain();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("`fifo` 就是取候选集的第一个；空集给 null", () => {
    const c = (id: string, position: number): Candidate => ({
      message: { id, target: { instance: "job-1/a" }, state: "QUEUED" },
      position,
    });
    const list = [c("msg-1", 0), c("msg-2", 1)];
    expect(fifo(list)).toBe(list[0]);
    expect(fifo([])).toBeNull();
  });
});

describe("★ 缝是通的", () => {
  it("换成后进先出，顺序真的反过来", () => {
    const lifo: Scheduler = (candidates) => candidates[candidates.length - 1] ?? null;
    const rt = build(lifo);
    sendThree(rt);
    rt.drain();
    expect(seen).toEqual([3, 2, 1]);
  });

  it("按载荷挑 —— 调度器读得到消息本身", () => {
    // 只是证明候选带着足够的信息；真策略不该读载荷，这里是为了可观察
    const byNode: Scheduler = (candidates) =>
      candidates.find((c) => lastSegment(c.message.target.instance) === "a") ?? candidates[0] ?? null;
    const rt = build(byNode);
    sendThree(rt);
    rt.drain();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("总是不挑 → 立刻收敛成空闲，不是转圈", () => {
    const idle: Scheduler = () => null;
    const rt = build(idle);
    sendThree(rt);
    // drain 不会卡死，也不会抛"未收敛"
    expect(rt.drain()).toEqual([]);
    expect(seen).toEqual([]);
    // 消息还在队列里 —— 它只是不干活，没把系统弄坏
    expect(rt.pending()).toHaveLength(3);
  });
});

describe("★ 换不坏不变量", () => {
  it("候选集已经由内核筛过：只有 QUEUED、实例 OPEN、节点种类对得上的", () => {
    let offered: readonly Candidate[] = [];
    const spy: Scheduler = (candidates) => {
      offered = candidates;
      return candidates[0] ?? null;
    };
    const rt = build(spy);
    rt.spawn("job-1", "kids", "k1");
    rt.spawn("job-1", "kids", "k2");
    rt.send({ instance: "job-1/k1/a", port: "in" }, { v: 1 });
    // 这条投给 agent 节点 —— 同步路径不该看见它
    rt.send({ instance: "job-1/k1/b", port: "in" }, { v: 9 });
    // 这条投给一个随即被截断的实例 —— 也不该看见
    rt.send({ instance: "job-1/k2/a", port: "in" }, { v: 8 });
    rt.truncate("job-1/k2", "下线");

    rt.step();
    expect(offered.map((c) => c.message.target.instance)).toEqual(["job-1/k1/a"]);
  });

  it("★ 返回候选集外的东西 → 当场抛，不静默变成「本轮空闲」", () => {
    const forged: Scheduler = () => ({
      message: { id: "msg-999", target: { instance: "job-1/k1/a" }, state: "QUEUED" },
      instance: "job-1/k1/a",
      position: 0,
    });
    const rt = build(forged);
    sendThree(rt);
    expect(() => rt.step()).toThrow(InvariantError);
    expect(() => rt.step()).toThrow(/不在候选集里的消息 msg-999/);
  });

  it("按引用比对，内容一样的伪造对象也不算", () => {
    const c: Candidate = {
      message: { id: "msg-1", target: { instance: "job-1/a" }, state: "QUEUED" },
      position: 0,
    };
    // 内容逐字相同的另一个对象
    const twin: Candidate = { ...c, message: { ...c.message } };
    expect(acceptedPick([c], c)).toBe(c);
    expect(() => acceptedPick([c], twin)).toThrow(/不在候选集里/);
  });

  it("不挑（null）是合法的，不抛", () => {
    const c: Candidate = {
      message: { id: "msg-1", target: { instance: "job-1/a" }, state: "QUEUED" },
      position: 0,
    };
    expect(acceptedPick([c], null)).toBeNull();
  });
});
