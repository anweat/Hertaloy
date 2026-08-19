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

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { LocalRunner, SandboxBackend } from "@nodeflow/sandbox";
import { RunState } from "@nodeflow/state";
import { drain, history, show, status, why } from "../src/state-commands.js";

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
  // 沙箱落在状态目录下 —— 与 CLI 的 makeBackend 同一条路径规则
  return new SandboxBackend({ runner: new LocalRunner(join(dir, "sandboxes")) });
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

describe("★ 执行观测落成对象，不给 ExecutionRecord 加字段", () => {
  it("agent 跑完 → git 观察进对象库 → show 立刻读得到（修之前算完就丢）", async () => {
    await drain(dir, HUMAN, backend());

    const h = history(dir, HUMAN, "job-1/$exec");
    expect(h.code).toBe(0);
    expect(h.text).toContain("1 版");

    const v = JSON.parse(show(dir, HUMAN, "job-1/$exec").text);
    expect(v.body.node).toBe("worker");
    expect(v.body.termination).toBe("DONE");
    // 观测本身：runner 是谁、隔离与出网受不受控
    expect(v.body.diagnostics.runner).toBe("local");
    expect(v.body.diagnostics.networkEnforced).toBe(false);
    expect(v.provenance.execution_id).toBe(v.body.execution_id);
  }, 120_000);

  it("观测在 status 里露头，不用先知道对象名", async () => {
    await drain(dir, HUMAN, backend());
    expect(status(dir, HUMAN).text).toContain("执行观测 1 条");
  }, 120_000);

  it("★ 观测挂在版本层 → 多次执行自然成为多版，无需新结构", async () => {
    // 第二条要在第一次 drain 之前投：drain 跑完实例就收进终态了
    const s = RunState.open(dir);
    try {
      s.runtime.send({ traceid: "job-1", node: "worker", port: "in" }, { task: "again" });
      s.persist();
    } finally {
      s.close();
    }
    await drain(dir, HUMAN, backend());
    expect(history(dir, HUMAN, "job-1/$exec").text).toContain("2 版");
  }, 120_000);
});

describe("★ 因果反查有出口了", () => {
  it("why 报出这条消息的前因", async () => {
    await drain(dir, HUMAN, backend());
    const s = RunState.open(dir, { readOnly: true });
    const produced = s.runtime.messages().find((m) => m.target.node === "sink");
    s.close();
    const r = why(dir, HUMAN, produced!.id);
    expect(r.code).toBe(0);
    expect(r.text).toContain("←");
  }, 120_000);

  it("起点消息说清楚是起点，不是空输出", async () => {
    const s = RunState.open(dir, { readOnly: true });
    const first = s.runtime.messages()[0];
    s.close();
    expect(why(dir, HUMAN, first!.id).text).toContain("没有记录在案的前因");
  });
});

describe("★ 沙箱保留：多开 agent 时现场留得住", () => {
  it("跑完沙箱还在，位置写进执行观测 —— 哪次执行对应哪个沙箱有据可查", async () => {
    await drain(dir, HUMAN, backend());
    const v = JSON.parse(show(dir, HUMAN, "job-1/$exec").text);
    expect(v.body.diagnostics.sandbox.retained).toBe(true);
    expect(existsSync(v.body.diagnostics.sandbox.path)).toBe(true);
    // 工作树还在，产出取得回来
    expect(existsSync(join(v.body.diagnostics.sandbox.path, "box", "workspace"))).toBe(true);
  }, 120_000);

  it("★ 沙箱名带 traceid —— 否则两个 run 的 exec-1 会撞名", async () => {
    await drain(dir, HUMAN, backend());
    const v = JSON.parse(show(dir, HUMAN, "job-1/$exec").text);
    expect(v.body.diagnostics.sandbox.path).toContain("job-1");
    expect(v.body.diagnostics.sandbox.path).toContain("exec-1");
  }, 120_000);

  it("多个 agent 各占一个沙箱，互不覆盖", async () => {
    const s = RunState.open(dir);
    try {
      s.runtime.send({ traceid: "job-1", node: "worker", port: "in" }, { task: "second" });
      s.persist();
    } finally {
      s.close();
    }
    await drain(dir, HUMAN, backend());

    const versions = JSON.parse(show(dir, HUMAN, "job-1/$exec@1").text);
    const second = JSON.parse(show(dir, HUMAN, "job-1/$exec@2").text);
    expect(versions.body.diagnostics.sandbox.path).not.toBe(second.body.diagnostics.sandbox.path);
    expect(existsSync(versions.body.diagnostics.sandbox.path)).toBe(true);
    expect(existsSync(second.body.diagnostics.sandbox.path)).toBe(true);
  }, 120_000);

  it("status 报出攒了几个 —— 没有自动回收，至少让人看得见", async () => {
    await drain(dir, HUMAN, backend());
    expect(status(dir, HUMAN).text).toMatch(/保留中的沙箱 1 个/);
  }, 120_000);

  it("retain: never 才删 —— 默认是留着", async () => {
    const s = new SandboxBackend({ runner: new LocalRunner(), retain: "never" });
    await drain(dir, HUMAN, s);
    const v = JSON.parse(show(dir, HUMAN, "job-1/$exec").text);
    expect(v.body.diagnostics.sandbox.retained).toBe(false);
    expect(existsSync(v.body.diagnostics.sandbox.path)).toBe(false);
  }, 120_000);
});
