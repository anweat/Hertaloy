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
    expect(store.history("job-1/results")).toHaveLength(3);   // 已落在实例命名空间
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
    expect(store.history("job-1/cand").map((o) => o.body.score)).toEqual([5, 9, 2]);
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
      const ref = ctx.put("a", "thing", { n: 1 });
      expect(ref).toBe("job-1/a@1");            // 自动落进实例命名空间
      expect(ctx.read(ref).body).toEqual({ n: 1 });
      expect(ctx.history("a")).toHaveLength(1); // history 也走命名空间
      expect(() => ctx.read("job-1/a")).toThrow();
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

describe("批 F：对象命名空间（§7.7 的 bug 修复）", () => {
  /** 父容器有 merge 节点；两个子容器各写一份 results。 */
  function buildTree(): { rt: Runtime; store: ObjectStore; reg: InstanceRegistry } {
    const s = new ObjectStore();
    const leaf = registerContainerTemplate(s, "leaf", {
      nodes: {
        w: {
          kind: "handler",
          handler: "produce",
          ports: { in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } } },
        },
      },
      edges: {},
      children: {},
      subscriptions: {},
    });
    const root = registerContainerTemplate(
      s,
      "root",
      {
        nodes: {
          merge: {
            kind: "handler",
            handler: "merge",
            ports: { in: { direction: "receive" }, done: { direction: "emit" } },
          },
        },
        edges: {},
        children: { k: { template: leaf } },
        subscriptions: {},
      },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(root, "job-1");
    return { rt: new Runtime(s, r), store: s, reg: r };
  }

  it("★ 不同实例写同名资产不再互相污染", () => {
    const { rt, store } = buildTree();
    rt.registerHandler("produce", (vars, ctx) => {
      ctx.put("results", "result", { v: vars.v ?? null });
      return {};
    });
    rt.registerHandler("merge", () => ({}));
    rt.spawn("job-1", "k", "a");
    rt.spawn("job-1", "k", "b");

    rt.send({ traceid: "job-1/a", node: "w", port: "in" }, { v: "A" });
    rt.send({ traceid: "job-1/b", node: "w", port: "in" }, { v: "B" });
    rt.drain();

    // 修复前：两个实例都写 `results`，得到 results@1 / results@2 —— 互相污染
    expect(store.has("results")).toBe(false);
    expect(store.history("job-1/a/results")).toHaveLength(1);
    expect(store.history("job-1/b/results")).toHaveLength(1);
    expect(store.resolve("job-1/a/results@1").body).toEqual({ v: "A" });
    expect(store.resolve("job-1/b/results@1").body).toEqual({ v: "B" });
  });

  it("★ 跨实例汇聚靠 ctx.collect（剧本帧 12 的真实形状）", () => {
    const { rt } = buildTree();
    const merged: unknown[] = [];
    rt.registerHandler("produce", (vars, ctx) => {
      ctx.put("results", "result", { v: vars.v ?? null });
      return {};
    });
    rt.registerHandler("merge", (_v, ctx) => {
      const all = ctx.collect("job-1", "results");
      if (all.length < 2) return {};
      merged.push(all.map((o) => o.body.v ?? null));
      return { done: {} };
    });
    rt.spawn("job-1", "k", "a");
    rt.spawn("job-1", "k", "b");

    // 两个子容器交货
    rt.send({ traceid: "job-1/a", node: "w", port: "in" }, { v: "A" });
    rt.send({ traceid: "job-1/b", node: "w", port: "in" }, { v: "B" });
    rt.drain();

    // 父容器被通知两次：第一次不足两份，第二次才汇聚
    rt.send({ traceid: "job-1", node: "merge", port: "in" }, {});
    rt.drain();
    expect(merged).toEqual([["A", "B"]]);
    rt.checkInvariants();
  });

  it("collect 的前缀落在段边界上，job-1 不捞 job-10", () => {
    const s = new ObjectStore();
    s.put("job-1/x/results", "result", { v: 1 });
    s.put("job-10/x/results", "result", { v: 2 });
    s.put("job-1/results", "result", { v: 3 });
    expect(s.collect("job-1", "results").map((o) => o.object_id)).toEqual([
      "job-1/results",
      "job-1/x/results",
    ]);
  });

  it("★ 写不出自己的命名空间：`..` 与前导斜杠被拒", () => {
    const { rt } = buildTree();
    rt.registerHandler("produce", (_v, ctx) => {
      ctx.put("../escape", "thing", {});
      return {};
    });
    rt.registerHandler("merge", () => ({}));
    rt.spawn("job-1", "k", "a");
    rt.send({ traceid: "job-1/a", node: "w", port: "in" }, { v: 1 });
    expect(() => rt.drain()).toThrow(/资产名 .* 非法/);
  });
});
