/**
 * 外部审核 7 条 P1 的反例测试。
 *
 * 每条都先证明"修之前会怎样错"，再断言修之后的正确行为。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { scopeAccepts } from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";
import { stageOutputs } from "../src/routing.js";

const agentSpec = {
  nodes: {
    coder: {
      kind: "handler",
      agent: { model: "fake" },
      ports: {
        in: { direction: "receive", servo: { vars: { t: { type: "short", from: "$.t" } } } },
        out: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

class OneShot implements ExecutionBackend {
  constructor(private readonly fn: (req: ExecutionRequest) => unknown) {}
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.fn(request) as ExecutionResult;
  }
  async cancel(): Promise<void> {}
}

function isFailure(r: StepResult | StepFailure | null | undefined): r is StepFailure {
  return r !== null && r !== undefined && "reason" in r;
}

let store: ObjectStore;
let reg: InstanceRegistry;

beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "agent-flow", agentSpec, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
});

function runtimeWith(fn: (req: ExecutionRequest) => unknown): Runtime {
  return new Runtime(store, reg, { backend: new OneShot(fn), maxAttempts: 1 });
}

describe("P1-1 非法 agent 输出必须让状态收口，不能悬挂", () => {
  it("端口越界 → INVALID_OUTPUT，消息离开 CLAIMED、记录离开 RUNNING、终止谓词可满足", async () => {
    const rt = runtimeWith((req) => ({
      executionId: req.executionId,
      emissions: { ghost: {} },
      termination: "DONE",
    }));
    const id = rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 1 });

    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.termination).toBe("INVALID_OUTPUT");
    expect(result.reason).toMatch(/未声明的 emit 端口 `ghost`/);

    // ★ 关键断言：状态真的收口了
    expect(rt.message(id).state).not.toBe("CLAIMED");
    expect(rt.records()[0]?.status).not.toBe("RUNNING");
    expect(rt.terminationBlockers("job-1")).toEqual([]);
    expect(rt.canTerminate("job-1")).toBe(true);
  });
});

describe("P1-2 ObjectVersion 必须真不可变", () => {
  it("入库后改原对象不影响已存版本（深克隆）", () => {
    const body = { tasks: [{ id: "t1" }] } as Record<string, unknown>;
    const version = store.put("plan", "plan", body as never);
    (body.tasks as { id: string }[])[0]!.id = "篡改";
    expect((store.resolve("plan@1").body as never as { tasks: { id: string }[] }).tasks[0]?.id).toBe(
      "t1",
    );
    expect(version.content_hash).toBe(store.resolve("plan@1").content_hash);
  });

  it("读出来的嵌套字段被深冻结，写不进去", () => {
    store.put("plan", "plan", { tasks: [{ id: "t1" }] });
    const read = store.resolve("plan@1").body as never as { tasks: { id: string }[] };
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.tasks)).toBe(true);
    expect(Object.isFrozen(read.tasks[0])).toBe(true);
  });

  it("content_hash 是全量 sha256，不截断", () => {
    expect(store.put("x", "x", { a: 1 }).content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("P1-3 backend 是不可信边界，必须运行时校验", () => {
  it("executionId 串号被拒", async () => {
    const rt = runtimeWith(() => ({
      executionId: "exec-999",
      emissions: {},
      termination: "DONE",
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 1 });
    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.termination).toBe("INVALID_OUTPUT");
    expect(result.reason).toMatch(/executionId 不匹配/);
  });

  it("非法 termination 值被拒", async () => {
    const rt = runtimeWith((req) => ({
      executionId: req.executionId,
      emissions: {},
      termination: "WHATEVER",
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 1 });
    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.reason).toMatch(/形状非法/);
  });

  it("★ backend 不得伪造内核保留 kind，且失败时零部分写入", async () => {
    const rt = runtimeWith((req) => ({
      executionId: req.executionId,
      emissions: { out: {} },
      artifacts: [
        { object_id: "ok", kind: "plan", body: { n: 1 }, derived_from: [] },
        { object_id: "evil", kind: "run", body: {}, derived_from: [] },
      ],
      termination: "DONE",
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 1 });
    const result = (await rt.stepAgent()) as StepFailure;

    expect(result.reason).toMatch(/不得提交内核保留 kind `run`/);
    // 合法的那个也没写进去 —— 全部校验通过才提交
    expect(store.has("ok")).toBe(false);
    expect(store.has("evil")).toBe(false);
  });
});

describe("P1-4 REQUEST 锁必须记 waitingOn，否则服务方死亡时请求方永等", () => {
  const askerSpec = {
    nodes: {
      w: {
        kind: "handler",
        handler: "ask",
        ports: {
          start: { direction: "receive", servo: { vars: { q: { type: "short", from: "$.q" } } } },
          ask: { direction: "emit", tunnel: "t.disc", callback: "got" },
          got: { direction: "receive" },
        },
      },
    },
    edges: {},
    children: {},
    subscriptions: {},
  };
  const svcSpec = {
    nodes: { s: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
    edges: {},
    children: {},
    subscriptions: { s1: { tunnel: "t.disc", to: { node: "s", port: "in" } } },
  };

  it("★ 截断服务方后，请求方的 request 锁被反向清账", () => {
    const s = new ObjectStore();
    const a = registerContainerTemplate(s, "asker", askerSpec);
    const v = registerContainerTemplate(s, "svc", svcSpec);
    const root = registerContainerTemplate(
      s,
      "root",
      { nodes: {}, edges: {}, children: { a: { template: a }, v: { template: v } }, subscriptions: {} },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(root, "job-1");
    const rt = new Runtime(s, r);
    rt.registerHandler("ask", (vars) => ({ ask: { q: vars.q ?? null } }));
    rt.registerHandler("noop", () => ({}));
    rt.spawn("job-1", "a", "caller");
    rt.spawn("job-1", "v", "server");

    rt.send({ traceid: "job-1/caller", node: "w", port: "start" }, { q: "x" });
    rt.step();

    const lock = rt.locks.held("job-1/caller").find((l) => l.kind === "request");
    expect(lock?.waitingOn).toBe("job-1/server");

    rt.truncate("job-1/server", "服务方挂了");
    expect(rt.locks.held("job-1/caller").filter((l) => l.kind === "request")).toEqual([]);
  });
});

describe("P1-5 自然终止必须存在，并释放父的 child 锁", () => {
  it("★ 子容器做完 → settle → 父的 child 锁销账 → 父也能自然终止", () => {
    const s = new ObjectStore();
    const leaf = registerContainerTemplate(s, "leaf", {
      nodes: { n: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
      edges: {},
      children: {},
      subscriptions: {},
    });
    const root = registerContainerTemplate(
      s,
      "root",
      { nodes: {}, edges: {}, children: { k: { template: leaf } }, subscriptions: {} },
      "root_config",
    );
    const r = new InstanceRegistry(s);
    r.createRoot(root, "job-1");
    const rt = new Runtime(s, r);
    rt.registerHandler("noop", () => ({}));

    rt.spawn("job-1", "k", "child-1");
    expect(rt.canTerminate("job-1")).toBe(false);
    expect(rt.terminationBlockers("job-1")).toEqual(["锁 child · 等 job-1/child-1"]);

    // 子做完活
    rt.send({ traceid: "job-1/child-1", node: "n", port: "in" }, {});
    rt.drain();

    const settled = rt.settleAll();
    expect(settled).toEqual(["job-1/child-1", "job-1"]);
    expect(r.get("job-1/child-1").status).toBe("TERMINAL");
    expect(r.get("job-1").status).toBe("TERMINAL");
  });

  it("还有活没干完时 settle 不生效", () => {
    const rt = new Runtime(store, reg);
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 1 });
    expect(rt.settle("job-1")).toBe(false);
    expect(reg.get("job-1").status).toBe("OPEN");
  });
});

describe("P1-6 重复回复必须真的被拒（不是靠改名蒙混）", () => {
  it("同一 requestId 第二次回复时 lookupRequest 已空 → 明确拒绝", () => {
    const node = {
      kind: "handler" as const,
      handler: "x",
      ports: { in: { direction: "receive" as const }, answer: { direction: "emit" as const, reply: true as const } },
    };
    const outcome = stageOutputs(
      {
        template: { nodes: { n: node }, edges: {}, children: {}, subscriptions: {} },
        node,
        traceid: "job-1",
        nodeId: "n",
        generation: 0,
        inboundMessageId: "msg-1",
        inboundRequestId: "req-1",
        subscribers: () => [],
        lookupRequest: () => undefined, // ← 已被首次回复销账
        nextRequestId: () => "req-2",
      },
      { answer: { a: 1 } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/已回复或已作废，拒绝重复回复/);
  });
});

describe("P1-7 订阅作用域必须支持相对形式", () => {
  it("scopeAccepts 的四种形态", () => {
    expect(scopeAccepts(undefined, "job-1/w", "任意")).toBe(true);
    expect(scopeAccepts("$self", "job-1/w", "job-1/w")).toBe(true);
    expect(scopeAccepts("$self", "job-1/w", "job-1/w/t")).toBe(false);
    expect(scopeAccepts("$self_subtree", "job-1/w", "job-1/w/t")).toBe(true);
    expect(scopeAccepts("$self_subtree", "job-1/w", "job-1/other")).toBe(false);
    expect(scopeAccepts("job-2", "job-1/w", "job-2/x")).toBe(true);
    // 段边界：job-1 不该捞到 job-10
    expect(scopeAccepts("$self_subtree", "job-1", "job-10/x")).toBe(false);
  });
});

describe("后续清单：#claim 失败不得被当成空闲", () => {
  it("入口校验失败返回 StepFailure，drainAgents 不提前退出", async () => {
    const rt = runtimeWith((req) => ({
      executionId: req.executionId,
      emissions: { out: { ok: true } },
      termination: "DONE",
    }));
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { wrong: 1 }); // 提取失败
    rt.send({ traceid: "job-1", node: "coder", port: "in" }, { t: 2 }); // 合法

    const results = await rt.drainAgents();
    expect(results).toHaveLength(2);
    expect(isFailure(results[0])).toBe(true);
    expect(isFailure(results[1])).toBe(false);
  });
});
