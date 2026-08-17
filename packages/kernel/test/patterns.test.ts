/**
 * 三种标准写法 + 事务化提交。
 *
 * 这个文件同时是**开发指南的可运行部分**：策略节点删除后，汇聚 / 循环计数 / 择优
 * 都靠「版本历史即状态」（不变量 C5）写在受信 handler 里。下面每个 describe
 * 就是一种标准写法的最小可运行样例。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepResult } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";
import { transact } from "../src/tx.js";

const spec = {
  nodes: {
    collect: {
      kind: "handler",
      handler: "collect",
      ports: {
        in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } },
        done: { direction: "emit" },
      },
    },
    loop: {
      kind: "handler",
      handler: "loop",
      ports: {
        in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } },
        again: { direction: "emit" },
        out: { direction: "emit" },
      },
    },
    sink: {
      kind: "handler",
      handler: "sink",
      ports: { in: { direction: "receive" } },
    },
  },
  edges: {
    // 自环：again 回到自己的 in —— 固定拓扑允许成环
    back: { from: { node: "loop", port: "again" }, to: { node: "loop", port: "in" } },
    exit: { from: { node: "loop", port: "out" }, to: { node: "sink", port: "in" } },
  },
  children: {},
  subscriptions: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let sunk: unknown[];

beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "patterns", spec, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  rt = new Runtime(store, reg);
  sunk = [];
  rt.registerHandler("sink", (vars) => {
    sunk.push(vars);
    return {};
  });
});

describe("写法一：汇聚 —— 版本历史当累加器", () => {
  it("三路各写一版，读到满三条才往下（不需要多消息原子消费）", () => {
    rt.registerHandler("collect", (vars, ctx) => {
      ctx.put("results", "result", { v: vars.v ?? null });
      const all = ctx.history("results");
      // 不足三条：消费掉这条通知，什么都不发
      if (all.length < 3) return {};
      return { done: { merged: all.map((o) => o.body.v ?? null) } };
    });

    for (const v of [1, 2, 3]) {
      rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v });
    }
    const results = rt.drain() as StepResult[];

    expect(results.map((r) => r.delivered.length)).toEqual([0, 0, 0]);
    expect(results.slice(0, 2).map((r) => r.dangling)).toEqual([[], []]);
    // 第三次才产出（这里没有下游边，所以体现为 dangling）
    expect(results[2]?.dangling).toEqual(["done"]);
    expect(store.history("results")).toHaveLength(3);
    rt.checkInvariants();
  });
});

describe("写法二：循环计数 —— 版本号就是 epoch", () => {
  it("走三轮后退出，epoch 靠 history 长度，不存节点状态", () => {
    const seen: number[] = [];
    rt.registerHandler("loop", (vars, ctx) => {
      ctx.put("epoch", "marker", { at: String(vars.v) });
      const epoch = ctx.history("epoch").length;
      seen.push(epoch);
      return epoch < 3 ? { again: { v: epoch } } : { out: { v: epoch } };
    });

    rt.send({ traceid: "job-1", node: "loop", port: "in" }, { v: 0 });
    rt.drain();

    expect(seen).toEqual([1, 2, 3]);
    expect(sunk).toEqual([{}]);
    rt.checkInvariants();
  });
});

describe("写法三：择优 —— 读 history 挑最高", () => {
  it("按字段取最高那一版", () => {
    rt.registerHandler("collect", (vars, ctx) => {
      ctx.put("cand", "candidate", { score: vars.v ?? null });
      const all = ctx.history("cand");
      if (all.length < 3) return {};
      const best = all.reduce((a, b) =>
        Number(b.body.score) > Number(a.body.score) ? b : a,
      );
      return {
        done: { winner: best.body.score ?? null, ref: `${best.object_id}@${best.version}` },
      };
    });

    for (const v of [5, 9, 2]) {
      rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v });
    }
    const results = rt.drain() as StepResult[];
    expect(results[2]?.dangling).toEqual(["done"]);
    expect(store.history("cand").map((o) => o.body.score)).toEqual([5, 9, 2]);
  });
});

describe("ctx 的边界", () => {
  it("handler 不得写内核保留 kind —— 受信不等于能污染因果记录", () => {
    rt.registerHandler("collect", (_vars, ctx) => {
      ctx.put("evil", "run", {});
      return {};
    });
    rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v: 1 });
    expect(() => rt.drain()).toThrow(/不得写入内核保留 kind `run`/);
  });

  it("read 只接受精确版本引用", () => {
    rt.registerHandler("collect", (_vars, ctx) => {
      ctx.put("a", "thing", { n: 1 });
      expect(ctx.read("a@1").body).toEqual({ n: 1 });
      expect(() => ctx.read("a")).toThrow();
      return {};
    });
    rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v: 1 });
    rt.drain();
  });
});

describe("批 0：提交是事务（§10.1）", () => {
  it("★ handler 中途抛异常 → 消息、产物、快照全部回滚", () => {
    rt.registerHandler("collect", (_vars, ctx) => {
      ctx.put("half", "thing", { written: true });
      throw new Error("提交到一半炸了");
    });
    const id = rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v: 1 });

    const before = {
      seq: reg.get("job-1").seq,
      messages: rt.messages().length,
    };
    expect(() => rt.step()).toThrow(/提交到一半炸了/);

    // 产物没留下半份
    expect(store.has("half")).toBe(false);
    // 消息状态没动，仍是 QUEUED
    expect(rt.message(id).state).toBe("QUEUED");
    expect(rt.messages()).toHaveLength(before.messages);
    // 提交序号没推进 ⇒ RunSnapshot 序列不会出现空洞
    expect(reg.get("job-1").seq).toBe(before.seq);
    expect(rt.snapshots("job-1")).toHaveLength(0);
    rt.checkInvariants();
  });

  it("transact 对多个部件同时回滚，成功时不回滚", () => {
    const s = new ObjectStore();
    s.put("keep", "thing", { n: 1 });
    expect(() =>
      transact([s], () => {
        s.put("keep", "thing", { n: 2 });
        s.put("gone", "thing", { n: 1 });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.history("keep")).toHaveLength(1);
    expect(s.has("gone")).toBe(false);

    transact([s], () => s.put("gone", "thing", { n: 1 }));
    expect(s.has("gone")).toBe(true);
  });
});

describe("批 0：状态不变量断言", () => {
  it("正常运行后不变量成立", () => {
    rt.registerHandler("collect", () => ({}));
    rt.send({ traceid: "job-1", node: "collect", port: "in" }, { v: 1 });
    rt.drain();
    rt.checkInvariants();
    rt.settleAll();
    rt.checkInvariants();
  });

  it("★ 抓得出「child 锁还在但子实例已终态」这类半状态", () => {
    const s2 = new ObjectStore();
    const leaf = registerContainerTemplate(s2, "leaf", {
      nodes: {},
      edges: {},
      children: {},
      subscriptions: {},
    });
    const root = registerContainerTemplate(
      s2,
      "root",
      { nodes: {}, edges: {}, children: { k: { template: leaf } }, subscriptions: {} },
      "root_config",
    );
    const r2 = new InstanceRegistry(s2);
    r2.createRoot(root, "job-2");
    const rt2 = new Runtime(s2, r2);
    rt2.spawn("job-2", "k", "c1");
    rt2.checkInvariants();

    // 绕过 settle 直接改状态，制造半状态：锁还在，子已终态
    r2.setStatus("job-2/c1", "TERMINAL");
    expect(() => rt2.checkInvariants()).toThrow(InvariantError);
    expect(() => rt2.checkInvariants()).toThrow(/child 锁仍在，但子实例 job-2\/c1 已 TERMINAL/);

    // 走正规路径就没问题
    r2.setStatus("job-2/c1", "OPEN");
    rt2.settle("job-2/c1");
    rt2.checkInvariants();
  });
});
