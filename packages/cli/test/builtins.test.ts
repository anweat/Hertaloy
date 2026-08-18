/**
 * 回归：内容寻址去重会吞掉**重复发生的相同事件**。
 *
 * 这两个 handler 之前都踩塌在这里，而且失败方式不是数字算错，是流程卡死。
 * 探针实证：`loop` 写 5 次只留 1 版，`collect` 收 3 份相同结果只留 1 版。
 */

import { describe, expect, it } from "vitest";
import { InstanceRegistry, ObjectStore, Runtime, registerContainerTemplate } from "@nodeflow/kernel";
import { BUILTIN_HANDLERS } from "../src/builtins.js";

function rig(handler: string, servo: Record<string, unknown>) {
  const store = new ObjectStore();
  const ref = registerContainerTemplate(
    store,
    "root",
    {
      nodes: {
        n: {
          kind: "handler",
          handler,
          ports: {
            in: { direction: "receive", servo: { vars: servo } },
            done: { direction: "emit" },
            out: { direction: "emit" },
            again: { direction: "emit" },
          },
        },
      },
      edges: {},
      children: {},
      subscriptions: {},
    },
    "root_config",
  );
  const registry = new InstanceRegistry(store);
  registry.createRoot(ref, "job-1");
  const runtime = new Runtime(store, registry);
  for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) runtime.registerHandler(name, fn);
  return { store, runtime };
}

describe("★ collect：相同答案也要各算一份", () => {
  it("三个子容器给出**完全相同**的结果，汇聚仍然凑得齐", () => {
    const { store, runtime } = rig("collect", {
      value: { type: "short", from: "$.value" },
      expect: { type: "short", from: "$.expect" },
    });
    for (let i = 0; i < 3; i += 1) {
      runtime.send({ traceid: "job-1", node: "n", port: "in" }, { value: "same", expect: 3 });
      runtime.drain();
    }
    // 修之前：去重把三份合成一份，版本数停在 1，汇聚永远等不齐
    expect(store.history("job-1/parts")).toHaveLength(3);
  });

  it("序号写进了 body —— 那正是让它们互不相同的东西", () => {
    const { store, runtime } = rig("collect", {
      value: { type: "short", from: "$.value" },
      expect: { type: "short", from: "$.expect" },
    });
    for (let i = 0; i < 2; i += 1) {
      runtime.send({ traceid: "job-1", node: "n", port: "in" }, { value: "same", expect: 2 });
      runtime.drain();
    }
    expect(store.history("job-1/parts").map((v) => v.body.index)).toEqual([1, 2]);
  });
});

describe("★ loop：轮次真的往前走", () => {
  it("跑三轮 → 三版 epoch（修之前恒为 1 版，rounds>1 永不退出）", () => {
    const { store, runtime } = rig("loop", { rounds: { type: "short", from: "$.rounds" } });
    for (let i = 0; i < 3; i += 1) {
      runtime.send({ traceid: "job-1", node: "n", port: "in" }, { rounds: 3 });
      runtime.drain();
    }
    expect(store.history("job-1/epoch")).toHaveLength(3);
  });

  it("不用时间戳凑唯一 —— 那会违反 §17.5 的确定性契约", () => {
    const source = String(BUILTIN_HANDLERS.loop);
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
  });
});
