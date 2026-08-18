import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { InvariantError } from "../src/errors.js";

const leafSpec = {
  nodes: {
    work: {
      kind: "handler",
      handler: "noop",
      ports: {
        in: { direction: "receive" },
        out: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
};

let store: ObjectStore;
let leafRef: string;
let rootRef: string;
let reg: InstanceRegistry;

beforeEach(() => {
  store = new ObjectStore();
  leafRef = registerContainerTemplate(store, "coder-flow", leafSpec);
  rootRef = registerContainerTemplate(
    store,
    "root-config",
    {
      nodes: {
        plan: { kind: "handler", handler: "noop", ports: { out: { direction: "emit" } } },
      },
      edges: {},
      children: { coders: { template: leafRef } },
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
});

describe("根容器唯一（不变量 C1）", () => {
  it("根由启动配置创建，自身含节点（根也是工作流）", () => {
    const root = reg.createRoot(rootRef, "root");
    expect(root.traceid).toBe("root");
    expect(root.status).toBe("OPEN");
    expect([...root.nodes.keys()]).toEqual(["plan"]);
    expect(reg.rootTrace).toBe("root");
  });

  it("第二次 createRoot 拒绝 —— 根不可由模板重复创建", () => {
    reg.createRoot(rootRef, "root");
    expect(() => reg.createRoot(rootRef, "root2")).toThrow(InvariantError);
  });
});

describe("子容器只能从已声明的槽创建（第一不变量）", () => {
  it("spawn 已声明槽成功，实例路径是父路径的子级", () => {
    reg.createRoot(rootRef, "job-1");
    const child = reg.spawn("job-1", "coders", "coder-1");
    expect(child.traceid).toBe("job-1/coder-1");
    expect([...child.nodes.keys()]).toEqual(["work"]);
  });

  it("未声明的槽被拒绝，并列出可用槽", () => {
    reg.createRoot(rootRef, "job-1");
    expect(() => reg.spawn("job-1", "reviewers", "r-1")).toThrow(/可用子槽：coders/);
  });

  it("重复 segment 与非 OPEN 父实例被拒绝", () => {
    reg.createRoot(rootRef, "job-1");
    reg.spawn("job-1", "coders", "coder-1");
    expect(() => reg.spawn("job-1", "coders", "coder-1")).toThrow(InvariantError);
    reg.setStatus("job-1", "TERMINAL");
    expect(() => reg.spawn("job-1", "coders", "coder-2")).toThrow(/TERMINAL/);
  });
});

describe("实例终身 pin（不变量 C4）", () => {
  it("模板演进后，已存在实例仍解析创建时的版本", () => {
    reg.createRoot(rootRef, "job-1");
    const child = reg.spawn("job-1", "coders", "coder-1");
    expect(child.templateRef).toBe("coder-flow@1");

    // 同 id 发布 @2：多一个节点
    registerContainerTemplate(store, "coder-flow", {
      ...leafSpec,
      nodes: {
        ...leafSpec.nodes,
        extra: { kind: "handler", handler: "noop", ports: { out: { direction: "emit" } } },
      },
    });
    expect(store.head("coder-flow").version).toBe(2);

    // 在途实例不漂移
    expect(reg.get("job-1/coder-1").templateRef).toBe("coder-flow@1");
    expect(Object.keys(reg.template("job-1/coder-1").nodes)).toEqual(["work"]);
  });

  it("新实例仍用父模板 pin 的旧 ref —— 父自己也是终身 pin", () => {
    reg.createRoot(rootRef, "job-1");
    registerContainerTemplate(store, "coder-flow", {
      ...leafSpec,
      children: { nested: { template: "coder-flow@1" } },
    });
    expect(reg.spawn("job-1", "coders", "coder-2").templateRef).toBe("coder-flow@1");
  });
});

describe("子树查询（不变量 C2）", () => {
  beforeEach(() => {
    reg.createRoot(rootRef, "job-1");
    reg.spawn("job-1", "coders", "coder-1");
    reg.spawn("job-1", "coders", "coder-2");
  });

  it("subtree 含自身，按 traceid 稳定排序", () => {
    expect(reg.subtree("job-1").map((i) => i.traceid)).toEqual([
      "job-1",
      "job-1/coder-1",
      "job-1/coder-2",
    ]);
  });

  it("children 只取直接子级", () => {
    expect(reg.children("job-1").map((i) => i.traceid)).toEqual([
      "job-1/coder-1",
      "job-1/coder-2",
    ]);
    expect(reg.children("job-1/coder-1")).toEqual([]);
  });

  // ★ Task 2 明确要求
  it("前缀查询不把 job-1 与 job-10 混淆", () => {
    const other = new InstanceRegistry(store);
    other.createRoot(rootRef, "job-10");
    other.spawn("job-10", "coders", "coder-1");
    expect(other.subtree("job-1")).toEqual([]);
    expect(other.subtree("job-10").map((i) => i.traceid)).toEqual([
      "job-10",
      "job-10/coder-1",
    ]);
  });
});

describe("注册期校验（修 V4 缺陷 1：propose 不校验）", () => {
  it("边引用不存在的节点 → 注册期拒绝并列出可用节点", () => {
    expect(() =>
      registerContainerTemplate(store, "bad-1", {
        nodes: {
          a: { kind: "handler", handler: "noop", ports: { out: { direction: "emit" } } },
        },
        edges: { e1: { from: { node: "a", port: "out" }, to: { node: "ghost", port: "in" } } },
        children: {},
      }),
    ).toThrow(/节点 `ghost` 不存在。可用节点：a/);
  });

  it("边方向接反 → 注册期拒绝并说清方向", () => {
    expect(() =>
      registerContainerTemplate(store, "bad-2", {
        nodes: {
          a: {
            kind: "handler",
            handler: "noop",
            ports: { in: { direction: "receive" }, out: { direction: "emit" } },
          },
        },
        edges: { e1: { from: { node: "a", port: "in" }, to: { node: "a", port: "out" } } },
        children: {},
      }),
    ).toThrow(/方向是 receive，边的 from 端要求 emit/);
  });

  it("handler 节点必须恰好一个执行体", () => {
    for (const node of [
      { kind: "handler", ports: {} },
      { kind: "handler", handler: "noop", agent: { argv: ["run-agent"] }, ports: {} },
    ]) {
      expect(() =>
        registerContainerTemplate(store, "bad-3", { nodes: { a: node }, edges: {}, children: {} }),
      ).toThrow(InvariantError);
    }
  });
});
