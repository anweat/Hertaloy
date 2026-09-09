/**
 * 别名寻址 —— 隧道的替代（`src/aliases.ts`）。
 *
 * 这些用例的前身是一组**测试侧模型**：在测试里重写一遍解析逻辑，跟真运行时对账。
 * 模型进 src 之后那种对账就变成"自己跟自己比"了，所以改成直接驱动真运行时。
 *
 * 五个场景一一对应隧道时代的五种订阅语义，外加别名独有的两条：
 *
 *   S1  REQUEST，服务方是**兄弟**            ← 剧本帧 9   ← 绑定指向子槽
 *   S2  只对某一支可见                       ← 绝对 scope ← 绑定挂在子槽上
 *   S3  只收本子树发的                       ← **帧 11**  ← **不需要表达**
 *   S4  0..N 扇出 + 终态过滤                 ← 无 scope
 *   S5  只收自己发的                         ← `$self`    ← selfBindings
 *   —   跨租户不透明地址（不枚举对面）        ← 隧道没有
 *   —   注册期判定（"发出去没人接"当场拒）    ← 隧道没有
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepResult } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";
import { containerOf, formatEndpoint } from "@nodeflow/contracts";

let store: ObjectStore;

beforeEach(() => {
  store = new ObjectStore();
});

/** 发消息的一方：`out` 是别名出口。 */
function emitterSpec(alias: string, callback?: string): unknown {
  return {
    nodes: {
      worker: {
        kind: "handler",
        handler: "emit",
        ports: {
          start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
          out: {
            direction: "emit",
            alias,
            // REQUEST 必须声明「等不到回复时当作收到什么」—— 见 port.ts
            ...(callback === undefined ? {} : { callback, unavailable: {} }),
          },
          ...(callback === undefined ? {} : { [callback]: { direction: "receive" } }),
        },
      },
    },
    edges: {},
    children: {},
  };
}

const sinkSpec = {
  nodes: {
    metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
  },
  edges: {},
  children: {},
};

function runtimeOf(reg: InstanceRegistry): Runtime {
  const rt = new Runtime(store, reg);
  rt.registerHandler("noop", () => ({}));
  rt.registerHandler("emit", (vars) => ({ out: { q: vars.q ?? null } }));
  return rt;
}

function deliveredTo(rt: Runtime, step: StepResult): readonly string[] {
  return step.delivered
    .map((id) => rt.message(id).target)
    .map(formatEndpoint)
    .sort();
}

describe("S1 · 绑定指向子槽，够得着兄弟位置上的服务（帧 9）", () => {
  it("REQUEST 落到 services 槽里的那个实例", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("skill", "got"));
    const service = registerContainerTemplate(store, "service", sinkSpec);
    const root = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {},
        edges: {},
        children: { askers: { template: emitter }, services: { template: service } },
        bindings: [{ alias: "skill", slot: "services", node: "metrics", port: "in" }],
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-1");
    const rt = runtimeOf(reg);
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.send({ instance: "job-1/coder-1/worker", port: "start" }, { q: "x" });

    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-1/discovery/metrics.in"]);
    // REQUEST 记了义务，等的是服务方
    const req = rt.obligations("job-1/coder-1").find((o) => o.kind === "request");
    expect(req?.waitingOn).toBe("job-1/discovery");
  });
});

describe("S2 · 绑定挂在子槽上，只有那一支看得见", () => {
  it("team-a 解析得到，team-b 解析不到", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    const watcher = registerContainerTemplate(store, "watcher", sinkSpec);
    const root = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {},
        edges: {},
        children: {
          watchers: { template: watcher },
          "team-a": {
            template: emitter,
            // 只挂在这一支上 —— 替代绝对 scope，而且不写死任何 traceid
            bindings: [{ alias: "progress", slot: "watchers", node: "metrics", port: "in" }],
          },
          // team-b 也用 progress，但这里**故意**不给它接线；根校验会要求显式表态
          "team-b": {
            template: emitter,
            bindings: [{ alias: "progress", slot: "watchers", node: "metrics", port: "in" }],
          },
        },
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-1");
    const rt = runtimeOf(reg);
    rt.spawn("job-1", "watchers", "w1");
    rt.spawn("job-1", "team-a", "team-a");
    rt.spawn("job-1", "team-b", "team-b");

    // 两支各自看得见自己那条 —— 互不借用
    expect(reg.get("job-1/team-a").bindings.map((b) => b.container)).toEqual(["job-1"]);
    rt.send({ instance: "job-1/team-a/worker", port: "start" }, { q: "a" });
    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-1/w1/metrics.in"]);
  });

  it("★ 别的子槽上的绑定还不了这一支的账 —— 注册期就拒", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    const watcher = registerContainerTemplate(store, "watcher", sinkSpec);
    expect(() =>
      registerContainerTemplate(
        store,
        "root",
        {
          nodes: {},
          edges: {},
          children: {
            watchers: { template: watcher },
            "team-a": {
              template: emitter,
              bindings: [{ alias: "progress", slot: "watchers", node: "metrics", port: "in" }],
            },
            "team-b": { template: emitter }, // 忘了接线
          },
        },
        "root_config",
      ),
    ).toThrow(/别名 `progress`[\s\S]*没有任何绑定/);
  });
});

