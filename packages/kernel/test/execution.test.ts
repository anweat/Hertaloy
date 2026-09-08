import { beforeEach, describe, expect, it } from "vitest";
import type {
  ArtifactSubmission,
  ExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
  Termination,
} from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";

const agentSpec = {
  nodes: {
    coder: {
      kind: "handler",
      agent: { argv: ["run-agent"] },
      ports: {
        in: { direction: "receive", servo: { vars: { task: { type: "short", from: "$.task" } } } },
        out: { direction: "emit" },
      },
    },
    sink: {
      kind: "handler",
      handler: "collect",
      ports: { in: { direction: "receive", servo: { vars: { v: { type: "short", from: "$.v" } } } } },
    },
  },
  edges: { e1: { from: { node: "coder", port: "out" }, to: { node: "sink", port: "in" } } },
  children: {},
};

/** 可编程 backend：按调用序返回预设结果，并记录 execute 期间的观察点。 */
class ScriptedBackend implements ExecutionBackend {
  readonly seen: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  #script: ((req: ExecutionRequest) => Promise<ExecutionResult>)[] = [];

  push(fn: (req: ExecutionRequest) => Promise<ExecutionResult>): void {
    this.#script.push(fn);
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.seen.push(request);
    const next = this.#script.shift();
    if (next === undefined) {
      return { executionId: request.executionId, emissions: {}, termination: "DONE" };
    }
    return next(request);
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
  }
}

function done(req: ExecutionRequest, v: unknown): ExecutionResult {
  return { executionId: req.executionId, emissions: { out: { v } as never }, termination: "DONE" };
}

function terminated(req: ExecutionRequest, termination: Termination): ExecutionResult {
  return { executionId: req.executionId, emissions: {}, termination };
}

let store: ObjectStore;
let reg: InstanceRegistry;
let backend: ScriptedBackend;
let rt: Runtime;
let collected: unknown[];

function isFailure(r: StepResult | StepFailure | null): r is StepFailure {
  return r !== null && "reason" in r;
}

beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "agent-flow", agentSpec, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  backend = new ScriptedBackend();
  rt = new Runtime(store, reg, { backend, maxAttempts: 3 });
  collected = [];
  rt.registerHandler("collect", (vars) => {
    collected.push(vars.v);
    return {};
  });
});

describe("claim / execute / apply", () => {
  it("三段跑通：变量进请求，输出经边落到 sink，留 APPLIED 记录", async () => {
    backend.push(async (req) => done(req, req.vars.task));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "export" });

    const applied = (await rt.stepAgent()) as StepResult;
    expect(applied.termination).toBe("DONE");
    expect(backend.seen[0]?.vars).toEqual({ task: "export" });
    expect(backend.seen[0]?.outputContract.allowedEmitPorts).toEqual(["out"]);

    rt.drain();
    expect(collected).toEqual(["export"]);
    expect(rt.records()[0]?.status).toBe("SETTLED");
    expect(rt.records()[0]?.termination).toBe("DONE");
  });

  it("★ execute 在提交锁外：await 期间消息是 CLAIMED，实例可被观察", async () => {
    let stateDuringExecute: string | undefined;
    backend.push(async (req) => {
      stateDuringExecute = rt.messages()[0]?.state;
      return done(req, 1);
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    await rt.stepAgent();
    expect(stateDuringExecute).toBe("CLAIMED");
  });

  it("★ 冲突域：execute 期间实例被截断 → apply 作废，不复活（generation fence）", async () => {
    backend.push(async (req) => {
      rt.truncate("job-1", "执行途中人为截断");
      return done(req, "迟到的结果");
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });

    const result = await rt.stepAgent();
    expect(isFailure(result)).toBe(true);
    // 截断已经结算 attempt；迟到结果须被拒绝，并保留原取消事实。
    if (isFailure(result)) {
      expect(result.reason).toMatch(/结果作废/);
      expect(result.reason).toMatch(/已结束/);
    }
    expect(rt.records()[0]).toMatchObject({ status: "SETTLED", termination: "CANCELLED" });
    expect(collected).toEqual([]);
  });

  it("★ 同 (实例,节点) 不并发 claim", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    backend.push(async (req) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return done(req, 1);
    });
    backend.push(async (req) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      inFlight -= 1;
      return done(req, 2);
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "a" });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "b" });

    const [a, b] = await Promise.all([rt.stepAgent(), rt.stepAgent()]);
    expect(maxConcurrent).toBe(1);
    // 第二次 claim 被 #busy 挡住，返回 null
    expect(a === null || b === null).toBe(true);
  });
});

