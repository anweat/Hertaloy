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
 */
it("同步节点的当前结果跨落盘可追到消息/提交；回收成功消息后仍可读提交", () => {
  const dir = mkdtempSync(join(tmpdir(), "hertaloy-handler-feedback-"));
  const state = RunState.open(dir);
  try {
    const node = { kind: "handler", handler: "noop", ports: { in: {
      direction: "receive", servo: { vars: { value: { type: "short", from: "$.value" } } },
    } } };
    state.registry.createRoot(registerContainerTemplate(state.store, "root", { nodes: { work: node, other: node } }, "root_config"), "job");
    state.runtime.registerHandler("noop", () => ({}));
    const failed = state.runtime.send({ traceid: "job", node: "work", port: "in" }, {});
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

    const success = state.runtime.send({ traceid: "job", node: "work", port: "in" }, { value: 1 });
    state.runtime.drain();
    // 默认保留窗口 200：让其它节点的后续提交真正回收 work 的成功消息。
    for (let i = 0; i < 405; i++) state.runtime.send({ traceid: "job", node: "other", port: "in" }, { value: i });
    state.runtime.drain();
    expect(state.runtime.messages().some((m) => m.id === success)).toBe(false);
    expect(state.runtime.message(failed).state).toBe("FAILED");
    state.persist();

    work = (scene(dir, HUMAN).data as unknown as Scene).cells.find((c) => c.id === "job#work")!;
    expect(work.phase).toBe("done");
    const detail = execution(dir, HUMAN, work.execution!).data as {
      execution: { termination?: string; claimed: string[] }; commit?: string;
    };
    // ★ 消息已被回收，但执行记录与它认领的 id 都还在
    expect(detail.execution.termination).toBe("DONE");
    expect(detail.execution.claimed).toEqual([success]);
    // ★ 提交正文仍按精确 ref 读得到
    expect(detail.commit).toBe("job/$run@1");
    expect(show(dir, HUMAN, detail.commit!).data).toHaveProperty("body.consumed", [success]);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