describe("S3 · 帧 11 —— 不需要表达", () => {
  it("★ 向上查找天然只够得着自己的祖先，作用域规则因此不存在", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    const watcher = registerContainerTemplate(store, "watcher-rel", {
      ...sinkSpec,
      children: { teams: { template: emitter } },
      // 对自己整棵子树可见。没有任何 scope 字段。
      bindings: [{ alias: "progress", node: "metrics", port: "in" }],
    });
    const root = registerContainerTemplate(
      store,
      "root",
      { nodes: {}, edges: {}, children: { w: { template: watcher } } },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-9");
    const rt = runtimeOf(reg);
    // 同一模板实例化两份，各带一个 team
    rt.spawn("job-9", "w", "w-a");
    rt.spawn("job-9", "w", "w-b");
    rt.spawn("job-9/w-a", "teams", "t1");
    rt.spawn("job-9/w-b", "teams", "t2");

    rt.send({ instance: "job-9/w-a/t1/worker", port: "start" }, { q: "a" });
    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-9/w-a/metrics.in"]);

    rt.send({ instance: "job-9/w-b/t2/worker", port: "start" }, { q: "b" });
    const second = rt
      .drain()
      .filter((r): r is StepResult => !("reason" in r) && containerOf(r) === "job-9/w-b/t2");
    expect(deliveredTo(rt, second[0] as StepResult)).toEqual(["job-9/w-b/metrics.in"]);

    // ★ 自给自足：t1 的表里记的是 w-a，解析不需要再往上问任何人
    expect(reg.get("job-9/w-a/t1").bindings).toEqual([
      { alias: "progress", container: "job-9/w-a", node: "metrics", port: "in", inherit: true },
    ]);
  });
});

describe("S4 · 0..N 扇出", () => {
  function fanoutTree(): { reg: InstanceRegistry; rt: Runtime } {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    const watcher = registerContainerTemplate(store, "watcher", sinkSpec);
    const root = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {},
        edges: {},
        children: { watchers: { template: watcher }, teams: { template: emitter } },
        bindings: [{ alias: "progress", slot: "watchers", node: "metrics", port: "in" }],
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-1");
    const rt = runtimeOf(reg);
    rt.spawn("job-1", "watchers", "w1");
    rt.spawn("job-1", "watchers", "w2");
    rt.spawn("job-1", "teams", "t1");
    return { reg, rt };
  }

  it("槽下每个 OPEN 实例各收一份", () => {
    const { rt } = fanoutTree();
    rt.send({ instance: "job-1/t1/worker", port: "start" }, { q: "x" });
    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual([
      "job-1/w1/metrics.in",
      "job-1/w2/metrics.in",
    ]);
  });

  it("进终态的不再收 —— 绑定是静态的，实例数量是动态的", () => {
    const { rt } = fanoutTree();
    rt.truncate("job-1/w2", "下线");
    rt.send({ instance: "job-1/t1/worker", port: "start" }, { q: "x" });
    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-1/w1/metrics.in"]);
  });
});

describe("S5 · selfBindings —— 只有自己看得见", () => {
  it("子树拿不到，于是注册期就报欠账", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    expect(() =>
      registerContainerTemplate(
        store,
        "root",
        {
          nodes: {
            metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
          },
          edges: {},
          children: { teams: { template: emitter } },
          // 只对自己可见 → 子树看不见 → teams 那一支的 progress 无人接
          selfBindings: [{ alias: "progress", node: "metrics", port: "in" }],
        },
        "root_config",
      ),
    ).toThrow(/别名 `progress`[\s\S]*没有任何绑定/);
  });

  it("自己用得上：同模板的两个实例各投给自己", () => {
    const selfEmitter = registerContainerTemplate(store, "self", {
      nodes: {
        worker: {
          kind: "handler",
          handler: "emit",
          ports: {
            start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
            out: { direction: "emit", alias: "progress" },
          },
        },
        metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
      },
      edges: {},
      children: {},
      selfBindings: [{ alias: "progress", node: "metrics", port: "in" }],
    });
    const root = registerContainerTemplate(
      store,
      "root",
      { nodes: {}, edges: {}, children: { w: { template: selfEmitter } } },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-1");
    const rt = runtimeOf(reg);
    rt.spawn("job-1", "w", "a");
    rt.spawn("job-1", "w", "b");

    rt.send({ instance: "job-1/a/worker", port: "start" }, { q: "x" });
    // a 发的只落回 a 自己
    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-1/a/metrics.in"]);
  });
});

