import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";
import { deadlocks } from "../src/obligations.js";

/** 请求方容器：ask 端口出网关（别名），回复落 got 端口。 */
const askerSpec = {
  nodes: {
    worker: {
      kind: "handler",
      handler: "ask",
      ports: {
        start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
        ask: { direction: "emit", alias: "skill.discovery", callback: "got" },
        got: { direction: "receive", servo: { vars: { a: { type: "short", from: "$.a" } } } },
        report: { direction: "emit", alias: "progress" },
      },
    },
  },
  edges: {},
  children: {},
};

/** 服务方容器：被别名绑定指到，answer 端口回复。 */
const serviceSpec = {
  nodes: {
    serve: {
      kind: "handler",
      handler: "serve",
      ports: {
        inbox: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
        answer: { direction: "emit", reply: true },
      },
    },
  },
  edges: {},
  children: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;

function isFailure(r: StepResult | StepFailure | null): r is StepFailure {
  return r !== null && "reason" in r;
}

beforeEach(() => {
  store = new ObjectStore();
  const askerRef = registerContainerTemplate(store, "asker", askerSpec);
  const serviceRef = registerContainerTemplate(store, "service", serviceSpec);
  const rootRef = registerContainerTemplate(
    store,
    "root",
    {
      /**
       * `sink` 是为了给 `progress` 一个落点。
       *
       * 隧道时代 asker 的 `report` 端口没人订阅是合法的（表现为运行期 dangling），
       * 于是**"我故意不接"与"我忘了接"长得一模一样**。别名时代根必须显式表态，
       * 所以这里把它接到一个明摆着的收集节点上 —— 多写一行，换"忘了接线"当场被拒。
       */
      nodes: {
        sink: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
      },
      edges: {},
      children: { askers: { template: askerRef }, services: { template: serviceRef } },
      bindings: [
        { alias: "skill.discovery", slot: "services", node: "serve", port: "inbox" },
        { alias: "progress", node: "sink", port: "in" },
      ],
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(rootRef, "job-1");
  rt = new Runtime(store, reg);
  rt.registerHandler("ask", (vars) => ({ ask: { q: vars.q ?? null } }));
  rt.registerHandler("serve", (vars) => ({ answer: { a: `answered:${String(vars.q)}` } }));
  rt.registerHandler("noop", () => ({}));
});

function setupPair(): void {
  rt.spawn("job-1", "askers", "coder-1");
  rt.spawn("job-1", "services", "discovery");
}

describe("REQUEST / REPLY 与锁账本", () => {
  it("一次请求记一把锁，唯一回复销账，callback 落已声明端点（M3）", () => {
    setupPair();
    rt.registerHandler("collect", () => ({}));
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "skill-x" });

    // 第一步：发出 REQUEST，锁记在**容器**上
    const first = rt.step() as StepResult;
    expect(first.delivered).toHaveLength(1);
    const requestLocks = rt.locks.held("job-1/coder-1").filter((l) => l.kind === "request");
    expect(requestLocks).toHaveLength(1);
    expect(requestLocks[0]?.originNode).toBe("worker");

    // 第二步：服务方回复，锁销账，回复落 got 端口
    const second = rt.step() as StepResult;
    expect(second.traceid).toBe("job-1/discovery");
    expect(rt.locks.held("job-1/coder-1").filter((l) => l.kind === "request")).toHaveLength(0);

    const reply = rt.message(second.delivered[0] as string);
    expect(reply.target).toEqual({ traceid: "job-1/coder-1", node: "worker", port: "got" });

    // 第三步：回复被消费
    rt.registerHandler("ask2", () => ({}));
    const third = rt.step() as StepResult;
    expect(third.vars).toEqual({ a: "answered:skill-x" });
  });

  it("非 REQUEST 消息走 reply 端口被拒绝", () => {
    setupPair();
    // 直接投一条普通消息进服务方 inbox（没有 requestId），它仍会走 answer 端口
    rt.send({ traceid: "job-1/discovery", node: "serve", port: "inbox" }, { q: "x" });
    const result = rt.step();
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/不是 REQUEST/);
  });

  it("REQUEST 要求恰好一个订阅者，零个或多个都失败", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    const none = rt.step();
    expect(isFailure(none)).toBe(true);
    if (isFailure(none)) expect(none.reason).toMatch(/恰好 1 个目标，实际 0 个/);

    rt.spawn("job-1", "services", "d1");
    rt.spawn("job-1", "services", "d2");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    const many = rt.step();
    expect(isFailure(many)).toBe(true);
    if (isFailure(many)) expect(many.reason).toMatch(/实际 2 个/);
  });
});

