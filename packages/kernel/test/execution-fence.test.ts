import { describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

function setup() {
  const store = new ObjectStore();
  const registry = new InstanceRegistry(store);
  registry.createRoot(registerContainerTemplate(store, "root", {
    nodes: { a: { kind: "handler", agent: { argv: ["unused"] }, ports: { in: { direction: "receive" } } } },
  }), "job");
  const runtime = new Runtime(store, registry, { maxAttempts: 3 });
  const message = runtime.send({ instance: "job/a", port: "in" }, {});
  return { store, registry, runtime, message };
}

const lateResults = ["DONE", "FAILED", "malformed", "exception"] as const;
function deliver(runtime: Runtime, id: string, mode: typeof lateResults[number]) {
  if (mode === "exception") return runtime.failAgentResult(id, "FAILED", "late exception");
  return runtime.applyAgentResult(id, mode === "malformed" ? null : {
    executionId: id, termination: mode, emissions: {}, diagnostics: { stale: true },
  });
}

describe("迟到结果不能覆盖已关闭的 attempt", () => {
  it.each(lateResults)("重试已重新 claim，同一消息收到旧 %s 结果", (mode) => {
    const { runtime, store, message } = setup();
    expect(runtime.claimAgent().kind).toBe("claimed");
    runtime.failAgentResult("exec-1", "FAILED", "retry");
    expect(runtime.claimAgent().kind).toBe("claimed");
    const before = runtime.snapshot();
    const old = runtime.record("exec-1");
    // 第一次 attempt 结算时已经写了一版 $exec（V6 阶段 5：终态归对象库），
    // 所以这里钉的是"迟到结果**什么都不加**"，而不是"一版都没有"
    const history = store.history("job/$exec");
    expect(deliver(runtime, "exec-1", mode)).toHaveProperty("reason");
    expect(runtime.snapshot()).toEqual(before);
    expect(runtime.record("exec-1")).toEqual(old);
    expect(runtime.message(message).state).toBe("CLAIMED");
    expect(runtime.orphanedExecutions()).toEqual([]); // 旧结果不能清掉新 attempt 的 driving
    expect(store.history("job/$exec")).toEqual(history);
    runtime.checkInvariants();
    runtime.applyAgentResult("exec-2", { executionId: "exec-2", termination: "DONE", emissions: {} });
    expect(runtime.message(message).state).toBe("CONSUMED");
  });

  it.each(lateResults)("截断后收到 %s，保持终态且不重排队", (mode) => {
    const { runtime } = setup();
    runtime.claimAgent();
    runtime.truncate("job", "stop");
    const before = runtime.snapshot();
    expect(deliver(runtime, "exec-1", mode)).toHaveProperty("reason");
    expect(runtime.snapshot()).toEqual(before);
    runtime.checkInvariants();
  });

  it("成功后的重复结果不把已消费消息改成 FAILED，也不追加观测", () => {
    const { runtime, store } = setup();
    runtime.claimAgent();
    runtime.applyAgentResult("exec-1", { executionId: "exec-1", termination: "DONE", emissions: {} });
    const before = runtime.snapshot();
    const history = store.history("job/$exec");
    expect(deliver(runtime, "exec-1", "malformed")).toHaveProperty("reason");
    expect(runtime.snapshot()).toEqual(before);
    expect(store.history("job/$exec")).toEqual(history);
  });
});
