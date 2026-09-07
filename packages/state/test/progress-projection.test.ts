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

/**
 * ★ 没有观测的执行记录不借别人的进度。
 *
 * 上一版这条是**自证不足**的（审核指出）：它在队列已空时调 `claimAgent()`，
 * 什么都没 claim 到，于是"没有观测的记录"根本没造出来，断言却照样通过。
 * 现在先送第二条消息，claim 它、断言它确实是 RUNNING，再验它没有进度。
 */
it("没有对应观测的记录不带进度 —— 不拿别人的顶上", async () => {
  const state = RunState.open(dir, { backend: new ReportsProgress() });
  try {
    const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
    state.registry.createRoot(ref, "job-1");
    state.runtime.send({ traceid: "job-1", node: "slow", port: "in" }, {});
    await state.runtime.drainAgents(); // slow 跑完，留下一条带观测的记录

    // 第二条消息：claim 住不 apply —— 这条执行**还没有任何观测**
    state.runtime.send({ traceid: "job-1", node: "fast", port: "in" }, {});
    const claimed = state.runtime.claimAgent();
    expect(claimed.kind).toBe("claimed");
    state.persist();

    const running = state.runtime.records().filter((r) => r.status === "RUNNING");
    expect(running).toHaveLength(1);

    const snap = exportSnapshot(state, HUMAN);
    const all = snap.records as { nodeId: string; status: string; progress?: { done: number } }[];
    const done = all.find((r) => r.nodeId === "slow");
    const inflight = all.find((r) => r.status === "RUNNING");

    expect(done?.progress?.done).toBe(1);
    // ★ 在跑的那条没有观测，就不该有进度 —— 未知不显示，也不借上一条的
    expect(inflight?.progress).toBeUndefined();
  } finally {
    state.close();
  }
});

/**
 * ★ 坏的可选观测不该毁掉整张图（审核 F06）。
 *
 * backend 返回 `DONE` 且 `diagnostics.progress.done` 是字符串：内核照常接受
 * （`diagnostics` 是普通 JSON，它不该管里面的语义），但导出把这段原样带出去，
 * 于是 `parseSnapshot` 整份拒绝 —— **一次坏采集让整张图不可用**。
 *
 * 结构事实（实例、消息、执行状态）必须继续严格校验；可选的**观测**字段
 * 校验不过就以"这次采集不可用"表达，不是把整份快照拖下水。
 */
it("★ 进度格式坏掉 → 这条执行标不可用，整份快照仍然解析得了", async () => {
  class BadProgress implements ExecutionBackend {
    async run(request: ExecutionRequest): Promise<ExecutionResult> {
      return {
        executionId: request.executionId,
        emissions: {},
        termination: "DONE",
        // done 是字符串 —— 一份合法 JSON，但不是合法进度
        diagnostics: { runner: "fixture", progress: { done: "九", total: 10 } } as never,
      };
    }
    async cancel(): Promise<void> {}
  }

  const state = RunState.open(dir, { backend: new BadProgress() });
  try {
    const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
    state.registry.createRoot(ref, "job-1");
    state.runtime.send({ traceid: "job-1", node: "slow", port: "in" }, {});
    await state.runtime.drainAgents();
    state.persist();

    const snap = exportSnapshot(state, HUMAN);
    const rec = (snap.records as { progress?: unknown; progressUnavailable?: string }[])[0];

    // 不带进度 —— 未知不显示，也不编一个 0
    expect(rec?.progress).toBeUndefined();
    // 但要说清是"采集坏了"，不是"没上报"
    expect(rec?.progressUnavailable).toMatch(/进度/);

    // 结构事实照常严格：实例、消息、执行状态一条不少
    expect(Object.keys(snap.instances)).toEqual(["job-1"]);
    expect(snap.records).toHaveLength(1);
    // 接缝那一半（导出 → parseSnapshot → buildScene）在 cli 那侧验，
    // 那儿两边都在依赖里；state 不为一条用例反向依赖 scene。
  } finally {
    state.close();
  }
});

/**
 * ★ 产物归属读 provenance，不从 object_id 切段推（审核 F07）。
 *
 * 资产名本来就允许多级（`reports/result.md`），于是 `job/reports/result.md`
 * 被画布推成归属 `job/reports` —— **那个实例根本不存在**，卡片挂在一个空地址上。
 *
 * 归属不是猜出来的：写它的时候就写进 provenance 了。
 */
it("★ 多级资产名的归属是写它的实例，不是它的父路径", async () => {
  const state = RunState.open(dir, { backend: new ReportsProgress() });
  try {
    const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
    state.registry.createRoot(ref, "job-1");
    // 多级资产名：写的人是 job-1，名字里带一层目录
    state.store.put("job-1/reports/result.md", "artifact", { text: "结果" }, {
      traceid: "job-1",
      node_id: "slow",
      derived_from: [],
    });
    state.persist();

    const snap = exportSnapshot(state, HUMAN);
    const obj = (snap.objects as { object_id: string; owner?: string }[]).find(
      (o) => o.object_id === "job-1/reports/result.md",
    );
    // ★ 归属是 job-1，不是 job-1/reports
    expect(obj?.owner).toBe("job-1");
    expect(obj?.owner).not.toBe("job-1/reports");
  } finally {
    state.close();
  }
});