describe("子容器锁（L1 第 2 种）", () => {
  it("spawn 对父容器记一把 child 锁", () => {
    rt.spawn("job-1", "askers", "coder-1");
    const childLocks = rt.locks.held("job-1").filter((l) => l.kind === "child");
    expect(childLocks).toHaveLength(1);
    expect(childLocks[0]?.waitingOn).toBe("job-1/coder-1");
  });
});

describe("终止判定（L5 三谓词）", () => {
  it("有待处理消息或有锁都挡住终止，都清掉才可终止", () => {
    expect(rt.canTerminate("job-1")).toBe(true);

    rt.spawn("job-1", "askers", "coder-1");
    expect(rt.terminationBlockers("job-1")).toEqual(["锁 child · 等 job-1/coder-1"]);

    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    expect(rt.terminationBlockers("job-1/coder-1")).toEqual(["1 条待处理消息"]);
  });
});

describe("强制截断（§9.6）", () => {
  it("推进 generation、丢弃消息留计数、级联子容器", () => {
    setupPair();
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });

    const result = rt.truncate("job-1", "需求变更");
    expect(result.generation).toBe(1);
    expect([...result.cascaded].sort()).toEqual(["job-1/coder-1", "job-1/discovery"]);
    expect(reg.get("job-1").status).toBe("TERMINAL");
    expect(reg.get("job-1/coder-1").status).toBe("TERMINAL");
    expect(rt.messages().filter((m) => m.state === "DISCARDED")).toHaveLength(1);
  });

  it("★ 第 4 步反向清账：截断子容器后，父容器不再被已死的子挡住", () => {
    rt.spawn("job-1", "askers", "coder-1");
    expect(rt.canTerminate("job-1")).toBe(false);

    rt.truncate("job-1/coder-1", "子容器截断");
    expect(rt.locks.causedBy("job-1/coder-1")).toEqual([]);
    expect(rt.canTerminate("job-1")).toBe(true);
  });

  it("★ 迟到回复不复活已截断的实例（generation fence / L3）", () => {
    setupPair();
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step(); // 发出 REQUEST

    rt.truncate("job-1/coder-1", "请求方被截断");

    // 服务方此刻才回复
    const late = rt.step();
    expect(isFailure(late)).toBe(true);
    if (isFailure(late)) expect(late.reason).toMatch(/已回复或已作废|已截断/);
    expect(reg.get("job-1/coder-1").status).toBe("TERMINAL");
  });

  it("重复截断幂等，不留第二条事实", () => {
    rt.spawn("job-1", "askers", "coder-1");
    const first = rt.truncate("job-1/coder-1", "一次");
    const second = rt.truncate("job-1/coder-1", "二次");
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(1);
    expect(second.truncatedMessages).toBe(0);
    expect(second.releasedLocks).toBe(0);
  });
});

