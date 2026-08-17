import { describe, expect, it } from "vitest";
import { Runtime } from "../src/index.js";
import { InvariantError, MockExecutionBackend } from "../src/index.js";

/** 迷你模板：start → plain(echo) → end */
function buildEchoRuntime() {
  const rt = new Runtime();
  rt.registerContract("Task", 1, { type: "object", properties: { v: { type: "integer" } }, required: ["v"] });
  rt.registerHandler("echo", (payload) => ({ out: payload }));
  rt.registerGraphTemplate("echo-flow", {
    nodes: {
      start: { kind: "start", emit: "io", endpoints: { io: {} } },
      w: {
        kind: "plain",
        handler: "echo",
        endpoints: {
          io: { receive: { PUSH: { contract: "Task@1" } } },
          out: { emit: { PUSH: { contract: "Task@1" } } },
        },
      },
      end: { kind: "end", endpoints: { io: { receive: { PUSH: { contract: "Task@1" } } } } },
    },
    edges: [
      { id: "e1", from: "start.io", to: "w.io" },
      { id: "e2", from: "w.out", to: "end.io" },
    ],
  });
  return rt;
}

describe("kernel smoke", () => {
  it("注册 + 实例化 + 发送 + 排空（plain 链路，contract 校验通过）", async () => {
    const rt = buildEchoRuntime();
    const gid = rt.instantiate("echo-flow@1", { owner: "human:alice" });
    rt.send([gid, "start", "io"], { v: 1 });
    await rt.drain(gid);
    expect(rt.commitSeq(gid)).toBe(3); // start / w / end 各一次提交（V5：claim 不推进 seq）
    const snapshots = rt.runSnapshots(gid);
    expect(snapshots).toHaveLength(4); // R0 物化 + 3 次提交
    expect(snapshots[3]!.body.node).toBe("end");
  });

  it("契约校验失败：缺失必需字段在入口即拒", async () => {
    const rt = buildEchoRuntime();
    const gid = rt.instantiate("echo-flow@1", { owner: "human:alice" });
    expect(() => rt.send([gid, "start", "io"], { nope: 1 })).toThrow(InvariantError);
  });

  it("agent 节点走三段式 claim/execute/apply", async () => {
    const rt = new Runtime();
    rt.registerContract("Task", 1, { type: "object" });
    rt.registerContract("Plan", 1, { type: "object" });
    rt.compileAgentSpec({ specId: "planner", model: "mock" });
    rt.registerGraphTemplate("plan-flow", {
      nodes: {
        plan: {
          kind: "agent",
          spec: "planner",
          endpoints: { io: { receive: { PUSH: { contract: "Task@1" } } }, out: { emit: { PUSH: { contract: "Plan@1" } } } },
        },
        end: { kind: "end", endpoints: { io: {} } },
      },
      edges: [{ id: "e1", from: "plan.out", to: "end.io" }],
    });
    const backend = new MockExecutionBackend();
    backend.on("planner", (req) => ({
      executionId: req.executionId,
      emissions: [["out", { plan: req.context.messages[0] }]],
      artifacts: [["plan", "plan", { from: req.context.messages[0] }]],
      usage: { inTokens: 10, outTokens: 5, cost: 0.001, wallClockSeconds: 0.1, toolCalls: 0, compactions: 0 },
      termination: "DONE",
      observations: [],
      diagnostics: {},
    }));
    rt.setBackend(backend);
    const gid = rt.instantiate("plan-flow@1", { owner: "human:alice" });
    rt.send([gid, "plan", "io"], { task: 1 });
    await rt.drain(gid);
    // plan 提交 → 产物 plan@1 + run 快照；end 消费
    expect(rt.artifactVersions("plan")).toEqual([1]);
    expect(rt.usage(gid).inTokens).toBe(10);
    expect(rt.usage(gid).compactions).toBe(0);
    const last = rt.runSnapshots(gid).at(-1)!;
    expect(last.body.node).toBe("end");
    expect(rt.commitSeq(gid)).toBe(2); // plan + end 各一次（claim 不推进 seq）
  });

  it("终态气密：CLOSED 拒绝新消息与审批，重复 close 幂等", async () => {
    const rt = buildEchoRuntime();
    const gid = rt.instantiate("echo-flow@1", { owner: "human:alice" });
    await rt.control(gid, "close", { actor: "human:alice" });
    await rt.control(gid, "close", { actor: "human:alice" }); // 幂等
    expect(rt.graphStatus(gid)).toBe("CLOSED");
    expect(() => rt.send([gid, "start", "io"], { v: 1 })).toThrow(InvariantError);
    await expect(rt.control(gid, "resume", { actor: "human:alice" })).rejects.toThrow(InvariantError);
  });

  it("publish/subscribe：topic 与图拓扑正交（M2），CLOSED 订阅者被过滤", async () => {
    const rt = buildEchoRuntime();
    rt.registerTopic("progress", {});
    const gid = rt.instantiate("echo-flow@1", { owner: "human:alice" });
    rt.subscribe("progress", [gid, "w", "io"]);
    rt.publish("progress", { v: 9 });
    await rt.drain(gid);
    expect(rt.queue("progress").depth).toBe(0);
    // CLOSED 订阅者不再收消息
    await rt.control(gid, "close", { actor: "human:alice" });
    rt.publish("progress", { v: 10 });
    expect(rt.queue("progress").depth).toBe(0);
  });
});
