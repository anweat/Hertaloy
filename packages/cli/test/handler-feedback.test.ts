import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import type { Scene } from "@nodeflow/scene";
import { execution, scene, message, show } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;

/**
 * ★ 同步节点的当前结果跨落盘可追到消息与提交。
 *
 * 原来这条走 `Cell.result`（相位旁边挂一份"证据"）。V6 阶段 1a 之后同步节点
 * 有了真正的 `ExecutionRecord`，于是走**和 agent 完全相同的那条路**：
 * `Cell.execution` → `/execution?id=` → `claimed` 是哪条消息、`commit` 是
 * 哪一版 `$run`。性质没变，少了一套并存的证据字段。
 *
 * **V6 阶段 5 · 消息那半之后又少一样**：这条原来后半段要投 405 条填充消息，
 * 把成功消息挤出保留窗口，再断言"消息已被回收，但执行记录还在" ——
 * 那是把 `keepConsumedMessages` 的损失当成规格来钉。终态消息落库之后
 * 那个损失不存在了，填充与断言一起删掉，换成更强的一条：**消息本身也读得到**。
 */
it("同步节点的当前结果跨落盘可追到消息与提交，消息本身也还在", () => {
  const dir = mkdtempSync(join(tmpdir(), "hertaloy-handler-feedback-"));
  const state = RunState.open(dir);
  try {
    const node = { kind: "handler", handler: "noop", ports: { in: {
      direction: "receive", servo: { vars: { value: { type: "short", from: "$.value" } } },
    } } };
    state.registry.createRoot(registerContainerTemplate(state.store, "root", { nodes: { work: node, other: node } }, "root_config"), "job");
    state.runtime.registerHandler("noop", () => ({}));
    const failed = state.runtime.send({ instance: "job/work", port: "in" }, {});
    state.runtime.drain();
    state.persist();

    let work = (scene(dir, HUMAN).data as unknown as Scene).cells.find((c) => c.id === "job#work")!;
    expect(work.phase).toBe("failed");
    // ★ 失败也有执行 —— 首次就失败的节点不再看起来像没跑过
    expect(work.execution).toBeDefined();
    const failedDetail = execution(dir, HUMAN, work.execution!).data as {
      execution: { termination?: string; claimed: string[] }; commit?: string;
    };
    expect(failedDetail.execution.termination).not.toBe("DONE");
    expect(failedDetail.execution.claimed).toEqual([failed]);
    // 失败不写 $run，所以没有提交可指
    expect(failedDetail.commit).toBeUndefined();
    expect(message(dir, HUMAN, failed).data).toHaveProperty("lastFailure");

    const success = state.runtime.send({ instance: "job/work", port: "in" }, { value: 1 });
    state.runtime.drain();
    expect(state.runtime.message(failed).state).toBe("FAILED");
    state.persist();

    work = (scene(dir, HUMAN).data as unknown as Scene).cells.find((c) => c.id === "job#work")!;
    expect(work.phase).toBe("done");
    const detail = execution(dir, HUMAN, work.execution!).data as {
      execution: { termination?: string; claimed: string[] }; commit?: string;
    };
    expect(detail.execution.termination).toBe("DONE");
    expect(detail.execution.claimed).toEqual([success]);
    // ★ 提交正文按精确 ref 读得到
    expect(detail.commit).toBe("job/$run@1");
    expect(show(dir, HUMAN, detail.commit!).data).toHaveProperty("body.consumed", [success]);
    // ★ 而被认领的那条消息**跨落盘仍然读得到** —— 原来这里断言的是它已被回收
    expect(message(dir, HUMAN, success).data).toHaveProperty("message.state", "CONSUMED");
    expect(message(dir, HUMAN, failed).data).toHaveProperty("message.state", "FAILED");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
