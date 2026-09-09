/**
 * ★ `scene --watch` —— 持续增量输出。
 *
 * 这一组测的是**它真的省了东西**，不只是"能跑"：
 *
 *   1. 一开就给一帧基线（别让人对着空屏等第一次变化）
 *   2. 什么都没发生时**一个字都不输出** —— 这是"减少占用"的落点
 *   3. 真有提交时那一帧只带变的部分
 *
 * 为什么是轮询而不是订阅：内核的 `CommitHook` 在**写进程内**触发，
 * 而看的人是另一个进程，收不到。所以盯 `head.json` 的 mtime + size ——
 * 它每次提交全量重写，变了就说明有事发生。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import type { SceneDelta } from "@nodeflow/scene";
import { drain, send, watchScene } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

const TEMPLATE = {
  nodes: {
    gate: {
      kind: "handler",
      handler: "collect",
      ports: {
        in: {
          direction: "receive",
          servo: {
            vars: {
              value: { type: "short", from: "$.value" },
              expect: { type: "short", from: "$.expect" },
            },
          },
        },
        done: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-watch-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(
      registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"),
      "job-1",
    );
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 等到条件成立或超时 —— 不用固定 sleep，免得慢机器上闪断。 */
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe("★ scene --watch", () => {
  it("先给一帧基线，之后静止时一个字都不输出", async () => {
    const lines: string[] = [];
    const stop = new AbortController();
    const task = watchScene(dir, HUMAN, undefined, 50, (l) => lines.push(l), stop.signal);

    expect(await until(() => lines.length >= 1)).toBe(true);
    const first = JSON.parse(lines[0] as string) as SceneDelta;
    // 第一帧是**与空场景的差量** —— 流上只有一种形状，没有单独的"全量帧"
    expect(first.cells.added.length).toBeGreaterThan(0);
    expect(first.cells.removed).toHaveLength(0);

    // 静止 —— 再等几轮，不该再有帧
    const after = lines.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(lines.length).toBe(after);

    stop.abort();
    await task;
  });

  it("★ 真有提交才吐帧，而且只带变的部分", async () => {
    const lines: string[] = [];
    const stop = new AbortController();
    const task = watchScene(dir, HUMAN, undefined, 50, (l) => lines.push(l), stop.signal);
    expect(await until(() => lines.length >= 1)).toBe(true);
    const baseline = lines.length;

    // 另一个进程干了活
    send(dir, HUMAN, "job-1/gate", "in", { value: 1, expect: 1 });
    await drain(dir, HUMAN, undefined);

    expect(await until(() => lines.length > baseline)).toBe(true);
    const delta = JSON.parse(lines[lines.length - 1] as string) as SceneDelta;

    // 这一帧不该把整份场景又送一遍：基线里已经有的单元不重复出现在 added
    const firstFrame = JSON.parse(lines[0] as string) as SceneDelta;
    const known = new Set(firstFrame.cells.added.map((c) => c.id));
    expect(delta.cells.added.every((c) => !known.has(c.id))).toBe(true);
    // 而且确实有东西变了（跑过一次提交，节点的活跃度/阶段会动）
    const touched =
      delta.cells.added.length + delta.cells.changed.length + delta.flows.added.length;
    expect(touched).toBeGreaterThan(0);

    stop.abort();
    await task;
  });

  it("只读盯着不影响写的那一方 —— 看的人不拿目录锁", async () => {
    const lines: string[] = [];
    const stop = new AbortController();
    const task = watchScene(dir, HUMAN, undefined, 50, (l) => lines.push(l), stop.signal);
    expect(await until(() => lines.length >= 1)).toBe(true);

    // watch 正跑着，写命令照样拿得到锁
    const sent = send(dir, HUMAN, "job-1/gate", "in", { value: 1, expect: 1 });
    expect(sent.code, sent.text).toBe(0);
    const drained = await drain(dir, HUMAN, undefined);
    expect(drained.code, drained.text).toBe(0);

    stop.abort();
    await task;
  });
});