describe("PUBLISH 的可见范围（原不变量 M2 的作用域）", () => {
  /** 只有一个收集节点的容器，用来当"接住 progress 的那一方"。 */
  const sinkSpec = {
    nodes: {
      metrics: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
    },
    edges: {},
    children: {},
  };

  it("绑定挂在子槽上，只有那一支看得见 —— 替代绝对 scope", () => {
    const watcherRef = registerContainerTemplate(store, "watcher", sinkSpec);
    const askerRef = "asker@1";
    const rootRef = registerContainerTemplate(
      store,
      "root2",
      {
        /**
         * 隧道时代 team-b 发的 progress 匹配不到订阅者，表现为运行期 dangling
         * —— 而"我故意排除了 team-b"与"我忘了给 team-b 接线"长得一模一样。
         *
         * 别名时代根必须显式表态：team-a 接到 watchers 槽，team-b 接到根自己的
         * `spill`。要验的性质没变（**team-b 发的到不了 w1**），只是现在由结构给出，
         * 而不是投递时逐对求 scope。
         */
        nodes: {
          spill: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
        },
        edges: {},
        children: {
          watchers: { template: watcherRef },
          "team-a": {
            template: askerRef,
            bindings: [{ alias: "progress", slot: "watchers", node: "metrics", port: "in" }],
          },
          "team-b": {
            template: askerRef,
            bindings: [{ alias: "progress", node: "spill", port: "in" }],
          },
        },
        bindings: [{ alias: "skill.discovery", slot: "watchers", node: "metrics", port: "in" }],
      },
      "root_config",
    );
    const reg2 = new InstanceRegistry(store);
    reg2.createRoot(rootRef, "job-1");
    const rt2 = new Runtime(store, reg2);
    rt2.registerHandler("ask", (vars) => ({ report: { q: vars.q ?? null } }));
    rt2.registerHandler("noop", () => ({}));
    rt2.spawn("job-1", "watchers", "w1");
    rt2.spawn("job-1", "team-a", "team-a");
    rt2.spawn("job-1", "team-b", "team-b");

    // team-a 发的 progress 落到 w1
    rt2.send({ traceid: "job-1/team-a", node: "worker", port: "start" }, { q: "a" });
    const inScope = rt2.step() as StepResult;
    expect(inScope.traceid).toBe("job-1/team-a");
    expect(rt2.message(inScope.delivered[0] as string).target.traceid).toBe("job-1/w1");

    // team-b 发的**到不了 w1** —— 它那一支绑的是根自己的 spill
    rt2.drain();
    rt2.send({ traceid: "job-1/team-b", node: "worker", port: "start" }, { q: "b" });
    const outside = rt2
      .drain()
      .filter((r): r is StepResult => !("reason" in r) && r.traceid === "job-1/team-b");
    expect(outside).toHaveLength(1);
    const target = rt2.message(outside[0]?.delivered[0] as string).target;
    expect(target).toEqual({ traceid: "job-1", node: "spill", port: "in" });
    // w1 一条都没多收
    expect(
      rt2.messages().filter((m) => m.target.traceid === "job-1/w1" && m.alias === "progress"),
    ).toHaveLength(1);
  });

  it("★ 帧 11：绑定对自己整棵子树可见，换实例仍然正确 —— 而且没有作用域字段", () => {
    const watcherSpec = {
      ...sinkSpec,
      children: { teams: { template: "asker@1" } },
      /**
       * 这就是 `$self_subtree` 的全部替代：**一条普通绑定**。
       *
       * 向上查找天然只够得着自己的祖先，所以 t1 只解析得到 w-a、t2 只解析得到 w-b。
       * "只收本子树发的"不再是一条要在投递时求值的规则，而是查找方向的推论 ——
       * 整个 `SubscriptionScope` 因此失去存在理由。
       */
      bindings: [
        { alias: "progress", node: "metrics", port: "in" },
        { alias: "skill.discovery", node: "metrics", port: "in" },
      ],
    };
    const watcherRef = registerContainerTemplate(store, "watcher-rel", watcherSpec);
    const rootRef = registerContainerTemplate(
      store,
      "root3",
      { nodes: {}, edges: {}, children: { w: { template: watcherRef } } },
      "root_config",
    );
    const reg3 = new InstanceRegistry(store);
    reg3.createRoot(rootRef, "job-9");
    const rt3 = new Runtime(store, reg3);
    rt3.registerHandler("ask", (vars) => ({ report: { q: vars.q ?? null } }));
    rt3.registerHandler("noop", () => ({}));

    // 同一个 watcher 模板实例化两份，各带一个 team
    rt3.spawn("job-9", "w", "w-a");
    rt3.spawn("job-9", "w", "w-b");
    rt3.spawn("job-9/w-a", "teams", "t1");
    rt3.spawn("job-9/w-b", "teams", "t2");

    rt3.send({ traceid: "job-9/w-a/t1", node: "worker", port: "start" }, { q: "a" });
    const step = rt3.step() as StepResult;
    // 只投给 w-a，不投给 w-b
    expect(step.delivered).toHaveLength(1);
    expect(rt3.message(step.delivered[0] as string).target.traceid).toBe("job-9/w-a");

    // ★ 自给自足：t1 手里就有完整寻址表，解析不需要再往上问任何人
    expect(reg3.get("job-9/w-a/t1").bindings.map((b) => `${b.alias}@${b.container}`)).toEqual([
      "progress@job-9/w-a",
      "skill.discovery@job-9/w-a",
    ]);
  });
});

describe("死锁检测只报警不裁决", () => {
  /**
   * 这条用例原本靠 `rt.locks.acquire(...)` 手工往账本里塞两把互等的锁。
   * 账本归约成派生投影之后没有 `acquire` 了 —— 而这反而让测试更直接：
   * 环检测是**等待图上的纯函数**，喂它一组义务就行，不必先把状态摆成那样。
   */
  it("互等形成环时能报出参与者", () => {
    const cycles = deadlocks([
      { kind: "child", holder: "job-1/a", key: "b", waitingOn: "job-1/b" },
      { kind: "child", holder: "job-1/b", key: "a", waitingOn: "job-1/a" },
    ]);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] as string[])].sort()).toEqual(["job-1/a", "job-1/b"]);
  });

  it("没有环就不报", () => {
    const cycles = deadlocks([
      { kind: "child", holder: "job-1", key: "a", waitingOn: "job-1/a" },
      { kind: "request", holder: "job-1/a", key: "req-1", waitingOn: "job-1/b" },
    ]);
    expect(cycles).toEqual([]);
  });
});
