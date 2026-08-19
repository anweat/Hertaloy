/**
 * 第三轮外部审核的实证缺陷 —— 每条都先复现再修，这里把它们钉住。
 *
 * 共同特征仍是**文档宣称的与代码强制的对不上**（§20 第三条那把尺子），
 * 而不是设计本身错。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

let store: ObjectStore;
beforeEach(() => {
  store = new ObjectStore();
});

function boot(spec: unknown, backend?: ExecutionBackend): Runtime {
  const ref = registerContainerTemplate(store, "root", spec, "root_config");
  const reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  return new Runtime(store, reg, backend === undefined ? {} : { backend, maxAttempts: 1 });
}

const AGENT_FLOW = {
  nodes: {
    n: {
      kind: "handler",
      agent: { argv: ["x"] },
      ports: { in: { direction: "receive", servo: { vars: {} } }, out: { direction: "emit" } },
    },
    sink: {
      kind: "handler",
      handler: "noop",
      ports: { got: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: { e: { from: { node: "n", port: "out" }, to: { node: "sink", port: "got" } } },
  children: {},
  subscriptions: {},
};

describe("★ P0-1 重复 apply 只生效一次", () => {
  it("同一个 executionId apply 两次 → 第二次作废，下游不重复", async () => {
    const backend: ExecutionBackend = {
      run: async (r: ExecutionRequest): Promise<ExecutionResult> => ({
        executionId: r.executionId,
        emissions: { out: { v: 1 } },
        termination: "DONE",
      }),
      cancel: async () => {},
    };
    const rt = boot(AGENT_FLOW, backend);
    rt.send({ traceid: "job-1", node: "n", port: "in" }, {});
    await rt.stepAgent();

    const again = rt.applyAgentResult("exec-1", {
      executionId: "exec-1",
      emissions: { out: { v: 1 } },
      termination: "DONE",
    });
    expect("reason" in again).toBe(true);
    expect((again as { reason: string }).reason).toMatch(/已不再是 CLAIMED/);

    // ★ 下游只有一条 —— 副作用没有重复
    expect(rt.messages().filter((m) => m.target.node === "sink")).toHaveLength(1);
    rt.checkInvariants();
  });
});

describe("★ P0-3 失败执行也要留下现场", () => {
  it("INVALID_OUTPUT 同样落 $exec —— 失败时的观测比成功时更值钱", async () => {
    const backend: ExecutionBackend = {
      run: async (r) => ({
        executionId: r.executionId,
        emissions: {},
        termination: "INVALID_OUTPUT",
        diagnostics: { runner: "probe", stderrTail: "炸了" } as never,
      }),
      cancel: async () => {},
    };
    const rt = boot(AGENT_FLOW, backend);
    rt.send({ traceid: "job-1", node: "n", port: "in" }, {});
    await rt.stepAgent();

    expect(store.has("job-1/$exec")).toBe(true);
    const body = store.head("job-1/$exec").body as Record<string, unknown>;
    expect(body.termination).toBe("INVALID_OUTPUT");
    expect(JSON.stringify(body.diagnostics)).toContain("炸了");
  });

  it("成功路径当然也留", async () => {
    const backend: ExecutionBackend = {
      run: async (r) => ({
        executionId: r.executionId,
        emissions: { out: {} },
        termination: "DONE",
        diagnostics: { runner: "probe" } as never,
      }),
      cancel: async () => {},
    };
    const rt = boot(AGENT_FLOW, backend);
    rt.send({ traceid: "job-1", node: "n", port: "in" }, {});
    await rt.stepAgent();
    expect(store.head("job-1/$exec").body).toMatchObject({ termination: "DONE" });
  });
});

describe("★ P0-4 同步 handler 路径也编上下文", () => {
  /** `max_tokens` 由调用方给 —— 上界那条要卡住，bind 那条要放行。 */
  const syncFlow = (maxTokens: number) => ({
    nodes: {
      h: {
        kind: "handler",
        handler: "probe",
        budget: { tokens: 10_000 },
        bind: { rule: { type: "long", max_tokens: 5000, literal: "编译期绑定的规范正文" } },
        ports: {
          in: {
            direction: "receive",
            servo: { vars: { big: { type: "long", from: "$.big", max_tokens: maxTokens } } },
          },
        },
      },
    },
    edges: {},
    children: {},
    subscriptions: {},
  });

  it("运行期上界对同步节点生效 —— 此前完全没查", () => {
    const rt = boot(syncFlow(1));
    rt.registerHandler("probe", () => ({}));
    rt.send({ traceid: "job-1", node: "h", port: "in" }, { big: "超上界的一大段".repeat(200) });

    const [step] = rt.drain();
    expect(step).toBeDefined();
    expect("reason" in step!).toBe(true);
    expect((step as { reason: string }).reason).toMatch(/超出声明上界 1/);
  });

  it("★ bind 段送得到 handler —— §7.1「普通 handler 也能引入长变量」此前落空", () => {
    const rt = boot(syncFlow(1000));
    let seen: Record<string, unknown> = {};
    rt.registerHandler("probe", (vars) => {
      seen = vars as Record<string, unknown>;
      return {};
    });
    rt.send({ traceid: "job-1", node: "h", port: "in" }, { big: "短的" });
    rt.drain();

    expect(seen.rule).toBe("编译期绑定的规范正文");
    expect(seen.big).toBe("短的");
  });
});

