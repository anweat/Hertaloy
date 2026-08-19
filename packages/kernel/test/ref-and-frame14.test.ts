/**
 * 两件事，都是外部审核指出「声明了但没强制」的：
 *
 *   §7.6  `ref` 变量 —— 资产写入 → 下游以 ref 引入
 *   §2 帧 14  上下文不随轮次膨胀（"整个系统存在的理由"）
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { estimateValueTokens } from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { compileContext } from "../src/context.js";

let store: ObjectStore;

beforeEach(() => {
  store = new ObjectStore();
});

/** 一个声明了 ref 端口变量的节点。 */
function nodeWithRef(maxTokens: number) {
  return {
    kind: "handler" as const,
    handler: "noop",
    budget: { tokens: 10_000 },
    ports: {
      in: {
        direction: "receive" as const,
        servo: { vars: { doc: { type: "ref" as const, from: "$.doc", max_tokens: maxTokens } } },
      },
    },
  };
}

describe("★ ref 变量真的解引用了（§7.6）", () => {
  it("传进来的是 `id@N`，编译出来的是资产正文", () => {
    store.put("job-1/plan", "plan", { text: "第一步：先把契约写清楚" });
    const r = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/plan@1" });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vars.doc).toBe("第一步：先把契约写清楚");
  });

  it("没有 body.text 就给整个 body —— 与 bind.card 同一条约定", () => {
    store.put("job-1/data", "artifact", { rows: [1, 2, 3] });
    const r = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/data@1" });
    if (r.ok) expect(r.vars.doc).toEqual({ rows: [1, 2, 3] });
  });

  it("指定版本就取那一版 —— 引用永远精确", () => {
    store.put("job-1/plan", "plan", { text: "旧版" });
    store.put("job-1/plan", "plan", { text: "新版" });
    const old = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/plan@1" });
    const now = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/plan@2" });
    if (old.ok) expect(old.vars.doc).toBe("旧版");
    if (now.ok) expect(now.vars.doc).toBe("新版");
  });

  it("引用不存在 → 失败并说清是哪个", () => {
    const r = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/nope@1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]?.message).toMatch(/解引用 job-1\/nope@1 失败/);
  });

  it("提取到的不是字符串 → 失败并说清 ref 该长什么样", () => {
    const r = compileContext(store, nodeWithRef(100) as never, { doc: { 不是: "引用" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]?.message).toMatch(/id@N/);
  });
});

describe("★ B1 的运行期一半对 ref 不再是真空", () => {
  it("量的是**解引用后的正文**，不是那串 `id@N`", () => {
    const long = "很长的一段正文。".repeat(400);
    store.put("job-1/big", "artifact", { text: long });

    // 上界按"那串引用"（约 5 tokens）看是够的，按正文看远远不够
    expect(estimateValueTokens("job-1/big@1")).toBeLessThan(20);
    expect(estimateValueTokens(long)).toBeGreaterThan(500);

    const r = compileContext(store, nodeWithRef(100) as never, { doc: "job-1/big@1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]?.message).toMatch(/超出声明上界 100/);
  });

  it("上界够大就通过，并把正文的 token 数算进总量", () => {
    store.put("job-1/big", "artifact", { text: "中等长度的一段正文" });
    const r = compileContext(store, nodeWithRef(10_000) as never, { doc: "job-1/big@1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toBeGreaterThan(0);
  });
});

/**
 * 帧 14 —— §2 说它是"整个系统存在的理由，取舍冲突时优先保它"。
 *
 * 但它此前**没有任何强制点也没有测量**：一个每轮把整包 payload 原样回传的模板，
 * 能通过注册期预算、通过运行期上界、通过全部测试。
 *
 * 这条测试不强制，只**测量** —— 让"优先保它"有一个可执行的判据。
 * 真要强制（内核比较相邻轮次并拒绝膨胀）是另一个设计决策，可能过度。
 */
describe("★ 帧 14：第二轮的上下文不该比第一轮大", () => {
  /** 记下每次 ExecutionRequest 的变量规模。 */
  class Recorder implements ExecutionBackend {
    readonly rounds: { epoch: number; tokens: number }[] = [];
    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      this.rounds.push({
        epoch: this.rounds.length + 1,
        tokens: estimateValueTokens(req.vars),
      });
      // 回传的是**新的失败切片**，不是整包 —— 帧 14 说的就是这件事
      return {
        executionId: req.executionId,
        emissions: { again: { failing: "第 5 个用例也挂了" } },
        termination: "DONE",
      };
    }
    async cancel(): Promise<void> {}
  }

  function loopFlow() {
    return {
      nodes: {
        fix: {
          kind: "handler",
          agent: { argv: ["x"] },
          budget: { tokens: 100_000 },
          // ★ 关键：bind 段是**编译期**绑定，每轮一模一样（不变量 X 的稳定前缀）
          bind: { spec: { type: "long", max_tokens: 5000, literal: "项目规范：".repeat(100) } },
          ports: {
            in: {
              direction: "receive",
              // ★ 只提失败切片，不提整包 —— 这就是帧 14 说的那件事
              servo: { vars: { failing: { type: "short", from: "$.failing" } } },
            },
            again: { direction: "emit" },
          },
        },
      },
      edges: { loop: { from: { node: "fix", port: "again" }, to: { node: "fix", port: "in" } } },
      children: {},
      subscriptions: {},
    };
  }

  it("两轮下来，第二轮进请求的变量规模不大于第一轮", async () => {
    const ref = registerContainerTemplate(store, "root", loopFlow(), "root_config");
    const reg = new InstanceRegistry(store);
    reg.createRoot(ref, "job-1");
    const backend = new Recorder();
    const rt = new Runtime(store, reg, { backend, maxAttempts: 1 });

    // 第一轮带着一大包上下文进来
    rt.send(
      { traceid: "job-1", node: "fix", port: "in" },
      { failing: "第 3 个用例挂了", bulk: "噪音".repeat(2000) },
    );
    await rt.stepAgent();
    await rt.stepAgent();

    expect(backend.rounds.length).toBeGreaterThanOrEqual(2);
    const [first, second] = backend.rounds;

    /**
     * 判据是**不累积**，不是"逐字节不增"。
     *
     * 第一版写成 `second <= first` 就炸了：第二轮的失败切片本身多一个字
     * （510 vs 509）。那不是设计失败，是我把测试写得过精 ——
     * 失败切片的长度本来就会变，**必须不发生的是累积**。
     */
    expect(second!.tokens).toBeLessThan(first!.tokens * 1.1);
    // 而第一轮那两千字的整包噪音，两轮都没进去
    expect(first!.tokens).toBeLessThan(2000);
    expect(second!.tokens).toBeLessThan(2000);
  });

  it("★ 整包噪音进不去 —— servo 只提声明过的路径", async () => {
    const ref = registerContainerTemplate(store, "root", loopFlow(), "root_config");
    const reg = new InstanceRegistry(store);
    reg.createRoot(ref, "job-1");
    const backend = new Recorder();
    const rt = new Runtime(store, reg, { backend, maxAttempts: 1 });

    rt.send(
      { traceid: "job-1", node: "fix", port: "in" },
      { failing: "只有这句该进去", noise: "x".repeat(50_000) },
    );
    await rt.stepAgent();

    // 只有 bind 段 + 失败切片，五万字的噪音一个字都没进
    expect(backend.rounds[0]!.tokens).toBeLessThan(3000);
  });
});
