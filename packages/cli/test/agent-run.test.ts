/**
 * E1 验收：落盘的 run 能不能真跑起一个 agent 节点。
 *
 * 此前不能 —— `RunState` 建 Runtime 时没给 backend，`drain` 只走同步 handler。
 * 整个执行面（沙箱、命令行、git 观察）从没被落盘的 run 驱动过，
 * 只在单元测试里被直接构造 `ExecutionRequest` 调用过。
 *
 * 判据是**跨进程**：第一个进程建图，第二个进程 drain 跑 agent，
 * 第三个进程读得到 agent 写出来的产物。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { LocalRunner, SandboxBackend } from "@nodeflow/sandbox";
import { RunState } from "@nodeflow/state";
import { drain, history, show, status } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

/**
 * 一个真 agent：读注入的 vars.json，往 emit.json 写结果。
 * 走的是 §14 的沙箱契约，与 `claude` / `codex` 完全同一条路。
 */
const AGENT_SCRIPT = [
  "const fs=require('fs');",
  // 契约：cwd 是 workspace，元数据在 ../.hertaloy 下（§14.2）
  "const v=JSON.parse(fs.readFileSync('../.hertaloy/context/vars.json','utf8'));",
  "fs.writeFileSync('../.hertaloy/emit.json',JSON.stringify({out:{echoed:v.task,expect:1}}));",
].join("");

const TEMPLATE = {
  nodes: {
    worker: {
      kind: "handler",
      agent: { argv: ["node", "-e", AGENT_SCRIPT] },
      ports: {
        in: { direction: "receive", servo: { vars: { task: { type: "short", from: "$.task" } } } },
        out: { direction: "emit" },
      },
    },
    sink: {
      kind: "handler",
      handler: "collect",
      ports: {
        got: {
          direction: "receive",
          servo: {
            vars: {
              value: { type: "short", from: "$.echoed" },
              expect: { type: "short", from: "$.expect" },
            },
          },
        },
        done: { direction: "emit" },
      },
    },
  },
  edges: { e1: { from: { node: "worker", port: "out" }, to: { node: "sink", port: "got" } } },
  children: {},
  subscriptions: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-agent-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(
      registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"),
      "job-1",
    );
    s.runtime.send({ traceid: "job-1", node: "worker", port: "in" }, { task: "hello" });
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function backend(): SandboxBackend {
  return new SandboxBackend({ runner: new LocalRunner() });
}

describe("★ 落盘的 run 真跑 agent（E1）", () => {
  it("第二个进程 drain → agent 在沙箱里跑 → 产出经边落到 sink", async () => {
    const r = await drain(dir, HUMAN, backend());
    expect(r.code).toBe(0);

    // 第三个进程：读 agent 产出的东西
    expect(history(dir, HUMAN, "job-1/parts").code).toBe(0);
    expect(show(dir, HUMAN, "job-1/parts").text).toContain("hello");
  }, 120_000);

  it("★ 不给 --runner 就没有执行面 —— agent 原地不动，且明说", async () => {
    const r = await drain(dir, HUMAN);
    expect(r.text).toContain("未配置执行面");
    // 消息还在，没有被悄悄丢掉
    expect(status(dir, HUMAN).text).toContain("在途消息 1 条");
  });

  it("执行记录落了盘 —— claim 的耐久性对真 agent 也成立", async () => {
    await drain(dir, HUMAN, backend());
    const s = RunState.open(dir, { readOnly: true });
    try {
      const records = s.runtime.records();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("APPLIED");
    } finally {
      s.close();
    }
  }, 120_000);
});
