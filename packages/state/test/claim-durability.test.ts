/**
 * K1 验收：claim 必须熬过崩溃（§17.4）。
 *
 * 判据不是"persist 被调了"，是**换个进程 open 出来看得见那条 RUNNING 记录**。
 * 看不见的话，恢复后内核会以为没人在跑，再派一个 agent —— 两个 agent 同时
 * 改同一份东西，正是 §17.4 点名的那条。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "../src/run-state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-claim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TEMPLATE = {
  nodes: {
    worker: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: {
        in: { direction: "receive", servo: { vars: { task: { type: "short", from: "$.task" } } } },
        out: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

/**
 * 进程在 agent 跑到一半时死掉 —— backend 永不返回。
 *
 * **必须真传进 RunState**：不传的话 `stepAgent` 会撞上"未配置 backend"的
 * invariant，而 `void` 调用让它变成未处理的 rejection —— 测试仍然"通过"，
 * 整个包却以退出码 1 结束。断言绿了不等于套件绿了。
 */
class NeverReturns implements ExecutionBackend {
  async run(_request: ExecutionRequest): Promise<ExecutionResult> {
    return await new Promise<ExecutionResult>(() => {
      /* 永不 resolve：模拟"这个进程再也没能走到 apply" */
    });
  }
  async cancel(): Promise<void> {}
}

function seed(state: RunState): void {
  const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
  state.registry.createRoot(ref, "job-1");
  state.runtime.send({ traceid: "job-1", node: "worker", port: "in" }, { task: "t1" });
}

