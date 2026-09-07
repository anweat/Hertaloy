import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import type { Scene } from "@nodeflow/scene";
import { scene, message, show } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;

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
    expect(work.result).toEqual({ message: { id: failed, available: true } });
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
    expect(work.execution).toBeUndefined();
    expect(work.result?.message).toEqual({ id: success, available: false });
    expect(work.result?.commit).toBe("job/$run@1");
    expect(show(dir, HUMAN, work.result!.commit!).data).toHaveProperty("body.consumed", [success]);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
