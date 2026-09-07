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
        ask: { direction: "emit", alias: "skill.discovery", callback: "got", unavailable: { a: "（服务不可用）" } },
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
    const requestLocks = rt.obligations("job-1/coder-1").filter((o) => o.kind === "request");
    expect(requestLocks).toHaveLength(1);
    expect(requestLocks[0]?.originNode).toBe("worker");

    // 第二步：服务方回复，锁销账，回复落 got 端口
    const second = rt.step() as StepResult;
    expect(second.traceid).toBe("job-1/discovery");
    expect(rt.obligations("job-1/coder-1").filter((o) => o.kind === "request")).toHaveLength(0);

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
    const childLocks = rt.obligations("job-1").filter((o) => o.kind === "child");
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
    expect(rt.obligations().filter((o) => o.waitingOn === "job-1/coder-1")).toEqual([]);
    expect(rt.canTerminate("job-1")).toBe(true);
  });

  /**
   * ★ 请求方被截断，代价不该落在服务方身上。
   *
   * `#truncate` 第 3 步把请求方名下的 `#pending` 条目**直接删掉**，而服务方
   * 还是 OPEN、它的入站请求还在队列里。等它出货时 `lookupRequest` 拿到
   * undefined，排期整体判失败 —— 于是：
   *
   *   1. 归因是错的。"拒绝重复回复"说的是"你回了两次"，而真相是"你的调用方没了"。
   *   2. **agent 服务方会被重跑三次。**排期失败在 apply 里归 INVALID_OUTPUT，
   *      它不在 NON_RETRYABLE 里，于是消息退回 QUEUED —— 对一个永远不会
   *      变好的条件付三次模型钱。
   *
   * 对称的那半早就修好了：**服务方**被截断时会代它发一条请求方自己声明的
   * `unavailable`。反方向还停在"光删 pending"，让对面撞墙。
   *
   * 回复没有接收方 = `dangling`，这与"PUBLISH 零订阅者"是同一件事，
   * 而那件事这个文件里一直就不算错误。
   */
  it("★ 请求方被截断后，服务方照常收口，迟到回复也不复活它（L3）", () => {
    setupPair();
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "x" });
    rt.step(); // 发出 REQUEST
    const request = rt.messages().find((m) => m.target.traceid === "job-1/discovery");
    expect(request).toBeDefined();

    rt.truncate("job-1/coder-1", "请求方被截断");

    const served = rt.step();
    expect(isFailure(served)).toBe(false);
    // 服务方干完了自己的活：消息收口，不退回队列
    expect(rt.message((request as { id: string }).id).state).toBe("CONSUMED");
    expect(rt.message((request as { id: string }).id).attempts).toBe(0);
    // reply 端口没有接收方 —— 报成 dangling，与零订阅者的 PUBLISH 同例
    expect((served as StepResult).dangling).toContain("answer");
    // 服务方自己毫发无伤，也不欠任何义务
    expect(reg.get("job-1/discovery").status).toBe("OPEN");
    expect(rt.obligations("job-1/discovery")).toEqual([]);
    // 而被截断的请求方仍然没被复活，一条消息都没收到
    expect(reg.get("job-1/coder-1").status).toBe("TERMINAL");
    expect(rt.messages().filter((m) => m.target.traceid === "job-1/coder-1" && m.state === "QUEUED"))
      .toEqual([]);
  });

  it("重复截断幂等，不留第二条事实", () => {
    rt.spawn("job-1", "askers", "coder-1");
    const first = rt.truncate("job-1/coder-1", "一次");
    const second = rt.truncate("job-1/coder-1", "二次");
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(1);
    expect(second.truncatedMessages).toBe(0);
    expect(second.cancelledExecutions).toBe(0);
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

  /**
   * ★ 死锁**不发信号** —— 这是决定，不是遗漏。
   *
   * 服务方失败、服务方被截断、子实例进终态，三样都发信号，因为它们都有一个
   * **确定的收信人**和一个确定的事实（"这条请求不会有回复了"）。死锁没有：
   *
   *   1. A 等 B、B 等 A，**通知谁？**通知任一方等于替它决定"你先放弃" ——
   *      而哪边放弃更便宜，内核不知道，那是策略。
   *   2. 更要紧的是：自动通知会**把环解开**。环几乎一定是图写错了，
   *      自动恢复等于把一个建模错误悄悄抹平，下次还犯。
   *
   * 所以分工是：**内核检测，主体决定**。`hertaloy status` 把环报给人，
   * 人调 `truncate` —— 而 truncate 是发信号的，等待方照常收到 UNAVAILABLE。
   * 信号仍然只从"有确定收信人的事实"里产生。
   *
   * 这条用例钉的是这个决定本身。谁哪天想"顺手补上死锁通知"，先来改这段注释。
   */
  it("★ 检测到环也不往图里投消息 —— 内核检测，主体决定", () => {
    setupPair();
    rt.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "在吗" });
    // 只推一步：这个 fixture 的 ask handler 不看进来的端口，回复落回 got 会再发
    // 一次请求 —— drain 在这儿不收敛（§6.4 那个坑），既有用例也都是逐步推的
    rt.step();

    const before = rt.messages().length;
    // 反复问同一件事不产生任何消息 —— 它是纯查询
    deadlocks(rt.obligations());
    rt.obligations();
    expect(rt.messages()).toHaveLength(before);
  });
});

