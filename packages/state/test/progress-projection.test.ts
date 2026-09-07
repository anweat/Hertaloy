/**
 * ★ 进度要跟对执行（审核 R03）。
 *
 * `exportSnapshot` 原来按**实例**取 `<traceid>/$exec` 的 head，于是同一个实例
 * 里所有执行记录都被投影成**最新那次**的进度：A 上报 1/10、B 上报 9/10，
 * `$exec` 历史各自都对，投影出来两条都是 9/10。
 *
 * 这类错比"没有进度"更坏 —— 它给出的是一个看起来合理、实际张冠李戴的数字，
 * 而画布上没有任何东西提示它不可信。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "../src/run-state.js";
import { exportSnapshot } from "../src/snapshot.js";

const HUMAN = { kind: "human", id: "local" } as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-progress-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 两个 agent 节点，各自上报不同的进度。 */
const TEMPLATE = {
  nodes: {
    slow: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: { in: { direction: "receive", servo: { vars: {} } } },
    },
    fast: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: { in: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: {},
  children: {},
};

/** 按节点给不同进度；`diagnostics` 会落成 `<traceid>/$exec` 一版。 */
class ReportsProgress implements ExecutionBackend {
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const done = request.nodeId === "slow" ? 1 : 9;
    return {
      executionId: request.executionId,
      emissions: {},
      termination: "DONE",
      diagnostics: {
        runner: "fixture",
        progress: { done, total: 10 },
      } as never,
    };
  }
  async cancel(): Promise<void> {}
}

it("★ 同一实例的两条执行记录各带自己的进度，不是都跟着最新那次", async () => {
  const state = RunState.open(dir, { backend: new ReportsProgress() });
  try {
    const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
    state.registry.createRoot(ref, "job-1");
    state.runtime.send({ traceid: "job-1", node: "slow", port: "in" }, {});
    state.runtime.send({ traceid: "job-1", node: "fast", port: "in" }, {});
    await state.runtime.drainAgents();
    state.persist();

    const snap = exportSnapshot(state, HUMAN);
    const byNode = new Map(
      (snap.records as { nodeId: string; progress?: { done: number } }[]).map((r) => [
        r.nodeId,
        r.progress?.done,
      ]),
    );

    // 两次执行各自的 $exec 记录都在，历史本来就是对的
    expect(state.store.history("job-1/$exec")).toHaveLength(2);
    // ★ 投影也要各归各的
    expect(byNode.get("slow")).toBe(1);
    expect(byNode.get("fast")).toBe(9);
  } finally {
    state.close();
  }
});

it("没有对应观测的记录不带进度 —— 不拿别人的顶上", async () => {
  const state = RunState.open(dir, { backend: new ReportsProgress() });
  try {
    const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
    state.registry.createRoot(ref, "job-1");
    state.runtime.send({ traceid: "job-1", node: "slow", port: "in" }, {});
    await state.runtime.drainAgents();
    // 手工塞一条没有观测的记录：它不该借到 slow 那次的进度
    state.runtime.claimAgent();
    state.persist();

    const snap = exportSnapshot(state, HUMAN);
    const withoutProgress = (snap.records as { progress?: unknown }[]).filter(
      (r) => r.progress === undefined,
    );
    // slow 那条有进度；另一条（如果 claim 出来了）不该有
    const all = snap.records as { progress?: { done: number } }[];
    expect(all.some((r) => r.progress?.done === 1)).toBe(true);
    expect(withoutProgress.length + 1).toBe(all.length);
  } finally {
    state.close();
  }
});