describe("★ P1 覆盖层不是逃生舱", () => {
  it("overlay 引入指向不存在节点的子槽 entry → 注册期被拒", () => {
    const child = registerContainerTemplate(store, "child", {
      nodes: {
        a: { kind: "handler", handler: "noop", ports: { in: { direction: "receive", servo: { vars: {} } } } },
      },
      edges: {},
      children: {},
      subscriptions: {},
    });
    const base = registerContainerTemplate(store, "base", {
      nodes: {},
      edges: {},
      children: {},
      subscriptions: {},
    });

    expect(() =>
      registerContainerTemplate(store, "viaOverlay", {
        extends: base,
        override: { "children/kids": { template: child, entry: { node: "ghost", port: "in" } } },
      }),
    ).toThrow(/ghost|不存在|entry/);
  });
});

describe("★ P1 contract 引用在注册期就查", () => {
  const withContract = (ref: string) => ({
    nodes: {
      n: {
        kind: "handler",
        handler: "noop",
        ports: { in: { direction: "receive", contract: ref, servo: { vars: {} } } },
      },
    },
    edges: {},
    children: {},
    subscriptions: {},
  });

  it("指向不存在的引用 → 拒绝，不是等运行期抛", () => {
    expect(() => registerContainerTemplate(store, "bad", withContract("nope@1"))).toThrow(
      /不存在/,
    );
  });

  it("★ 指向一个容器模板 → 拒绝，因为它会静默放行所有载荷", () => {
    const notAContract = registerContainerTemplate(store, "other", {
      nodes: {},
      edges: {},
      children: {},
      subscriptions: {},
    });
    expect(() => registerContainerTemplate(store, "bad", withContract(notAContract))).toThrow(
      /不是一份合法 MessageContract/,
    );
  });

  /**
   * 判据是**正文**而不是 kind —— kind 只是给人看的标签。
   * 老代码用 kind `contract` 存契约并且一直工作良好，因为决定行为的是正文。
   */
  it("kind 不是 message_contract 但正文是合法契约 → 放行", () => {
    const v = store.put("legacy", "contract", { type: "object", required: ["x"] });
    expect(() =>
      registerContainerTemplate(store, "ok2", withContract(`${v.object_id}@${v.version}`)),
    ).not.toThrow();
  });

  it("指向真的 message_contract 就通过", () => {
    const c = registerContainerTemplate(
      store,
      "task-contract",
      { type: "object", required: ["x"] },
      "message_contract",
    );
    expect(() => registerContainerTemplate(store, "good", withContract(c))).not.toThrow();
  });
});