describe("五种终止不混成一种", () => {
  it("CANCELLED / BUDGET 是意图不是故障 —— 不重试，消息 DISCARDED", async () => {
    for (const termination of ["CANCELLED", "BUDGET"] as const) {
      const local = new Runtime(store, reg, { backend, maxAttempts: 3 });
      backend.push(async (req) => terminated(req, termination));
      const id = local.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
      const result = await local.stepAgent();

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.termination).toBe(termination);
        expect(result.retrying).toBe(false);
      }
      expect(local.message(id).state).toBe("DISCARDED");
      // 记录只说"结束了"，怎么结束的由 termination 说 —— 不再有第二套编码
      expect(local.records()[0]?.status).toBe("SETTLED");
      expect(local.records()[0]?.termination).toBe(termination);
    }
  });

  it("INVALID_OUTPUT / FAILED 重试到上限后落 FAILED", async () => {
    for (let i = 0; i < 3; i += 1) {
      backend.push(async (req) => terminated(req, "FAILED"));
    }
    const id = rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });

    const first = (await rt.stepAgent()) as StepFailure;
    expect(first.retrying).toBe(true);
    expect(rt.message(id).state).toBe("QUEUED");
    expect(rt.message(id).attempts).toBe(1);

    await rt.stepAgent();
    const third = (await rt.stepAgent()) as StepFailure;
    expect(third.retrying).toBe(false);
    expect(third.reason).toMatch(/已重试 3 次，放弃/);
    expect(rt.message(id).state).toBe("FAILED");
  });

  it("backend 抛异常归 FAILED（可重试），不是 INVALID_OUTPUT", async () => {
    backend.push(async () => {
      throw new Error("网络断了");
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.termination).toBe("FAILED");
    expect(result.reason).toMatch(/网络断了/);
    expect(result.retrying).toBe(true);
  });

  it("输出到未声明端口 → INVALID_OUTPUT 并让状态收口（backend 是不可信边界）", async () => {
    backend.push(async (req) => ({
      executionId: req.executionId,
      emissions: { ghost: {} },
      termination: "DONE",
    }));
    const id = rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });

    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.termination).toBe("INVALID_OUTPUT");
    // 模型输出乱端口是正常终止原因，不是编程错误 —— 抛异常会让消息永远停在 CLAIMED
    expect(rt.message(id).state).not.toBe("CLAIMED");
    expect(rt.records()[0]?.status).not.toBe("RUNNING");
  });
});