describe("★ claim 熬过崩溃", () => {
  it("claim 之后进程死掉 → 记录留在盘上（只读打开可见，因为只读不认领）", async () => {
    const first = RunState.open(dir, { backend: new NeverReturns() });
    seed(first);
    first.persist();
    // 故意不 await：stepAgent 会在 backend.run 里永远挂着，
    // 就像进程在这一刻被杀
    void first.runtime.stepAgent();
    await Promise.resolve();
    first.close();

    // 只读打开验持久性：写入打开会当场认领孤儿（那是另一条用例的事）
    const second = RunState.open(dir, { readOnly: true });
    try {
      const running = second.runtime.records().filter((r) => r.status === "RUNNING");
      expect(running).toHaveLength(1);
      expect(running[0]?.traceid).toBe("job-1");
      // 那条消息也该是 CLAIMED，不是还在队列里等人捡
      expect(second.runtime.message(running[0]!.claimed[0]!).state).toBe("CLAIMED");
      expect(second.runtime.pending()).toHaveLength(0);
    } finally {
      second.close();
    }
  });

  it("关掉自动落盘 → claim 就丢了（这正是没有钩子时的状况）", async () => {
    const first = RunState.open(dir, { manualDurability: true, backend: new NeverReturns() });
    seed(first);
    first.persist();
    void first.runtime.stepAgent();
    await Promise.resolve();
    first.close();

    const second = RunState.open(dir, { manualDurability: true });
    try {
      expect(second.runtime.records()).toHaveLength(0);
      // 消息还在队列里 —— 恢复后会再派一个 agent，而外面那个还在跑
      expect(second.runtime.pending()).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});


describe("★ 孤儿认领：恢复不是「看得见」，是「接着跑完」", () => {
  /** 第二次调用才成功的 backend —— 模拟"上次没跑完，这次跑完了"。 */
  class SucceedsOnRetry implements ExecutionBackend {
    calls = 0;
    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      this.calls += 1;
      if (this.calls === 1) return await new Promise<ExecutionResult>(() => {});
      return {
        executionId: req.executionId,
        emissions: {},
        artifacts: [{ object_id: "done", kind: "artifact", body: { ok: true }, derived_from: [] }],
        termination: "DONE",
      };
    }
    async cancel(): Promise<void> {}
  }

  it("崩在 claim 与 apply 之间 → 新进程认领 → 重跑 → 真的产出", async () => {
    const backend = new SucceedsOnRetry();
    const first = RunState.open(dir, { backend });
    seed(first);
    first.persist();
    void first.runtime.stepAgent(); // 永不返回，模拟进程被杀
    await Promise.resolve();
    first.close();

    // 新进程：**显式**认领一次（不再在 open 里自动做 —— 见 run-state.ts 的说明）
    const second = RunState.open(dir, { backend });
    try {
      expect(second.reconcile()).toHaveLength(1);
      expect(second.reconciled[0]?.reason).toMatch(/上一个进程没有跑完/);
      expect(second.reconciled[0]?.retrying).toBe(true);
      // 关键：消息退回队列，不是卡在 CLAIMED
      expect(second.runtime.pending()).toHaveLength(1);

      await second.runtime.drainAgents();
      expect(second.store.head("job-1/done").body).toEqual({ ok: true });
      second.runtime.checkInvariants();
    } finally {
      second.close();
    }
  }, 20_000);

  it("干净退出的 run 再打开，不会凭空认领", () => {
    const s = RunState.open(dir);
    seed(s);
    s.persist();
    s.close();

    const again = RunState.open(dir);
    try {
      expect(again.reconcile()).toEqual([]);
    } finally {
      again.close();
    }
  });

  it("只读打开不认领 —— 没有锁就没有「我是唯一写者」这个前提", async () => {
    const backend = new SucceedsOnRetry();
    const first = RunState.open(dir, { backend });
    seed(first);
    first.persist();
    void first.runtime.stepAgent();
    await Promise.resolve();
    first.close();

    const reader = RunState.open(dir, { readOnly: true });
    try {
      expect(reader.reconcile()).toEqual([]); // 只读没有"我是唯一写者"的前提
      expect(reader.runtime.records()[0]?.status).toBe("RUNNING");
    } finally {
      reader.close();
    }
  }, 20_000);

  it("认领不新增状态 —— 落在既有的 SETTLED + FAILED，不是新枚举值", async () => {
    const backend = new SucceedsOnRetry();
    const first = RunState.open(dir, { backend });
    seed(first);
    first.persist();
    void first.runtime.stepAgent();
    await Promise.resolve();
    first.close();

    const second = RunState.open(dir, { backend });
    try {
      second.reconcile();
      expect(second.runtime.records().map((r) => r.status)).toEqual(["SETTLED"]);
      expect(second.runtime.records().map((r) => r.termination)).toEqual(["FAILED"]);
    } finally {
      second.close();
    }
  }, 20_000);
});


describe("★ 认领不再在 open 时自动发生（外部审核 P0-2）", () => {
  /**
   * 原来的推理是"拿到目录锁 ⇒ 没有别的写进程 ⇒ RUNNING 必然是孤儿"。
   * 那前提被我们自己破坏了：为了让 agent 挂死时 truncate 进得来，
   * drain 改成了跑 agent 时不持锁。于是 agent 在外面跑的那段时间里，
   * **任何一条写命令**拿到锁一看 RUNNING 就认领 → 第二个 agent 被派出去。
   * 不需要崩溃，正常路径上就会发生。
   */
  it("agent 在外面跑时，别的写命令 open 不会偷走它的 claim", async () => {
    const backend = new NeverReturns();
    const a = RunState.open(dir, { backend });
    seed(a);
    a.persist();
    void a.runtime.stepAgent(); // claim 落盘，agent 出去了
    await Promise.resolve();
    a.close();

    // 另一条写命令进来（比如 hertaloy send / truncate）
    const b = RunState.open(dir);
    try {
      // open 本身不动它
      expect(b.runtime.records()[0]?.status).toBe("RUNNING");
      expect(b.runtime.pending()).toHaveLength(0); // 消息仍是 CLAIMED，没被退回
    } finally {
      b.close();
    }
  }, 20_000);

  it("★ 迟到的 apply 撞上被退回的消息 → 作废，不覆盖新 claim（P0-1）", async () => {
    const backend = new NeverReturns();
    const a = RunState.open(dir, { backend });
    seed(a);
    a.persist();
    void a.runtime.stepAgent();
    await Promise.resolve();

    /**
     * 认领要**在另一个进程里**发生 —— 同进程的 `#busy` 还记着自己在跑，
     * `orphanedExecutions` 不会把它当孤儿（这本身是对的）。
     * 所以这里换个 RunState 来认领，模拟"另一条命令进来了"。
     */
    a.close();
    const b = RunState.open(dir);
    b.runtime.reconcile();
    b.persist();
    b.close();

    // 旧执行的结果迟到 —— 此时消息已被退回队列
    const c = RunState.open(dir, { backend });
    const late = c.runtime.applyAgentResult("exec-1", {
      executionId: "exec-1",
      emissions: {},
      termination: "DONE",
    });
    expect("reason" in late).toBe(true);
    expect((late as { reason: string }).reason).toMatch(/已不再是 CLAIMED/);
    c.runtime.checkInvariants();
    c.close();
  }, 20_000);
});
