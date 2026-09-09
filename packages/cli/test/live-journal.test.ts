/**
 * ★ 执行中看得到节点在输出什么（S5）。
 *
 * 重点不是进度数字，是**它到这一刻为止在做什么/说什么** —— journal 的条目本身。
 *
 * journal 本来就是那份过程观测：已经落在磁盘、一次工具调用一个文件、自带条数与
 * 字节上限。只读方去读它**完全在提交路径之外**，观察失败不可能回滚提交。
 * 唯一的缺口是"沙箱在哪" —— 而那是 id 的确定性函数（`runner.locate`）。
 *
 * 这条覆盖的是「有 RUNNING 记录 + 沙箱里有 journal → 详情返回条目」这一段。
 * 「真 agent 确实往那儿写」由 sandbox 包的 toolkit 用例覆盖，不在这里重复。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import { LocalRunner, createSandbox } from "@nodeflow/sandbox";
import { execution } from "../src/state-commands.js";
import { containerOf, lastSegment } from "@nodeflow/contracts";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

const TEMPLATE = {
  nodes: {
    w: {
      kind: "handler",
      agent: { argv: ["never"] },
      ports: { in: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: {},
  children: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-live-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 造一条 RUNNING 记录 —— claim 住不 apply。 */
function claimOne(): { executionId: string; instance: string } {
  const s = RunState.open(dir, {
    backend: { async run() { throw new Error("不该被调用"); }, async cancel() {} },
  });
  try {
    const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
    s.registry.createRoot(ref, "job");
    s.runtime.send({ instance: "job/w", port: "in" }, {});
    const claimed = s.runtime.claimAgent();
    expect(claimed.kind).toBe("claimed");
    s.persist();
    const rec = s.runtime.records().find((r) => r.status === "RUNNING");
    return { executionId: rec!.executionId, instance: rec!.instance };
  } finally {
    s.close();
  }
}

it("★ 执行中：返回 agent 到这一刻的输出，不只是进度数字", () => {
  const rec = claimOne();
  // 沙箱在确定性路径上 —— 观察方按同一条规则算得出来
  const runner = new LocalRunner(join(dir, "sandboxes"));
  // 按 backend 的真实顺序：allocate（写下身份标记）→ createSandbox
  const paths = createSandbox(runner.allocate(`${rec.instance}/${rec.executionId}`));
  writeFileSync(
    join(paths.journal, "1.json"),
    JSON.stringify({ op: "read", path: "src/index.ts" }),
    "utf8",
  );
  writeFileSync(
    join(paths.journal, "2.json"),
    JSON.stringify({ op: "progress", done: 3, total: 10, note: "正在跑第三组测试" }),
    "utf8",
  );

  const r = execution(dir, HUMAN, rec.executionId, "local");
  expect(r.code).toBe(0);
  const d = r.data as { live: { available: boolean; entries: { op: string }[] } };

  expect(d.live.available).toBe(true);
  expect(d.live.entries.map((e) => e.op)).toEqual(["read", "progress"]);
  // ★ 内容本身在里面，不是被压成一个数字
  expect(r.text).toContain("src/index.ts");
  expect(r.text).toContain("正在跑第三组测试");
});

it("★ 不给 runner 就如实说读不到 —— 不显示成「没有内容」", () => {
  const rec = claimOne();
  const r = execution(dir, HUMAN, rec.executionId);
  const d = r.data as { live: { available: boolean; why: string } };
  expect(d.live.available).toBe(false);
  expect(d.live.why).toMatch(/--runner/);
  // 不能让人以为是 agent 没输出
  expect(r.text).not.toMatch(/还没有输出/);
});

it("沙箱不在（已回收 / 配错 workRoot）也是读不到，不是空", () => {
  const rec = claimOne();
  // 不建沙箱，直接查
  const r = execution(dir, HUMAN, rec.executionId, "local");
  const d = r.data as { live: { available: boolean; entries?: unknown[]; why?: string } };
  expect(d.live.available).toBe(false);
  expect(d.live.why).toContain("读不到");
  expect(r.text).not.toContain("还没有输出");
});

it("真实 CLI 把 --runner 传给现场查询", () => {
  const rec = claimOne();
  const runner = new LocalRunner(join(dir, "sandboxes"));
  createSandbox(runner.allocate(`${rec.instance}/${rec.executionId}`));
  const output = execFileSync(process.execPath, [
    "--import", "tsx", "src/main.ts", "execution", dir, rec.executionId,
    "--runner", "local", "--json",
  ], { encoding: "utf8" });
  expect(JSON.parse(output).live).toEqual({ available: true, entries: [] });
});

it("已结束的执行不查现场 —— 那时该看 $exec", () => {
  const rec = claimOne();
  const s = RunState.open(dir);
  try {
    s.runtime.failAgentResult(rec.executionId, "FAILED", "测试");
    s.persist();
  } finally {
    s.close();
  }
  const d = execution(dir, HUMAN, rec.executionId, "local").data as { live?: unknown };
  expect(d.live).toBeUndefined();
});

it("执行观测不重复计入用户产物", () => {
  const rec = claimOne();
  const s = RunState.open(dir);
  try {
    s.runtime.applyAgentResult(rec.executionId, { executionId: rec.executionId, termination: "DONE", emissions: {},
      diagnostics: { progress: { done: 1, total: 1 } },
      artifacts: [{ object_id: "reports/result.md", kind: "artifact", body: { text: "done" }, derived_from: [] }] });
    s.persist();
  } finally { s.close(); }
  const r = execution(dir, HUMAN, rec.executionId);
  expect(r.data).toHaveProperty("observation.available", true);
  expect(r.data).toHaveProperty("artifacts", [{ ref: "job/reports/result.md@1", kind: "artifact" }]);
});
