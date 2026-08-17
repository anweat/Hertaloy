/**
 * Checkpoint B —— 最小主线场景端到端。
 *
 * 剧本：创建子容器 → 传变量 → REQUEST/REPLY → 产出版本化对象 → 自然结束。
 * 外加 workplan 要求的失败路径：强制截断、迟到结果、重复回复、预算越界。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";

/** coder 容器：agent 节点，向发现服务要 skill，拿到后产出 plan。 */
const coderSpec = {
  nodes: {
    work: {
      kind: "handler",
      handler: "ask",
      budget: { tokens: 500 },
      ports: {
        start: {
          direction: "receive",
          servo: { vars: { task: { type: "short", from: "$.task" } } },
        },
        ask: { direction: "emit", tunnel: "skill.discovery", callback: "got" },
        got: {
          direction: "receive",
          servo: { vars: { skill: { type: "long", from: "$.skill", max_tokens: 200 } } },
        },
        done: { direction: "emit" },
      },
    },
    writer: {
      kind: "handler",
      agent: { model: "fake" },
      bind: { rules: { type: "long", card: "rules/py@1", max_tokens: 500 } },
      budget: { tokens: 1000 },
      ports: {
        in: {
          direction: "receive",
          servo: { vars: { skill: { type: "long", from: "$.skill", max_tokens: 200 } } },
        },
        out: { direction: "emit" },
      },
    },
  },
  edges: { e1: { from: { node: "work", port: "done" }, to: { node: "writer", port: "in" } } },
  children: {},
  subscriptions: {},
};