/**
 * ★ 服务方**永久失败**时，请求方会怎样？
 *
 * 截断那条路已经修好了：服务方被 truncate → 代它发一条 `UNAVAILABLE` 通知回
 * 请求方的 callback，请求方 handler 自己决定重试还是降级。
 *
 * 但**失败**这条路没修 —— `#applyFailure` 耗尽重试后只把消息置 `FAILED`，
 * 没有任何人被告知。这一组就是去问：请求方是不是就这么永远等下去。
 */
describe("★ 服务方永久失败 → 请求方被告知了吗", () => {
  /** 服务节点改成 agent，好让它走三段式的失败通道（同步 handler 抛异常是编程错误）。 */
  const failingService = {
    nodes: {
      serve: {
        kind: "handler",
        agent: { argv: ["boom"] },
        ports: {
          inbox: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
          answer: { direction: "emit", reply: true },
        },
      },
    },
    edges: {},
    children: {},
  };

  async function runToFailure(
    termination: "FAILED" | "BUDGET" = "FAILED",
    maxAttempts = 1,
  ): Promise<Runtime> {
    const s = new ObjectStore();
    const askerRef = registerContainerTemplate(s, "asker", askerSpec);
    const serviceRef = registerContainerTemplate(s, "service", failingService);
    const rootRef = registerContainerTemplate(
      s,
      "root",
      {
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
    const r = new InstanceRegistry(s);
    r.createRoot(rootRef, "job-1");
    const backend = {
      async run(req: { executionId: string }) {
        return {
          executionId: req.executionId,
          emissions: {},
          termination,
        };
      },
      async cancel() {},
    };
    const runtime = new Runtime(s, r, { backend, maxAttempts });
    const woken: { port: string; vars: Record<string, unknown> }[] = [];
    runtime.registerHandler("ask", (vars, ctx) => {
      woken.push({ port: ctx.port, vars: { ...vars } });
      return ctx.port === "got" ? {} : { ask: { q: vars.q ?? null } };
    });
    (runtime as unknown as { woken: typeof woken }).woken = woken;
    runtime.registerHandler("noop", () => ({}));

    runtime.spawn("job-1", "askers", "coder-1");
    runtime.spawn("job-1", "services", "discovery");
    runtime.send({ traceid: "job-1/coder-1", node: "worker", port: "start" }, { q: "在吗" });
    runtime.drain(); // 请求发出
    // 只推一步：maxAttempts > 1 时消息会回到 QUEUED，drainAgents 会一直重试到耗尽
    await runtime.stepAgent(); // 服务方失败
    return runtime;
  }

  it("服务方的消息确实进了 FAILED（前提）", async () => {
    const runtime = await runToFailure();
    const dead = runtime
      .messages()
      .filter((m) => m.target.traceid === "job-1/discovery" && m.state === "FAILED");
    expect(dead).toHaveLength(1);
  });

  /**
   * ★ 这条测的是**路**，不是账。
   *
   * 上一版只断言"通知投出来了"，而它其实吃不下：callback 端口的 servo 照着
   * 回复的形状写（`$.a`），内核自造的 `{status, service, reason}` 在变量提取
   * 那一步就被拒，消息进 FAILED，**handler 根本没被叫醒**。两端各自都绿、
   * 中间没人走 —— 而那一版是绿的。
   *
   * 所以现在断言的是"请求方的 handler 真的跑了，并拿到了自己声明的那份"。
   */
  it("★ 请求方的 handler 真的被叫醒，拿到自己声明的 unavailable", async () => {
    const runtime = await runToFailure();
    const woken = (runtime as unknown as { woken: { port: string; vars: Record<string, unknown> }[] })
      .woken;

    // 通知投出来了
    const inbox = runtime
      .messages()
      .filter((m) => m.target.traceid === "job-1/coder-1" && m.target.port === "got");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toEqual({ a: "（服务不可用）" });

    // ★ 而且吃得下 —— 消费它，handler 跑起来，servo 提得出变量
    const out = runtime.step();
    expect(out).not.toBeNull();
    expect(woken.map((w) => w.port)).toEqual(["start", "got"]);
    expect(woken[1]?.vars).toEqual({ a: "（服务不可用）" });
    // 消息进的是 CONSUMED，不是 FAILED
    expect(
      runtime.messages().find((m) => m.target.port === "got")?.state,
    ).toBe("CONSUMED");
  });

  it("★ 请求方因此不再永远欠着一条请求", async () => {
    const runtime = await runToFailure();
    const kinds = runtime.obligations("job-1/coder-1").map((o) => o.kind);
    expect(kinds).not.toContain("request");
  });

  /**
   * BUDGET / CANCELLED 走的是另一条出口（不可重试 → 消息 DISCARDED），
   * 与"重试耗尽 → FAILED"是**两个分支**。分开写过一次的东西就会分开漏一次，
   * 所以这条单独钉住：两个分支现在共用同一处终态处理。
   */
  it("★ 预算耗尽（不可重试的那条出口）同样告知请求方", async () => {
    const runtime = await runToFailure("BUDGET");
    const inbox = runtime
      .messages()
      .filter((m) => m.target.traceid === "job-1/coder-1" && m.target.port === "got");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toEqual({ a: "（服务不可用）" });
    // 同样要吃得下
    expect(runtime.step()).not.toBeNull();
    expect(runtime.messages().find((m) => m.target.port === "got")?.state).toBe("CONSUMED");
    expect(runtime.obligations("job-1/coder-1").map((o) => o.kind)).not.toContain("request");
  });

  /**
   * ★ 重试**中**不发通知 —— 请求还活着。
   *
   * 这条是上面那条的反面。终态处理挂在"消息进终态"上，而重试分支并不进终态；
   * 要是挂错地方（比如挂在 `#applyFailure` 入口），第一次失败就会给请求方
   * 发一条 UNAVAILABLE，然后重试成功又发一条真回复 —— 请求方收到两条，
   * 而 M3 说 callback 只该落一次。
   */
  it("★ 还在重试时不发通知 —— 请求还活着", async () => {
    const runtime = await runToFailure("FAILED", 3);
    const inbox = runtime
      .messages()
      .filter((m) => m.target.traceid === "job-1/coder-1" && m.target.port === "got");
    // maxAttempts 3、只跑了一步 → 消息回到 QUEUED，请求方不该收到任何东西
    expect(inbox).toHaveLength(0);
    expect(runtime.obligations("job-1/coder-1").map((o) => o.kind)).toContain("request");
  });
});

/**
 * ★ 注册期就判定"信号吃不吃得下"。
 *
 * 声明"等不到回复时当作收到这个"只是一半；另一半是它得过得了自己 callback
 * 端口的**契约**与 **servo**。过不了的后果是运行期一条 FAILED 消息，而请求方的
 * handler 根本不会被叫醒 —— 通知发了等于没发，**而且没有任何红灯**：
 * 发送侧绿的，接收侧绿的，中间没人走。
 *
 * 这一组就是那盏红灯，而且亮在注册期，不是等到某次真失败才发现。
 */
describe("★ 信号载荷的注册期校验", () => {
  const askerWith = (unavailable: unknown) => ({
    nodes: {
      worker: {
        kind: "handler",
        handler: "ask",
        ports: {
          start: { direction: "receive", servo: { vars: {} } },
          ask: { direction: "emit", alias: "svc", callback: "got", unavailable },
          got: {
            direction: "receive",
            servo: { vars: { a: { type: "short", from: "$.a" } } },
          },
        },
      },
    },
    edges: {},
    children: {},
  });

  it("形状对得上 → 通过", () => {
    const s = new ObjectStore();
    expect(() => registerContainerTemplate(s, "ok", askerWith({ a: "占位" }))).not.toThrow();
  });

  it("★ 形状对不上 → 注册期就拒，并说清是 servo 那一关", () => {
    const s = new ObjectStore();
    expect(() => registerContainerTemplate(s, "bad", askerWith({ status: "没了" }))).toThrow(
      /unavailable.*servo.*路径 \$\.a/s,
    );
  });

  it("★ 不声明 → 注册期就拒（「我不需要」与「我忘了」不该长得一样）", () => {
    const s = new ObjectStore();
    const spec = askerWith(undefined) as { nodes: Record<string, { ports: Record<string, Record<string, unknown>> }> };
    delete spec.nodes.worker!.ports.ask!.unavailable;
    expect(() => registerContainerTemplate(s, "missing", spec)).toThrow(/必须声明 `unavailable`/);
  });

  /**
   * 子终止通知是**内核造的固定形状** `{slot, traceid, status}`。此前没有任何
   * 东西保证父的 exit 端点对得上 —— 现有用例能通纯属模板作者猜对了字段名
   * （`fanout-merge` 里那个 servo 恰好提 `$.slot`）。
   */
  it("★ exit 端点的 servo 提不到内核形状里的字段 → 注册期就拒", () => {
    const s = new ObjectStore();
    const child = registerContainerTemplate(s, "child", {
      nodes: { w: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
      edges: {},
      children: {},
    });
    const parent = {
      nodes: {
        merge: {
          kind: "handler",
          handler: "noop",
          ports: {
            done: {
              direction: "receive",
              // 内核投的是 {slot, traceid, status}，这里却提 $.result
              servo: { vars: { result: { type: "short", from: "$.result" } } },
            },
          },
        },
      },
      edges: {},
      children: { kids: { template: child, exit: { node: "merge", port: "done" } } },
    };
    expect(() => registerContainerTemplate(s, "parent", parent)).toThrow(
      /children\.kids\.exit.*servo.*路径 \$\.result/s,
    );
  });

  it("exit 端点提得到就通过", () => {
    const s = new ObjectStore();
    const child = registerContainerTemplate(s, "child2", {
      nodes: { w: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
      edges: {},
      children: {},
    });
    expect(() =>
      registerContainerTemplate(s, "parent2", {
        nodes: {
          merge: {
            kind: "handler",
            handler: "noop",
            ports: {
              done: {
                direction: "receive",
                servo: { vars: { slot: { type: "short", from: "$.slot" } } },
              },
            },
          },
        },
        edges: {},
        children: { kids: { template: child, exit: { node: "merge", port: "done" } } },
      }),
    ).not.toThrow();
  });
});
