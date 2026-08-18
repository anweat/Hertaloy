/**
 * 外部审核 P0：agent 挂死时，另一条控制命令还能不能截断？
 *
 * 这是 E1 接线引入的回归 —— K3 刚刚承诺"卡住的 run 杀得掉"，
 * 而 drain 持着 head.lock 等 backend，truncate 拿不到同一把锁。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionBackend, ExecutionResult } from "@nodeflow/contracts";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import { drain, status, truncate } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

/** 永远不返回的 agent —— 模型挂住、网络黑洞、进程僵死都长这样。 */
class Hangs implements ExecutionBackend {
  started = 0;
  async run(): Promise<ExecutionResult> {
    this.started += 1;
    return await new Promise<ExecutionResult>(() => {});
  }
  async cancel(): Promise<void> {}
}

const TEMPLATE = {
  nodes: {
    worker: {
      kind: "handler",
      agent: { argv: ["true"] },
      ports: {
        in: { direction: "receive", servo: { vars: { t: { type: "short", from: "$.t" } } } },
        out: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-hung-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"), "job-1");
    s.runtime.send({ traceid: "job-1", node: "worker", port: "in" }, { t: "x" });
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("★ agent 挂死时控制面仍然可用", () => {
  it("drain 卡在 agent 上 → truncate 依然提交得了", async () => {
    const backend = new Hangs();
    const running = drain(dir, HUMAN, backend); // 故意不 await：它不会返回

    // 等 claim 落盘
    for (let i = 0; i < 200 && backend.started === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(backend.started).toBe(1);

    // 这是关键断言：另一条命令必须能进来
    const t = truncate(dir, HUMAN, "job-1", "agent 挂死");
    expect(t.code).toBe(0);
    expect(status(dir, HUMAN).text).toContain("TERMINAL");
    void running;
  }, 30_000);

  it("只读 status 在 agent 跑着时也能看到它在跑", async () => {
    const backend = new Hangs();
    const running = drain(dir, HUMAN, backend);
    for (let i = 0; i < 200 && backend.started === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(status(dir, HUMAN).text).toMatch(/在跑的 execution 1 个/);
    void running;
  }, 30_000);
});
