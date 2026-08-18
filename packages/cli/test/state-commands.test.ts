/**
 * 面向人的命令 —— 全部作用在磁盘上的 run。
 *
 * 每个用例都跨命令调用（每次调用各自 open/close 状态目录），
 * 因为这些命令的全部意义就在于**跨进程**。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import { drain, history, send, show, status } from "../src/state-commands.js";

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
  subscriptions: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-cli-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"), "job-1");
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("status", () => {
  it("列出实例树与在途消息", () => {
    const r = status(dir);
    expect(r.code).toBe(0);
    expect(r.text).toContain("job-1");
    expect(r.text).toContain("OPEN");
    expect(r.text).toContain("在途消息 0 条");
  });

  it("空状态目录说得清楚，不是空输出", () => {
    const empty = mkdtempSync(join(tmpdir(), "hertaloy-empty-"));
    try {
      expect(status(empty).text).toContain("还没有根容器");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("★ send：人的放行走这条，不需要第二套审批机制", () => {
  it("投消息 → 落盘 → 换次调用 status 看得到", () => {
    expect(send(dir, "job-1", "gate", "in", { value: "a", expect: 2 }).code).toBe(0);
    expect(status(dir).text).toContain("在途消息 1 条");
  });

  it("投给不存在的实例 → 拒绝并指路", () => {
    const r = send(dir, "job-9", "gate", "in", {});
    expect(r.code).toBe(1);
    expect(r.text).toContain("hertaloy status");
  });

  it("失败的投递不落盘 —— 状态不该被一次错误命令改动", () => {
    send(dir, "job-9", "gate", "in", {});
    expect(status(dir).text).toContain("在途消息 0 条");
  });
});

describe("★ 全流程：投两次 → 推进 → 查资产", () => {
  it("两条消息各算一份，凑齐后汇聚（跨四次进程调用）", () => {
    send(dir, "job-1", "gate", "in", { value: "same", expect: 2 });
    send(dir, "job-1", "gate", "in", { value: "same", expect: 2 });
    const d = drain(dir);
    expect(d.code).toBe(0);
    expect(d.text).toContain("提交 2 次，失败 0 次");

    const h = history(dir, "job-1/parts");
    expect(h.code).toBe(0);
    expect(h.text).toContain("2 版");
  });
});

describe("show / history", () => {
  it("show 取最新版，show id@n 取指定版", () => {
    send(dir, "job-1", "gate", "in", { value: "x", expect: 9 });
    drain(dir);
    expect(JSON.parse(show(dir, "job-1/parts").text).version).toBe(1);
    expect(JSON.parse(show(dir, "job-1/parts@1").text).body.value).toBe("x");
  });

  it("对象不存在时报错而不是返回空", () => {
    expect(history(dir, "job-1/nope").code).toBe(1);
    expect(show(dir, "job-1/nope").code).toBe(1);
  });
});

describe("只读命令不拿锁（§17.8）", () => {
  it("写进程占着锁时，status 仍然能查", () => {
    const holder = RunState.open(dir);
    try {
      expect(status(dir).code).toBe(0);
      expect(show(dir, "job-1/nope").code).toBe(1); // 是"没这对象"，不是"拿不到锁"
    } finally {
      holder.close();
    }
  });

  it("写命令在锁被占时明确拒绝", () => {
    const holder = RunState.open(dir);
    try {
      expect(() => send(dir, "job-1", "gate", "in", {})).toThrow(/已被占用/);
    } finally {
      holder.close();
    }
  });
});
