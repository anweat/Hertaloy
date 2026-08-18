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

/** 进程在 agent 跑到一半时死掉 —— backend 永不返回。 */
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
  it("claim 之后进程死掉 → 新进程看得见那条 RUNNING 记录", async () => {
    const first = RunState.open(dir);
    seed(first);
    first.persist();
    // 故意不 await：stepAgent 会在 backend.run 里永远挂着，
    // 就像进程在这一刻被杀
    void first.runtime.stepAgent();
    await Promise.resolve();
    first.close();

    const second = RunState.open(dir);
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
    const first = RunState.open(dir, { manualDurability: true });
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
