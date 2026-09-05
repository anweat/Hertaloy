/**
 * 执行记录 —— 抽出来那一块的自有用例。
 *
 * 这里最该被钉住的不是增删查，是**两种寿命的差**：
 *
 *   records   跨进程，落盘
 *   driving   进程本地，重启即空
 *
 * 孤儿判定完全建立在这个差上（RUNNING ∧ 本进程没在驱动）。它没有状态机，
 * 所以也没有"状态机写错了"的红灯 —— 一旦 `driving` 被误落盘，或者恢复时
 * 被误恢复，孤儿就永远认不出来，而且**一切看着都正常**。这类失效只有正面
 * 用例挡得住。
 */

import { describe, expect, it } from "vitest";
import { ExecutionLedger, type ExecutionRecord } from "../src/executions.js";
import { InvariantError } from "../src/errors.js";

function rec(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: "exec-1",
    traceid: "job-1",
    nodeId: "n",
    status: "RUNNING",
    claimed: ["msg-1"],
    generation: 0,
    ...over,
  };
}

describe("发号与增删查", () => {
  it("id 单调发放", () => {
    const l = new ExecutionLedger();
    expect([l.nextId(), l.nextId(), l.nextId()]).toEqual(["exec-1", "exec-2", "exec-3"]);
  });

  it("取不到是编程错误 —— id 只由本类发放", () => {
    const l = new ExecutionLedger();
    expect(() => l.get("exec-9")).toThrow(InvariantError);
    expect(() => l.get("exec-9")).toThrow(/未知 execution/);
  });

  it("记录是冻结对象，`replace` 只打补丁", () => {
    const l = new ExecutionLedger();
    l.put(rec({ generation: 3 }));
    const before = l.get("exec-1");
    expect(Object.isFrozen(before)).toBe(true);

    l.replace("exec-1", { status: "SETTLED", termination: "DONE" });
    expect(l.get("exec-1")).toMatchObject({
      status: "SETTLED",
      termination: "DONE",
      generation: 3,
      claimed: ["msg-1"],
    });
    expect(before.status).toBe("RUNNING"); // 旧引用不受影响，快照因此可回滚
  });
});

describe("★ 孤儿 = RUNNING ∧ 本进程没在驱动", () => {
  it("本进程在驱动的不算孤儿", () => {
    const l = new ExecutionLedger();
    l.put(rec());
    expect(l.orphans().map((r) => r.executionId)).toEqual(["exec-1"]);

    l.markDriving("job-1", "n");
    expect(l.orphans()).toEqual([]);
  });

  it("已了结的记录不算孤儿，哪怕没人在驱动", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", status: "SETTLED", termination: "CANCELLED" }));
    l.put(rec({ executionId: "exec-2", status: "VOIDED" }));
    expect(l.orphans()).toEqual([]);
  });

  it("驱动标记按 (实例, 节点) 分粒度，不串号", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", traceid: "job-1", nodeId: "a" }));
    l.put(rec({ executionId: "exec-2", traceid: "job-1", nodeId: "b" }));
    l.put(rec({ executionId: "exec-3", traceid: "job-2", nodeId: "a" }));
    l.markDriving("job-1", "a");

    expect(l.orphans().map((r) => r.executionId)).toEqual(["exec-2", "exec-3"]);
    expect(l.isDriving("job-1", "a")).toBe(true);
    expect(l.isDriving("job-1", "b")).toBe(false);
    expect(l.isDriving("job-2", "a")).toBe(false);
  });
});

