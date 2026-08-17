import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";

/** 请求方容器：ask 端口出隧道，回复落 got 端口。 */
const askerSpec = {
  nodes: {
    worker: {
      kind: "handler",
      handler: "ask",
      ports: {
        start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
        ask: { direction: "emit", tunnel: "skill.discovery", callback: "got" },
        got: { direction: "receive", servo: { vars: { a: { type: "short", from: "$.a" } } } },
        report: { direction: "emit", tunnel: "progress" },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

/** 服务方容器：订阅隧道，answer 端口回复。 */
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
  subscriptions: { s1: { tunnel: "skill.discovery", to: { node: "serve", port: "inbox" } } },
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
      nodes: {},
      edges: {},
      children: { askers: { template: askerRef }, services: { template: serviceRef } },
      subscriptions: {},
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(rootRef, "job-1");
  rt = new Runtime(store, reg);
  rt.registerHandler("ask", (vars) => ({ ask: { q: vars.q ?? null } }));
  rt.registerHandler("serve", (vars) => ({ answer: { a: `answered:${String(vars.q)}` } }));
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

  it("重复回复被明确拒绝", () => {
    setupPair();
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step();
    const inbox = rt.pending()[0];
    rt.step();

    // 手工再投一条同 requestId 的消息，模拟重复回复
    const replayed = rt.messages().find((m) => m.id === inbox?.id);
    expect(replayed?.requestId).toBeDefined();
    const again = new Runtime(store, reg);
    again.registerHandler("serve", () => ({ answer: { a: "dup" } }));
    again.send({ traceid: "job-1/discovery", node: "serve", port: "inbox" }, { q: "x" });
    const result = again.step();
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/不是 REQUEST/);
  });

  it("REQUEST 要求恰好一个订阅者，零个或多个都失败", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    const none = rt.step();
    expect(isFailure(none)).toBe(true);
    if (isFailure(none)) expect(none.reason).toMatch(/恰好 1 个订阅者，实际 0 个/);

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

describe("PUBLISH 与 traceid 作用域（不变量 M2）", () => {
  it("订阅声明 scope 后只收该子树发出的消息", () => {
    const watcherSpec = {
      nodes: {
        metrics: {
          kind: "handler",
          handler: "noop",
          ports: { in: { direction: "receive" } },
        },
      },
      edges: {},
      children: {},
      subscriptions: {
        mine: { tunnel: "progress", scope: "job-1/team-a", to: { node: "metrics", port: "in" } },
      },
    };
    const watcherRef = registerContainerTemplate(store, "watcher", watcherSpec);
    const askerRef = "asker@1";
    const rootRef = registerContainerTemplate(
      store,
      "root2",
      {
        nodes: {},
        edges: {},
        children: {
          watchers: { template: watcherRef },
          "team-a": { template: askerRef },
          "team-b": { template: askerRef },
        },
        subscriptions: {},
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

    rt2.send({ traceid: "job-1/team-a", node: "worker", port: "start" }, { q: "a" });
    const inScope = rt2.step() as StepResult;
    expect(inScope.delivered).toHaveLength(1);

    rt2.send({ traceid: "job-1/team-b", node: "worker", port: "start" }, { q: "b" });
    rt2.step(); // 消费 w1 的入站
    const outOfScope = rt2.messages().filter((m) => m.tunnel === "progress");
    // team-b 的 progress 不该投给 scope=job-1/team-a 的订阅者
    expect(outOfScope.every((m) => m.target.traceid === "job-1/w1")).toBe(true);
    expect(outOfScope).toHaveLength(1);
  });
});

describe("死锁检测只报警不裁决", () => {
  it("互等形成环时能报出参与者", () => {
    rt.locks.acquire({ holder: "job-1/a", kind: "child", key: "b", waitingOn: "job-1/b" });
    rt.locks.acquire({ holder: "job-1/b", kind: "child", key: "a", waitingOn: "job-1/a" });
    const cycles = rt.locks.deadlocks();
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] as string[])].sort()).toEqual(["job-1/a", "job-1/b"]);
  });
});