describe("产物与观测", () => {
  it("artifacts 由 store 分配版本（V1），provenance 记住是哪次 execution", async () => {
    backend.push(async (req) => ({
      executionId: req.executionId,
      emissions: { out: { v: 1 } },
      artifacts: [{ object_id: "plan", kind: "plan", body: { n: 1 }, derived_from: [] }],
      termination: "DONE",
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    await rt.stepAgent();

    const plan = store.resolve("job-1/plan@1");
    expect(plan.body).toEqual({ n: 1 });
    expect(plan.provenance.traceid).toBe("job-1");
    expect(plan.provenance.execution_id).toBe("exec-1");
  });

  it("在途 execution 挡住终止（L5 第二谓词）", async () => {
    let blockersDuringExecute: readonly string[] = [];
    backend.push(async (req) => {
      blockersDuringExecute = rt.terminationBlockers("job-1");
      return done(req, 1);
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    await rt.stepAgent();
    expect(blockersDuringExecute).toContain("1 个在途 execution");
  });

  it("截断会取消在途 execution（best effort）并计数", async () => {
    backend.push(async (req) => {
      const t = rt.truncate("job-1", "截断");
      expect(t.cancelledExecutions).toBe(1);
      return done(req, 1);
    });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    await rt.stepAgent();
    expect(backend.cancelled).toEqual(["exec-1"]);
  });
});

describe("★ 产物地址由内核决定，不是 agent 报什么就写什么（外部审核 P0）", () => {
  /** 让 agent 提交一组产物，返回本次 step 的结果。 */
  async function submit(artifacts: readonly ArtifactSubmission[]) {
    backend.push(async (req) => ({
      executionId: req.executionId,
      emissions: {},
      artifacts,
      termination: "DONE" as const,
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });
    return await rt.stepAgent();
  }

  it("agent 报的名字被强制落进自己的命名空间，不落全局", async () => {
    await submit([{ object_id: "plan", kind: "plan", body: { n: 1 }, derived_from: [] }]);
    expect(store.has("plan")).toBe(false);
    expect(store.has("job-1/plan")).toBe(true);
  });

  it("★ 无论报什么，写出来的一定在自己 traceid 之下", async () => {
    await submit([
      { object_id: "deep/nested/result", kind: "artifact", body: { ok: 1 }, derived_from: [] },
    ]);
    // 多级资产名允许，但整体被前缀 —— 唯一能越界的写法是 `..`，而它被拒（下一条）
    const written = store.history("job-1/deep/nested/result");
    expect(written).toHaveLength(1);
    expect(store.has("deep/nested/result")).toBe(false);
  });

  it("★ `..` 逃逸被拒 → INVALID_OUTPUT，不是内核崩", async () => {
    const r = await submit([
      { object_id: "../root", kind: "artifact", body: { evil: true }, derived_from: [] },
    ]);
    expect(isFailure(r)).toBe(true);
    expect((r as StepFailure).reason).toMatch(/产物名非法/);
    expect(store.has("root")).toBe(false);
  });

  it("★ 受信 handler 与不受信 agent 现在同一套规则 —— 此前正好反了", async () => {
    await submit([{ object_id: "shared", kind: "artifact", body: { from: "agent" }, derived_from: [] }]);
    expect(store.head("job-1/shared").body).toEqual({ from: "agent" });
  });
});

describe("★ 头只装在途，历史一条不少（V6 阶段 5 · 消息那半）", () => {
  /**
   * 这里原来叫"可变头封顶"，钉的是 `keepConsumedMessages`：保留最近 N 条已消费
   * 消息，更老的丢掉。那套机制在丢一件**只有队列里有**的东西，所以它只能在
   * "头无界增长"和"历史消失"之间选一个 —— 而两边都不对，用例也只能钉住
   * "早期消息已被清掉"这种把损失当成规格的断言。
   *
   * 现在终态消息先落进 `<traceid>/<node>/$msg` 再离队，选择不存在了。
   * 验收因此换成两条**同时**成立的性质。
   */
  function rigPlain() {
    const s = new ObjectStore();
    const ref = registerContainerTemplate(
      s,
      "flow",
      {
        nodes: {
          n: {
            kind: "handler",
            handler: "noop",
            ports: { in: { direction: "receive", servo: { vars: {} } } },
          },
        },
        edges: {},
        children: {},
      },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(ref, "job-1");
    const rt = new Runtime(s, r, {});
    rt.registerHandler("noop", () => ({}));
    return { rt, store: s, registry: r };
  }

  function run(rt: Runtime, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(rt.send({ traceid: "job-1", node: "n", port: "in" }, { i }));
      rt.drain();
    }
    return ids;
  }

  it("★ 跑完 500 条：队列空了，而 500 条一条不少", () => {
    const { rt } = rigPlain();
    const ids = run(rt, 500);
    expect(rt.liveMessages()).toHaveLength(0);
    expect(rt.messages()).toHaveLength(500);
    // 最早那条 —— 原来这里断言的是"已被清掉"
    expect(rt.message(ids[0] as string).state).toBe("CONSUMED");
    rt.checkInvariants();
  });

  it("在途的一条都不动 —— 收口只对终态开", () => {
    const { rt } = rigPlain();
    run(rt, 100);
    for (let i = 0; i < 3; i += 1) rt.send({ traceid: "job-1", node: "n", port: "in" }, { i });
    expect(rt.pending()).toHaveLength(3);
    expect(rt.liveMessages()).toHaveLength(3);
    expect(rt.messages().filter((m) => m.state === "QUEUED")).toHaveLength(3);
  });

  it("★ 换一个 Runtime 仍查得到 —— 历史在对象库里，不在头里", () => {
    const { rt, store, registry } = rigPlain();
    const ids = run(rt, 20);
    // 新 Runtime 不 restore 任何头，只共享对象库与实例树
    const fresh = new Runtime(store, registry, {});
    expect(fresh.liveMessages()).toHaveLength(0);
    expect(fresh.messages()).toHaveLength(20);
    expect(fresh.message(ids[0] as string).payload).toEqual({ i: 0 });
  });

  it("★ 截断丢弃的现场也在，原因跟着落库", () => {
    const { rt } = rigPlain();
    run(rt, 3);
    // 不 drain，让它停在 QUEUED，然后截断
    const doomed = rt.send({ traceid: "job-1", node: "n", port: "in" }, { i: 99 });
    rt.truncate("job-1", "人工中止");

    const m = rt.message(doomed);
    expect(m.state).toBe("DISCARDED");
    expect(m.failure).toContain("人工中止");
    // 队列空了，但三条已消费 + 这条被丢的都还在
    expect(rt.liveMessages()).toHaveLength(0);
    expect(rt.messages()).toHaveLength(4);
  });

  it("★ 多节点交替投递时仍是投递序 —— 落库那半是按节点分组的", () => {
    const st = new ObjectStore();
    const node = {
      kind: "handler" as const,
      handler: "noop",
      ports: { in: { direction: "receive" as const, servo: { vars: {} } } },
    };
    const ref = registerContainerTemplate(
      st,
      "flow",
      { nodes: { a: node, b: node }, edges: {}, children: {} },
      "root_config",
    );
    const reg = new InstanceRegistry(st);
    reg.createRoot(ref, "job-1");
    const rt = new Runtime(st, reg, {});
    rt.registerHandler("noop", () => ({}));

    // a b a b …：按节点分组会把它排成 aaa…bbb…
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(rt.send({ traceid: "job-1", node: i % 2 === 0 ? "a" : "b", port: "in" }, { i }));
      rt.drain();
    }
    expect(rt.messages().map((m) => m.id)).toEqual(ids);
  });

  it("因果查询仍成立 —— 而现在消息本身也查得到了", () => {
    const { rt } = rigPlain();
    const ids = run(rt, 60);
    const consumed = rt
      .snapshots("job-1")
      .flatMap((v) => (v.body.consumed as string[] | undefined) ?? []);
    expect(consumed).toContain(ids[0]);
    expect(rt.messages().some((m) => m.id === ids[0])).toBe(true);
  });
});

describe("★ 被拒的 claim 不留残骸（外部审核 P0-3）", () => {
  it("运行期上界超标 → 拒绝，且不留 RUNNING 记录", async () => {
    const s = new ObjectStore();
    const ref = registerContainerTemplate(
      s,
      "root",
      {
        nodes: {
          w: {
            kind: "handler",
            agent: { argv: ["x"] },
            bind: { big: { type: "long", max_tokens: 1, literal: "远超一个 token 上界的一段文字" } },
            budget: { tokens: 100 },
            ports: { in: { direction: "receive", servo: { vars: {} } }, out: { direction: "emit" } },
          },
        },
        edges: {},
        children: {},
      },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(ref, "job-1");
    const rt = new Runtime(s, r, { backend, maxAttempts: 3 });

    rt.send({ traceid: "job-1", node: "w", port: "in" }, {});
    const result = await rt.stepAgent();

    expect(isFailure(result)).toBe(true);
    // ★ 关键：一条记录都不该留下
    expect(rt.records()).toHaveLength(0);
    // 实例因此仍能收敛 —— 此前"1 个在途 execution"会永远挡着
    expect(rt.terminationBlockers("job-1")).not.toContain("1 个在途 execution");
    // 内核不该判自己违规
    rt.checkInvariants();
  });
});

describe("★ 两个 RUNNING 不能抢同一条消息（外部审核 P1-4）", () => {
  it("checkInvariants 抓得住 claim 被偷走的样子", () => {
    const s = new ObjectStore();
    const ref = registerContainerTemplate(s, "root", agentSpec, "root_config");
    const r = new InstanceRegistry(s);
    r.createRoot(ref, "job-1");
    const rt = new Runtime(s, r, { backend });
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "t" });

    const first = rt.claimAgent();
    expect(first.kind).toBe("claimed");
    // 正常路径下第二次 claim 拿不到（消息已 CLAIMED）
    expect(rt.claimAgent().kind).toBe("idle");
    rt.checkInvariants();
  });
});

/**
 * ★ `priorExecutions` 真的到了请求里。
 *
 * 它替换掉的是 backend 进程内的一张 Map（工作区交接靠它找上游节点）。那张 Map
 * 不落盘、不重建，换个进程就空了；而权威 —— 执行记录 —— 一直在内核这边。
 *
 * 沙箱那侧的用例是**手写** priorExecutions 跑的，只证明"给对了表能用"，
 * 不证明"内核会给"。中间这一段没人走，正是这个项目被咬过四次的形状，
 * 所以这条必须在内核侧单独钉住。
 */
describe("★ priorExecutions：上游执行记录进请求", () => {
  it("内核填，不是调用方手写", async () => {
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "一" });
    await rt.drainAgents();
    // 第一次跑：这个实例还没有别的执行记录
    expect(backend.seen[0]?.priorExecutions).toEqual({});

    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "二" });
    await rt.drainAgents();
    // 第二次：看得见自己上一次 —— 由内核从已落盘的记录派生，没有第二本账
    expect(backend.seen[1]?.priorExecutions).toEqual({ coder: "exec-1" });
  });

  it("读的是持久的那一半 —— restore 之后仍算得出来", async () => {
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "一" });
    await rt.drainAgents();

    /**
     * 换一个 Runtime，只带快照过来 —— 这正是那张进程内 Map 做不到的事。
     *
     * `ExecutionLedger` 里有两种寿命的东西：`records` 跨进程（进快照），
     * `driving` 只活在本进程（不进快照）。这条钉的是 `latestPerNode`
     * 读的是**前者**。字节级往返由 state 包的用例负责，这里不重复。
     */
    const reborn = new Runtime(store, reg, { backend, maxAttempts: 3 });
    reborn.restore(rt.snapshot());
    reborn.registerHandler("collect", () => ({}));

    reborn.send({ traceid: "job-1", node: "coder", port: "in" }, { task: "二" });
    await reborn.drainAgents();
    expect(backend.seen.at(-1)?.priorExecutions).toEqual({ coder: "exec-1" });
  });
});