describe("★ 两种寿命：driving 绝不落盘、绝不恢复", () => {
  /**
   * 这是"崩溃接管不需要状态机"的全部机制（§17.14）。正因为重启后 driving
   * 是空的，上一个进程留下的 RUNNING 记录才会自动显形为孤儿。
   */
  it("快照里没有 driving", () => {
    const l = new ExecutionLedger();
    l.put(rec());
    l.markDriving("job-1", "n");
    expect(Object.keys(l.snapshot() as object).sort()).toEqual(["records", "seq"]);
  });

  it("★ 恢复之后 driving 是空的 —— 上个进程的在途执行自动成为孤儿", () => {
    const first = new ExecutionLedger();
    first.put(rec());
    first.markDriving("job-1", "n");
    expect(first.orphans()).toEqual([]); // 本进程在跑，不是孤儿
    const snap = first.snapshot();

    // 换一个进程装载
    const second = new ExecutionLedger();
    second.restore(snap);
    expect(second.drivingCount()).toBe(0);
    expect(second.orphans().map((r) => r.executionId)).toEqual(["exec-1"]);
  });

  it("★ 截断放掉驱动标记 —— 记录与标记同进同出", () => {
    /**
     * 修之前：截断只把记录改成 SETTLED，标记留着。今天不炸是因为实例已
     * TERMINAL、调度本来就跳过它 —— 那是另一条规则替它兜住了，不是这里对。
     * 而集合只增不减，长跑进程里每截断一次就多一条。
     */
    const l = new ExecutionLedger();
    l.put(rec());
    l.markDriving("job-1", "n");
    expect(l.drivingCount()).toBe(1);

    l.replace("exec-1", { status: "SETTLED", termination: "CANCELLED" });
    l.releaseDriving("job-1", "n");
    expect(l.drivingCount()).toBe(0);
    expect(l.orphans()).toEqual([]);
  });

  it("seq 跟着快照走 —— 漏了它，恢复后新执行会拿到用过的 id", () => {
    const first = new ExecutionLedger();
    first.nextId();
    first.nextId();
    const second = new ExecutionLedger();
    second.restore(first.snapshot());
    expect(second.nextId()).toBe("exec-3");
  });

  it("回滚语义：拿旧快照恢复，中间的记录消失", () => {
    const l = new ExecutionLedger();
    l.put(rec());
    const before = l.snapshot();

    l.put(rec({ executionId: "exec-2" }));
    l.replace("exec-1", { status: "VOIDED" });
    expect(l.all()).toHaveLength(2);

    l.restore(before);
    expect(l.all().map((r) => r.executionId)).toEqual(["exec-1"]);
    expect(l.get("exec-1").status).toBe("RUNNING");
  });
});

/**
 * `latestPerNode` —— 执行面定位上游那次执行所需的那张表。
 *
 * 它替换掉的是 sandbox backend 进程内的一张 Map。那张 Map 与这里的 `records`
 * 记的是同一件事，只是**活得更短**：不落盘、不重建，换个进程就空了。
 * 第二拷贝活得比权威短，就是"重启后工作区交接必然失败"的全部原因。
 */
describe("latestPerNode：上游执行的定位表", () => {
  it("同一节点后写的覆盖先写的", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", nodeId: "build", status: "SETTLED" }));
    l.put(rec({ executionId: "exec-2", nodeId: "build", status: "SETTLED" }));
    expect(l.latestPerNode("job-1")).toEqual({ build: "exec-2" });
  });

  it("多个节点各占一格", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", nodeId: "build", status: "SETTLED" }));
    l.put(rec({ executionId: "exec-2", nodeId: "test", status: "SETTLED" }));
    expect(l.latestPerNode("job-1")).toEqual({ build: "exec-1", test: "exec-2" });
  });

  it("★ VOIDED 不进表 —— 那个状态的意思正是「这次不算数」", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", nodeId: "build", status: "SETTLED" }));
    l.put(rec({ executionId: "exec-2", nodeId: "build", status: "VOIDED" }));
    // 作废的那次被栅栏丢掉了结果，从它那儿接过工作树等于把不算数的活儿传下去；
    // 表回退到上一次真正算数的
    expect(l.latestPerNode("job-1")).toEqual({ build: "exec-1" });
  });

  it("★ 按实例限定 —— 兄弟实例的执行不串过来", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", traceid: "job-1", nodeId: "build" }));
    l.put(rec({ executionId: "exec-2", traceid: "job-2", nodeId: "build" }));
    expect(l.latestPerNode("job-1")).toEqual({ build: "exec-1" });
    expect(l.latestPerNode("job-2")).toEqual({ build: "exec-2" });
    expect(l.latestPerNode("job-3")).toEqual({});
  });

  it("★ 读的是 records 不是 driving —— restore 之后还在", () => {
    const l = new ExecutionLedger();
    l.put(rec({ executionId: "exec-1", nodeId: "build", status: "SETTLED" }));
    l.markDriving("job-1", "build");

    const reborn = new ExecutionLedger();
    reborn.restore(l.snapshot());
    expect(reborn.latestPerNode("job-1")).toEqual({ build: "exec-1" });
    // driving 是进程本地的，不该跟着过来（孤儿判定全靠这个差）
    expect(reborn.drivingCount()).toBe(0);
  });
});
