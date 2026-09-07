/**
 * 未了结的义务 —— 归约之后的行为钉子。
 *
 * 这个文件的前身是一组**证伪脚手架**：在测试侧重算一遍义务，逐条与锁账本比对，
 * 外加一个挂到全部既有用例上的普查钩子。假设成立、账本删掉之后，那种比对就变成
 * "自己跟自己比"了 —— 留着它正是这个项目一路在消灭的形状。所以脚手架撤掉，
 * 换成对 `Runtime.obligations()` 的直接断言。
 *
 * 归约留下的三条性质，下面逐条钉：
 *
 *   1. 四种义务是**一条**枚举，`terminationBlockers` 只是它的投影
 *   2. 义务从事实算出来，**没有第二份拷贝可以忘记更新** —— 半状态不可表达
 *   3. 服务方死亡走**正常回复路径**了结，不是静默销账
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepResult } from "../src/runtime.js";

const askerSpec = {
  nodes: {
    worker: {
      kind: "handler",
      handler: "ask",
      ports: {
        start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
        ask: { direction: "emit", alias: "skill.discovery", callback: "got", unavailable: { a: "（服务不可用）" } },
        got: { direction: "receive", servo: { vars: { a: { type: "short", from: "$.a" } } } },
      },
    },
  },
  edges: {},
  children: {},
};

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

/** 叶子容器：什么都不做，只用来当第三层实例。 */
const leafSpec = {
  nodes: { l: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {},
  children: {},
};

/** 带 agent 段的容器 —— 用来造一条 RUNNING 记录（claim 不需要 backend）。 */
const agentSpec = {
  nodes: {
    a: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: {
        in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } },
        out: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;

beforeEach(() => {
  store = new ObjectStore();
  const leafRef = registerContainerTemplate(store, "leaf", leafSpec);
  // 三层嵌套用：mid 声明一个子槽，才能在它底下再 spawn
  const midRef = registerContainerTemplate(store, "mid", {
    ...leafSpec,
    children: { subs: { template: leafRef } },
  });
  const askerRef = registerContainerTemplate(store, "asker", askerSpec);
  const serviceRef = registerContainerTemplate(store, "service", serviceSpec);
  const agentRef = registerContainerTemplate(store, "agentbox", agentSpec);
  const rootRef = registerContainerTemplate(
    store,
    "root",
    {
      nodes: {},
      edges: {},
      children: {
        askers: { template: askerRef },
        services: { template: serviceRef },
        agents: { template: agentRef },
        mids: { template: midRef },
      },
      // 别名绑到 services 槽 —— 谁占这个槽谁服务，请求方不写死任何实例
      bindings: [{ alias: "skill.discovery", slot: "services", node: "serve", port: "inbox" }],
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(rootRef, "job-1");
  rt = new Runtime(store, reg);
  rt.registerHandler("noop", () => ({}));
  /**
   * `ctx.port` 区分"新任务"与"回复到了" —— 少了它，回复落回同一节点会让
   * handler 再发一次请求，自己给自己造无限循环（§6.4 写过这个坑）。
   */
  rt.registerHandler("ask", (vars, ctx) =>
    ctx.port === "got" ? {} : { ask: { q: vars.q ?? null } },
  );
  rt.registerHandler("serve", (vars) => ({ answer: { a: `answered:${String(vars.q)}` } }));
});

describe("child 义务 = 子实例还 OPEN", () => {
  it("spawn 产生义务，settle 让它消失 —— 中间没有记账这一步", () => {
    expect(rt.obligations()).toEqual([]);

    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "askers", "coder-2");
    expect(rt.obligations("job-1")).toEqual([
      { kind: "child", holder: "job-1", key: "job-1/coder-1", waitingOn: "job-1/coder-1" },
      { kind: "child", holder: "job-1", key: "job-1/coder-2", waitingOn: "job-1/coder-2" },
    ]);

    expect(rt.settle("job-1/coder-1")).toBe(true);
    expect(rt.obligations("job-1").map((o) => o.key)).toEqual(["job-1/coder-2"]);

    expect(rt.settle("job-1/coder-2")).toBe(true);
    expect(rt.obligations()).toEqual([]);
    expect(rt.canTerminate("job-1")).toBe(true);
  });

  it("截断父容器：级联之后整棵子树的义务一起消失", () => {
    rt.spawn("job-1", "mids", "mid-1");
    rt.spawn("job-1/mid-1", "subs", "sub-1");
    expect(rt.obligations().map((o) => o.holder)).toEqual(["job-1", "job-1/mid-1"]);

    rt.truncate("job-1/mid-1", "试验");
    expect(rt.obligations()).toEqual([]);
  });

  it("★ 半状态不可表达：绕过 settle 直接改 status，义务当场跟着消失", () => {
    rt.spawn("job-1", "askers", "coder-1");
    expect(rt.obligations("job-1")).toHaveLength(1);

    // 账本时代这会造出"锁还在、子已终态"的半状态，checkInvariants 当场判违规
    reg.setStatus("job-1/coder-1", "TERMINAL");
    expect(rt.obligations("job-1")).toEqual([]);
    rt.checkInvariants();
  });
});

describe("request 义务 = 还没回复的请求", () => {
  it("请求发出 → 回复销账；waitingOn 记的是服务方", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "skill-x" });

    rt.step() as StepResult; // 发出 REQUEST
    expect(rt.obligations("job-1/coder-1").filter((o) => o.kind === "request")).toEqual([
      {
        kind: "request",
        holder: "job-1/coder-1",
        key: "req-1",
        originNode: "worker",
        waitingOn: "job-1/discovery",
      },
    ]);

    rt.step() as StepResult; // 服务方回复 → 销账
    expect(rt.obligations("job-1/coder-1").filter((o) => o.kind === "request")).toEqual([]);
  });

  it("截断请求方：请求连同它一起了结", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step();

    rt.truncate("job-1/coder-1", "试验");
    expect(rt.obligations().filter((o) => o.kind === "request")).toEqual([]);
    expect((rt.snapshot() as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
});

describe("服务方死亡：了结走正常回复路径", () => {
  /**
   * 跨 353 条既有用例的普查抓到的分叉：此前 `#truncate` 反向释放了请求方的锁，
   * `#pending` 却一条不删 —— 账本说"不等了"，pending 说"还等着"。
   *
   * 修法不是"把 pending 也删掉"，那样请求方**什么都收不到**：它已经消费了
   * 自己的输入、发出了请求，然后永远没有下文。修法是代服务方发一条了结通知，
   * 走请求方**声明过的** callback 端口 —— 与"子进终态 → 往父投通知"同形。
   */
  it("请求方的 callback 端口收到了结通知", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step(); // 发出 REQUEST

    rt.truncate("job-1/discovery", "服务方挂了");

    expect(rt.obligations().filter((o) => o.kind === "request")).toEqual([]);
    expect((rt.snapshot() as { pending: Map<string, unknown> }).pending.size).toBe(0);

    const notice = rt.messages().find((m) => m.state === "QUEUED");
    expect(notice?.target).toEqual({ traceid: "job-1/coder-1", node: "worker", port: "got" });
    // 载荷是**请求方自己声明的**那份，不是内核自造的形状 —— 内核造的过不了
    // 请求方 callback 端口的 servo，会在提取那一步被拒（handler 根本不会被叫醒）
    expect(notice?.payload).toEqual({ a: "（服务不可用）" });
    // 来源是服务方实例本身，不是它某个节点的 emit
    expect(notice?.source).toEqual({ traceid: "job-1/discovery" });

    // ★ 而且吃得下：消费它，handler 跑起来，消息进 CONSUMED 而不是 FAILED
    expect(rt.step()).not.toBeNull();
    expect(rt.messages().find((m) => m.target.port === "got")?.state).toBe("CONSUMED");
  });

  it("请求方已经不在了就不投递 —— 不给死实例塞消息", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step();

    rt.truncate("job-1/coder-1", "请求方先挂");
    rt.truncate("job-1/discovery", "服务方后挂");

    expect(rt.messages().filter((m) => m.state === "QUEUED")).toHaveLength(0);
    expect(rt.obligations().filter((o) => o.kind === "request")).toEqual([]);
  });

  it("★ 不再是落盘的无界泄漏：截断 5 次，pending 仍是 0", () => {
    const ROUNDS = 5;
    let notices = 0;
    // 一次只留一个活着的服务方 —— REQUEST 要求隧道上恰好 1 个订阅者
    for (let i = 1; i <= ROUNDS; i += 1) {
      rt.spawn("job-1", "askers", `coder-${i}`);
      rt.spawn("job-1", "services", `svc-${i}`);
      rt.send({ traceid: `job-1/coder-${i}`, node: "worker", port: "start" }, { q: "x" });
      rt.step(); // 发出 REQUEST
      rt.truncate(`job-1/svc-${i}`, "服务方挂了");

      const notice = rt.messages().find((m) => m.state === "QUEUED");
      expect(notice?.target).toEqual({
        traceid: `job-1/coder-${i}`,
        node: "worker",
        port: "got",
      });
      notices += 1;
      // 消费掉它，否则下一轮的 step() 会先拿到这条而不是新任务
      rt.step();
    }

    expect(notices).toBe(ROUNDS);
    // pending 跟着头全量落盘，泄漏一条就是永久多一条 —— 现在是 0
    expect((rt.snapshot() as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect(rt.obligations().filter((o) => o.kind === "request")).toEqual([]);
  });
});

describe("四种义务是一条枚举", () => {
  it("在途消息", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });

    expect(rt.obligations("job-1/coder-1").map((o) => o.kind)).toEqual(["message"]);
    expect(rt.terminationBlockers("job-1/coder-1")).toEqual(["1 条待处理消息"]);
    expect(rt.canTerminate("job-1/coder-1")).toBe(false);
  });

  it("在途执行 —— claim 之后消息与记录各是一份义务", () => {
    rt.spawn("job-1", "agents", "a1");
    rt.send({ traceid: "job-1/a1", node: "a", port: "in" }, { v: 1 });
    expect(rt.claimAgent().kind).toBe("claimed");

    expect(
      rt
        .obligations("job-1/a1")
        .map((o) => o.kind)
        .sort(),
    ).toEqual(["execution", "message"]);
    expect(rt.terminationBlockers("job-1/a1")).toEqual([
      "1 条待处理消息",
      "1 个在途 execution",
    ]);
  });

  it("四种同时在场，且 blockers 就是它的投影", () => {
    rt.spawn("job-1", "askers", "coder-1");
    rt.spawn("job-1", "services", "discovery");
    rt.spawn("job-1", "agents", "a1");
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step(); // request 义务
    rt.send({ traceid: "job-1/a1", node: "a", port: "in" }, { v: 1 });
    rt.claimAgent(); // execution 义务

    expect(new Set(rt.obligations().map((o) => o.kind))).toEqual(
      new Set(["message", "execution", "request", "child"]),
    );
    // 投影：能不能终止，只看名下义务是不是空
    for (const inst of reg.subtree("job-1")) {
      expect(rt.canTerminate(inst.traceid)).toBe(rt.obligations(inst.traceid).length === 0);
    }
    expect(rt.terminationBlockers("job-1/coder-1")).toEqual([
      "锁 request · 等 job-1/discovery（worker 发起）",
    ]);
  });
});