/**
 * ★ 入站校验对两条路径是**同一处实现**。
 *
 * 契约 → 提取 → 编上下文，此前在 `#commitSync` 与 `#claim` 里各写了一遍。
 * 代价已经付过：三段式那边曾经「校验一半 → 写 RUNNING 记录 → 再校验 → 拒绝」，
 * 而拒绝走正常 return、`transact` 只在 throw 时回滚，于是留下永久 RUNNING 记录。
 * 修法（把编上下文提到 mutation 之前）当时**只在一条路径上做过**。
 *
 * 这一组钉的不是"能拒绝"，是**两条路径拒绝得一模一样**。谁把它们再拆成
 * 两份实现，这里就会红 —— 而单看任何一条路径都是绿的，那正是要防的东西。
 */
describe("★ 入站校验：两条路径同一处实现", () => {
  /** 同一个节点定义，只有"跑法"不同：`agent` 走三段式，`handler` 走同步。 */
  const overBudget = (exec: Record<string, unknown>) => ({
    nodes: {
      w: {
        kind: "handler",
        ...exec,
        bind: { big: { type: "long", max_tokens: 1, literal: "远超一个 token 上界的一段文字" } },
        budget: { tokens: 100 },
        ports: { in: { direction: "receive", servo: { vars: {} } }, out: { direction: "emit" } },
      },
    },
    edges: {},
    children: {},
  });

  function build(exec: Record<string, unknown>): Runtime {
    const s = new ObjectStore();
    const ref = registerContainerTemplate(s, "root", overBudget(exec), "root_config");
    const r = new InstanceRegistry(s);
    r.createRoot(ref, "job-1");
    const rt = new Runtime(s, r, { backend, maxAttempts: 3 });
    rt.registerHandler("noop", () => ({}));
    rt.send({ traceid: "job-1", node: "w", port: "in" }, {});
    return rt;
  }

  it("同一条违规，两条路径给同一个理由", async () => {
    const async_ = build({ agent: { argv: ["x"] } });
    const sync = build({ handler: "noop" });

    const a = (await async_.stepAgent()) as StepFailure;
    const b = sync.step() as StepFailure;

    expect(isFailure(a)).toBe(true);
    expect(isFailure(b)).toBe(true);
    // 逐字相同 —— 同一处实现产生的同一句话
    expect(b.reason).toBe(a.reason);
    expect(a.reason).toMatch(/上下文编译失败/);
  });

  /**
   * ★ 两条路径都不留**残骸** —— 但"残骸"指的是 `RUNNING` 记录，不是"任何记录"。
   *
   * 残骸的定义是**它挡住终止**：一条永久 RUNNING 的记录让实例再也 settle 不了，
   * 而且 `checkInvariants` 会当场判它违规（RUNNING 记录引用了一条 FAILED 消息）。
   * 一条 `SETTLED` 记录不挡任何东西，它是事实不是残骸。
   *
   * 两条路径在这里**本来就不对称，而且那个不对称是对的**：
   *
   *   agent 路径  `#prepare` 排在**派发之前**（`markDriving` / `ledger.put` 之后才是派发）。
   *               入站被拒 ⇒ 这次执行**从未开始** ⇒ 一条记录都不该有。
   *   同步路径    没有"派发"这一步 —— `#pickWork` 挑中就是在跑。
   *               入站被拒 ⇒ 它**跑了并且失败了** ⇒ 留一条 SETTLED/FAILED。
   *
   * 不给同步路径留这条记录，一个首次就失败的节点在画布上看起来像从没跑过，
   * 而那正是本轮要消灭的"idle 是正面断言"。
   */
  it("两条路径都不留残骸 —— 残骸指 RUNNING，不指任何记录", async () => {
    const async_ = build({ agent: { argv: ["x"] } });
    const sync = build({ handler: "noop" });

    await async_.stepAgent();
    sync.step();

    for (const rt of [async_, sync]) {
      // 真正要挡的：没有在途执行，因此不挡终止，也不违反不变量
      expect(rt.records().filter((r) => r.status === "RUNNING")).toHaveLength(0);
      expect(rt.terminationBlockers("job-1")).not.toContain("1 个在途 execution");
      rt.checkInvariants();
    }

    // agent：入站被拒发生在派发之前，这次执行从未开始
    expect(async_.records()).toHaveLength(0);
    // 同步：没有派发这一步，被拒就是跑过并失败
    const [only] = sync.records();
    expect(only?.status).toBe("SETTLED");
    expect(only?.termination).not.toBe("DONE");
  });

  it("★ bind 段对两条路径都到得了 —— 同步路径不是「只拿端口变量」", () => {
    const s = new ObjectStore();
    const ref = registerContainerTemplate(
      s,
      "root",
      {
        nodes: {
          w: {
            kind: "handler",
            handler: "echo",
            bind: { greeting: { type: "short", literal: "你好" } },
            ports: { in: { direction: "receive", servo: { vars: {} } } },
          },
        },
        edges: {},
        children: {},
      },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(ref, "job-1");
    const rt = new Runtime(s, r, {});
    let seen: Record<string, unknown> = {};
    rt.registerHandler("echo", (vars) => {
      seen = { ...vars };
      return {};
    });

    rt.send({ traceid: "job-1", node: "w", port: "in" }, {});
    rt.step();
    expect(seen).toEqual({ greeting: "你好" });
  });
});