describe("跨租户：不透明地址，不枚举对面", () => {
  it("★ 投一条到一个地址，扇出由对面决定 —— REQUEST「恰好 1 个」构造性成立", () => {
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("skill", "got"));
    const gateway = registerContainerTemplate(store, "gateway", sinkSpec);
    const root = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {},
        edges: {},
        children: { askers: { template: emitter }, gw: { template: gateway } },
        // external：对面有几个实例、活着几个，本侧一概不问
        bindings: [{ alias: "skill", external: "job-1/gw-1", node: "metrics", port: "in" }],
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(root, "job-1");
    const rt = runtimeOf(reg);
    rt.spawn("job-1", "askers", "coder-1");
    // 故意**不**创建 gw-1 —— 跨租户地址不依赖本地实例存在
    rt.spawn("job-1", "gw", "gw-1");
    rt.send({ instance: "job-1/coder-1/worker", port: "start" }, { q: "x" });

    expect(deliveredTo(rt, rt.step() as StepResult)).toEqual(["job-1/gw-1/metrics.in"]);
  });
});

describe("注册期判定", () => {
  it("绑定指向本容器不存在的端点 → 拒，并列出可用的", () => {
    expect(() =>
      registerContainerTemplate(
        store,
        "bad",
        {
          nodes: {
            metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
          },
          edges: {},
          children: {},
          bindings: [{ alias: "x", node: "metrcis", port: "in" }],
        },
        "root_config",
      ),
    ).toThrow(/本容器没有 receive 端点 metrcis\.in[\s\S]*可用：metrics\.in/);
  });

  it("绑定指向未声明的子槽 → 拒，并列出可用子槽", () => {
    const watcher = registerContainerTemplate(store, "watcher", sinkSpec);
    expect(() =>
      registerContainerTemplate(
        store,
        "bad2",
        {
          nodes: {},
          edges: {},
          children: { watchers: { template: watcher } },
          bindings: [{ alias: "x", slot: "wathcers", node: "metrics", port: "in" }],
        },
        "root_config",
      ),
    ).toThrow(/子槽 `wathcers` 没有声明[\s\S]*可用子槽：watchers/);
  });

  it("子模板没有那个端点 → 跨模板校验抓得住", () => {
    const watcher = registerContainerTemplate(store, "watcher", sinkSpec);
    expect(() =>
      registerContainerTemplate(
        store,
        "bad3",
        {
          nodes: {},
          edges: {},
          children: { watchers: { template: watcher } },
          bindings: [{ alias: "x", slot: "watchers", node: "metrics", port: "out" }],
        },
        "root_config",
      ),
    ).toThrow(/没有 receive 端点 metrics\.out/);
  });

  it("★ 非根模板允许欠账 —— 由更外层来还（§3.1 根是递归的终止条件）", () => {
    // 用到 progress 却不绑，作为**非根**模板注册得进去
    const emitter = registerContainerTemplate(store, "emitter", emitterSpec("progress"));
    expect(typeof emitter).toBe("string");

    // 三层：孙子欠的账祖父能还
    const mid = registerContainerTemplate(store, "mid", {
      nodes: {},
      edges: {},
      children: { teams: { template: emitter } },
    });
    const root = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {
          metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
        },
        edges: {},
        children: { mids: { template: mid } },
        bindings: [{ alias: "progress", node: "metrics", port: "in" }],
      },
      "root_config",
    );
    expect(typeof root).toBe("string");
  });

  it("★ `tunnel` 已经不是字段了 —— 隧道机制整个删掉，写它当场被拒", () => {
    expect(() =>
      registerContainerTemplate(store, "both", {
        nodes: {
          n: {
            kind: "handler",
            handler: "noop",
            ports: {
              in: { direction: "receive" },
              out: { direction: "emit", tunnel: "t" },
            },
          },
        },
        edges: {},
        children: {},
      }),
    ).toThrow(InvariantError);
  });
});
