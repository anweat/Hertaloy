/**
 * 批 B：eager 物化继承 + 路径覆盖（FOUNDATION_V5.md §5.1）。
 *
 * 核心断言是最后一条：**改基模板不影响已有实例**。
 * 这正是选 eager 而不是 lazy 的全部理由 —— lazy 会让 C4 的 pin 变成谎言。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { InvariantError } from "../src/errors.js";

const baseSpec = {
  nodes: {
    coder: {
      kind: "handler",
      handler: "work",
      budget: { tokens: 1000 },
      bind: { rules: { type: "long", literal: "宽松规则", max_tokens: 400 } },
      ports: {
        in: { direction: "receive" },
        out: { direction: "emit" },
      },
    },
    sink: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
  },
  edges: { e1: { from: { node: "coder", port: "out" }, to: { node: "sink", port: "in" } } },
  children: {},
  subscriptions: {},
};

let store: ObjectStore;
let baseRef: string;

beforeEach(() => {
  store = new ObjectStore();
  baseRef = registerContainerTemplate(store, "coder-flow", baseSpec);
});

describe("路径覆盖", () => {
  it("覆盖标量：只改一条路径，其余原样继承", () => {
    const ref = registerContainerTemplate(store, "coder-strict", {
      extends: baseRef,
      override: { "nodes/coder/budget/tokens": 2000 },
    });
    const merged = store.resolve(ref).body as never as typeof baseSpec;

    expect(merged.nodes.coder.budget.tokens).toBe(2000);
    expect(merged.nodes.coder.bind.rules.literal).toBe("宽松规则");
    expect(Object.keys(merged.nodes).sort()).toEqual(["coder", "sink"]);
    expect(store.resolve(ref).kind).toBe("materialized");
  });

  it("覆盖对象：整段替换 bind 变量", () => {
    const ref = registerContainerTemplate(store, "coder-strict", {
      extends: baseRef,
      override: {
        "nodes/coder/bind/rules": { type: "long", literal: "严格规则", max_tokens: 900 },
      },
    });
    const merged = store.resolve(ref).body as never as typeof baseSpec;
    expect(merged.nodes.coder.bind.rules.literal).toBe("严格规则");
    expect(merged.nodes.coder.bind.rules.max_tokens).toBe(900);
  });

  it("末段可以是新的 —— 覆盖层能往基定义里加节点和边", () => {
    const ref = registerContainerTemplate(store, "coder-plus", {
      extends: baseRef,
      override: {
        "nodes/extra": { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
        "edges/e2": { from: { node: "coder", port: "out" }, to: { node: "extra", port: "in" } },
      },
    });
    const merged = store.resolve(ref).body as never as typeof baseSpec;
    expect(Object.keys(merged.nodes).sort()).toEqual(["coder", "extra", "sink"]);
    expect(Object.keys(merged.edges).sort()).toEqual(["e1", "e2"]);
  });

  it("★ 中间路径拼错即拒绝，并列出可用键 —— 否则会静默造出假节点", () => {
    expect(() =>
      registerContainerTemplate(store, "typo", {
        extends: baseRef,
        override: { "nodes/codr/budget/tokens": 2000 },
      }),
    ).toThrow(/中间路径 `nodes\/codr` 在基定义里不存在.*可用键：coder, sink/s);
  });

  it("非法路径形状被拒", () => {
    expect(() =>
      registerContainerTemplate(store, "bad", {
        extends: baseRef,
        override: { "nodes//coder": 1 },
      }),
    ).toThrow(/覆盖路径必须是/);
  });

  it("extends 指向未知定义被拒", () => {
    expect(() =>
      registerContainerTemplate(store, "orphan", { extends: "ghost@1", override: {} }),
    ).toThrow(/extends 指向未知定义/);
  });
});

describe("覆盖不是逃生舱：合并结果走同一套校验", () => {
  it("★ 覆盖把边指向不存在的节点 → 注册期拒绝", () => {
    expect(() =>
      registerContainerTemplate(store, "broken", {
        extends: baseRef,
        override: { "edges/e1/to/node": "ghost" },
      }),
    ).toThrow(/连接期校验失败[\s\S]*节点 `ghost` 不存在/);
  });

  it("★ 覆盖把预算调到低于变量上界 → 注册期拒绝（B1 仍然管用）", () => {
    expect(() =>
      registerContainerTemplate(store, "tight", {
        extends: baseRef,
        override: { "nodes/coder/budget/tokens": 100 },
      }),
    ).toThrow(/合计 400 tokens，超出节点预算 100/);
  });
});

describe("★ eager 的全部理由：改基模板不影响已有实例（C4）", () => {
  it("基模板发新版本后，物化定义与在途实例都不漂移", () => {
    const strictRef = registerContainerTemplate(store, "coder-strict", {
      extends: baseRef,
      override: { "nodes/coder/budget/tokens": 2000 },
    });
    const rootRef = registerContainerTemplate(
      store,
      "root",
      { nodes: {}, edges: {}, children: { k: { template: strictRef } }, subscriptions: {} },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(rootRef, "job-1");
    const child = reg.spawn("job-1", "k", "c1");

    // 基模板演进：换掉 rules 正文
    registerContainerTemplate(store, "coder-flow", {
      ...baseSpec,
      nodes: {
        ...baseSpec.nodes,
        coder: {
          ...baseSpec.nodes.coder,
          bind: { rules: { type: "long", literal: "改过的规则", max_tokens: 400 } },
        },
      },
    });
    expect(store.head("coder-flow").version).toBe(2);

    // 物化定义 pin 的是 @1 的内容，不受影响
    const pinned = reg.template(child.traceid);
    expect(pinned.nodes.coder?.bind?.rules?.literal).toBe("宽松规则");
    expect(child.templateRef).toBe(strictRef);
  });

  it("provenance 记住基定义，继承链可追", () => {
    const ref = registerContainerTemplate(store, "coder-strict", {
      extends: baseRef,
      override: { "nodes/coder/budget/tokens": 2000 },
    });
    expect(store.resolve(ref).provenance.derived_from).toEqual([baseRef]);
    expect(store.lineage(ref).get(ref)).toEqual([baseRef]);
  });

  it("多层继承：覆盖层可以再被覆盖", () => {
    const mid = registerContainerTemplate(store, "mid", {
      extends: baseRef,
      override: { "nodes/coder/budget/tokens": 2000 },
    });
    const top = registerContainerTemplate(store, "top", {
      extends: mid,
      override: { "nodes/coder/handler": "special" },
    });
    const merged = store.resolve(top).body as never as typeof baseSpec;
    expect(merged.nodes.coder.budget.tokens).toBe(2000); // 来自 mid
    expect(merged.nodes.coder.handler).toBe("special"); // 来自 top
    expect(store.lineage(top).get(top)).toEqual([mid]);
  });

  it("同内容的覆盖层幂等（V3）", () => {
    const overlay = { extends: baseRef, override: { "nodes/coder/budget/tokens": 2000 } };
    const a = registerContainerTemplate(store, "same", overlay);
    const b = registerContainerTemplate(store, "same", structuredClone(overlay));
    expect(a).toBe(b);
    expect(store.history("same")).toHaveLength(1);
  });
});
