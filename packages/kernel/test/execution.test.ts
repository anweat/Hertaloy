import { beforeEach, describe, expect, it } from "vitest";
import type {
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
  subscriptions: {},
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
    expect(rt.records()[0]?.status).toBe("APPLIED");
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
    if (isFailure(result)) expect(result.reason).toMatch(/结果作废：实例 generation 0 → 1/);
    expect(rt.records()[0]?.status).toBe("VOIDED");
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
      expect(local.records()[0]?.status).toBe(termination);
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

    const plan = store.resolve("plan@1");
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