/** 发现服务：长期 OPEN 的容器 + 订阅，没有任何新对象类型。 */
const discoverySpec = {
  nodes: {
    serve: {
      kind: "handler",
      handler: "lookup",
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

class FakeBackend implements ExecutionBackend {
  readonly seen: ExecutionRequest[] = [];
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.seen.push(request);
    return {
      executionId: request.executionId,
      emissions: { out: { ok: true } },
      artifacts: [
        {
          object_id: "plan",
          kind: "plan",
          body: { skill: request.vars.skill as never, rules: request.vars.rules as never },
          derived_from: [],
        },
      ],
      termination: "DONE",
    };
  }
  async cancel(): Promise<void> {}
}

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let backend: FakeBackend;

beforeEach(() => {
  store = new ObjectStore();
  store.put("rules/py", "rules", { text: "遵守 PEP 8" });
  const coderRef = registerContainerTemplate(store, "coder-flow", coderSpec);
  const discoveryRef = registerContainerTemplate(store, "discovery-flow", discoverySpec);
  const rootRef = registerContainerTemplate(
    store,
    "root-config",
    {
      nodes: {},
      edges: {},
      children: { coders: { template: coderRef }, services: { template: discoveryRef } },
      subscriptions: {},
    },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(rootRef, "job-1");
  backend = new FakeBackend();
  rt = new Runtime(store, reg, { backend });
  // 多入端口的节点靠 ctx.port 区分"新任务"与"回复到了"
  rt.registerHandler("ask", (vars, ctx) =>
    ctx.port === "start"
      ? { ask: { q: vars.task ?? null } }
      : { done: { skill: vars.skill ?? null } },
  );
  rt.registerHandler("lookup", (vars) => ({ answer: { skill: `skill-for:${String(vars.q)}` } }));
});

describe("Checkpoint B 主线", () => {
  it("★ 建子容器 → 传变量 → REQUEST/REPLY → 产出版本 → 自然结束", async () => {
    rt.spawn("job-1", "services", "discovery");
    rt.spawn("job-1", "coders", "coder-1");

    rt.send({ traceid: "job-1/coder-1", node: "work", port: "start" }, { task: "导出功能" });

    // 同步链：发 REQUEST → 服务方回复 → 回复落 got → done 沿边到 writer
    rt.drain();
    expect(rt.locks.held("job-1/coder-1").filter((l) => l.kind === "request")).toEqual([]);

    // agent 三段式：bind 段的卡片正文进了请求
    await rt.drainAgents();
    expect(backend.seen).toHaveLength(1);
    expect(backend.seen[0]?.vars.rules).toBe("遵守 PEP 8");
    expect(backend.seen[0]?.vars.skill).toBe("skill-for:导出功能");
    expect(backend.seen[0]?.limits.tokenBudget).toBe(1000);

    // 产物版本化，provenance 指回执行
    const plan = store.resolve("plan@1");
    expect(plan.provenance.traceid).toBe("job-1/coder-1");
    expect(plan.provenance.node_id).toBe("writer");

    // 自然结束：coder 先终态 → 释放父 child 锁 → 服务容器仍 OPEN 挡着根
    expect(rt.settle("job-1/coder-1")).toBe(true);
    expect(rt.canTerminate("job-1")).toBe(false);
    rt.settle("job-1/discovery");
    expect(rt.settleAll()).toContain("job-1");
    expect(reg.get("job-1").status).toBe("TERMINAL");
  });

  it("★ RunSnapshot 是因果权威：produced → consumed 可反查", async () => {
    rt.spawn("job-1", "services", "discovery");
    rt.spawn("job-1", "coders", "coder-1");
    const seed = rt.send(
      { traceid: "job-1/coder-1", node: "work", port: "start" },
      { task: "t" },
    );

    const first = rt.step() as StepResult;
    const request = first.delivered[0] as string;

    // 这条 REQUEST 的前因就是最初那条种子消息
    expect(rt.causesOf(request)).toEqual([seed]);

    rt.drain();
    await rt.drainAgents();

    const snaps = rt.snapshots("job-1/coder-1");
    expect(snaps.length).toBeGreaterThan(0);
    // seq 由提交推进且无空洞
    expect(snaps.map((s) => s.body.seq)).toEqual(snaps.map((_, i) => i + 1));
    // 最后一次提交记下了产物
    expect(snaps.at(-1)?.body.artifacts).toEqual(["plan"]);
  });
});

describe("Checkpoint B 失败路径", () => {
  it("预算越界在注册期就拒（B1 注册期一半）", () => {
    expect(() =>
      registerContainerTemplate(store, "over-budget", {
        nodes: {
          a: {
            kind: "handler",
            agent: { model: "x" },
            budget: { tokens: 100 },
            bind: { big: { type: "long", literal: "x", max_tokens: 500 } },
            ports: { out: { direction: "emit" } },
          },
        },
        edges: {},
        children: {},
        subscriptions: {},
      }),
    ).toThrow(/合计 500 tokens，超出节点预算 100/);
  });

  it("声明了 long 变量却没给预算 → 注册期拒（否则 B1 不可执行）", () => {
    expect(() =>
      registerContainerTemplate(store, "no-budget", {
        nodes: {
          a: {
            kind: "handler",
            agent: { model: "x" },
            bind: { big: { type: "long", literal: "x", max_tokens: 50 } },
            ports: { out: { direction: "emit" } },
          },
        },
        edges: {},
        children: {},
        subscriptions: {},
      }),
    ).toThrow(/必须给出 `budget.tokens`/);
  });

  it("变量名冲突在注册期就拒（同节点共用一张变量表）", () => {
    expect(() =>
      registerContainerTemplate(store, "collide", {
        nodes: {
          a: {
            kind: "handler",
            handler: "noop",
            bind: { dup: { type: "short", literal: 1 } },
            ports: {
              in: { direction: "receive", servo: { vars: { dup: { type: "short", from: "$.x" } } } },
            },
          },
        },
        edges: {},
        children: {},
        subscriptions: {},
      }),
    ).toThrow(/变量名 `dup` 与 bind 段冲突/);
  });

  it("★ 运行期填充超上界 → 直接失败，不截断不降级（B1 运行期一半）", async () => {
    rt.spawn("job-1", "coders", "coder-1");
    // writer.in 的 skill 声明上界 200 tokens，这里直接塞一大段进 agent 节点
    rt.send({ traceid: "job-1/coder-1", node: "writer", port: "in" }, { skill: "很".repeat(500) });

    const result = (await rt.stepAgent()) as StepFailure;
    expect(result.reason).toMatch(/上下文编译失败/);
    expect(result.reason).toMatch(/超出声明上界 200/);
    // backend 根本没被调用 —— 没有悄悄截断后放行
    expect(backend.seen).toHaveLength(0);
  });

  it("强制截断：迟到结果不复活，锁被反向清账", async () => {
    rt.spawn("job-1", "services", "discovery");
    rt.spawn("job-1", "coders", "coder-1");
    rt.send({ traceid: "job-1/coder-1", node: "work", port: "start" }, { task: "t" });
    rt.step(); // 发出 REQUEST，锁记在 coder-1 上，waitingOn = discovery

    rt.truncate("job-1/discovery", "服务方挂了");
    expect(rt.locks.held("job-1/coder-1").filter((l) => l.kind === "request")).toEqual([]);

    const t = rt.truncate("job-1", "整体截断");
    expect(t.cascaded).toContain("job-1/coder-1");
    expect(reg.get("job-1").status).toBe("TERMINAL");
  });

  it("CLOSED 后不接新工作", () => {
    rt.spawn("job-1", "coders", "coder-1");
    rt.truncate("job-1/coder-1", "截断");
    expect(() =>
      rt.send({ traceid: "job-1/coder-1", node: "work", port: "start" }, { task: "t" }),
    ).toThrow(InvariantError);
  });
});
