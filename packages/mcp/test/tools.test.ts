/**
 * MCP 工具集验收。
 *
 * 重点不在"能不能跑通"，在**三条纪律是否真成立**：
 * 每个工具都过 ControlPlane、actor 客户端伪造不了、调用之间不常驻持锁。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunState, writePermissions } from "@nodeflow/state";
import { TOOLS, TOOL_NAMES, type ToolContext } from "../src/tools.js";

let dir: string;
const HUMAN: ToolContext["actor"] = { kind: "human", id: "local" };
const AGENT: ToolContext["actor"] = { kind: "agent", id: "planner" };

function ctx(actor = HUMAN): ToolContext {
  return { dir, actor };
}

function call(name: string, args: Record<string, unknown>, actor = HUMAN) {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`没有工具 ${name}`);
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { text: `参数非法：${parsed.error.issues.map((i) => i.message).join("；")}`, isError: true };
  }
  return tool.handler(ctx(actor), parsed.data as Record<string, unknown>);
}

/** 一个最小可跑的两节点流程。 */
const FLOW = {
  templates: [
    {
      id: "root",
      kind: "root_config",
      spec: {
        nodes: {
          gate: {
            kind: "handler",
            handler: "branch",
            ports: {
              in: {
                direction: "receive",
                servo: {
                  vars: {
                    cond: { type: "short", from: "$.ok" },
                    score: { type: "short", from: "$.score" },
                    expect: { type: "short", from: "$.expect" },
                  },
                },
              },
              then: { direction: "emit" },
              else: { direction: "emit" },
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
                    value: { type: "short", from: "$.score" },
                    expect: { type: "short", from: "$.expect" },
                  },
                },
              },
              done: { direction: "emit" },
            },
          },
        },
        edges: {
          e1: { from: { node: "gate", port: "then" }, to: { node: "sink", port: "got" } },
          e2: { from: { node: "gate", port: "else" }, to: { node: "sink", port: "got" } },
        },
        children: {},
        subscriptions: {},
      },
    },
  ],
  root: { template: "root", id: "job-1" },
  send: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-mcp-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("★ 纪律一：actor 由服务端注入，客户端伪造不了", () => {
  it("没有一个工具的参数 schema 里有 principal / actor / as 字段", () => {
    for (const tool of TOOLS) {
      const keys = Object.keys(tool.schema.shape);
      expect(keys).not.toContain("actor");
      expect(keys).not.toContain("principal");
      expect(keys).not.toContain("as");
    }
  });

  it("传进去也没用 —— 多余字段被 schema 丢掉，身份仍来自 ctx", () => {
    call("create_run", { scenario: FLOW });
    // 客户端试图夹带身份
    const r = call("get_status", { actor: "human:root" } as Record<string, unknown>, AGENT);
    // 仍按 AGENT 判权 —— 缺省表下 agent 无权
    expect(r.isError).toBe(true);
    expect(r.text).toContain("拒绝");
  });
});

describe("★ 纪律二：每个工具都过 ControlPlane", () => {
  beforeEach(() => {
    call("create_run", { scenario: FLOW });
  });

  it("缺省授权下 agent 一律被拒，并说清缺什么", () => {
    for (const name of ["get_status", "send_message", "truncate_instance"]) {
      const args =
        name === "send_message"
          ? { traceid: "job-1", node: "gate", port: "in", payload: {} }
          : name === "truncate_instance"
            ? { traceid: "job-1" }
            : {};
      const r = call(name, args, AGENT);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toContain("拒绝");
    }
  });

  it("配了授权表之后 agent 能读不能写", () => {
    writePermissions(dir, [
      { principal: "human:*", scope: "*", ops: ["DDL", "DML", "DQL"] },
      { principal: "agent:planner", scope: "job-1", ops: ["DQL"] },
    ]);
    expect(call("get_status", {}, AGENT).isError).toBe(false);
    expect(call("truncate_instance", { traceid: "job-1" }, AGENT).isError).toBe(true);
  });
});

describe("★ 纪律三：调用之间不常驻持锁", () => {
  it("一次工具调用之后，别的写者进得来", () => {
    call("create_run", { scenario: FLOW });
    // 工具调用已经关掉了状态目录 —— 拿得到锁就说明没常驻
    const other = RunState.open(dir);
    try {
      expect(other.registry.rootTrace).toBe("job-1");
    } finally {
      other.close();
    }
  });
});

describe("★ G1 自我修正内循环：错误是给模型读的", () => {
  it("validate_template 干跑不落库", () => {
    const r = call("validate_template", {
      spec: { nodes: {}, edges: {}, children: {}, subscriptions: {} },
    });
    expect(r.isError).toBe(false);
    // 没有落库：状态目录仍是空的
    expect(call("get_status", {}).text).toContain("还没有根容器");
  });

  it("★ 非法模板的错误说清了哪一项不对，够模型自己改", () => {
    const r = call("validate_template", {
      spec: {
        nodes: { a: { kind: "handler", handler: "noop", ports: {} } },
        edges: { bad: { from: { node: "a", port: "out" }, to: { node: "ghost", port: "in" } } },
        children: {},
        subscriptions: {},
      },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ghost|不存在|未声明/);
  });

  it("define_template 的注册期校验同样给人话", () => {
    const r = call("define_template", { id: "bad", spec: { nodes: "不是对象" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("非法");
  });
});

describe("★ 全链：建 run → 投消息 → 推进 → 读产物", () => {
  it("走完一整圈", () => {
    expect(call("create_run", { scenario: FLOW }).isError).toBe(false);
    expect(call("get_status", {}).text).toContain("job-1");

    expect(
      call("send_message", {
        traceid: "job-1",
        node: "gate",
        port: "in",
        payload: { ok: true, score: 90, expect: 1 },
      }).isError,
    ).toBe(false);

    const advanced = call("advance", {});
    expect(advanced.isError).toBe(false);
    expect(advanced.text).toContain("提交");

    const versions = call("list_versions", { objectId: "job-1/parts" });
    expect(versions.isError).toBe(false);
    expect(versions.text).toContain("90");
  });

  it("C1：第二次 create_run 被拒", () => {
    call("create_run", { scenario: FLOW });
    const again = call("create_run", { scenario: FLOW });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("已有根容器");
  });

  it("投给不存在的实例 → 报错并指路", () => {
    call("create_run", { scenario: FLOW });
    const r = call("send_message", { traceid: "job-9", node: "gate", port: "in" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("get_status");
  });

  it("截断之后实例进终态", () => {
    call("create_run", { scenario: FLOW });
    expect(call("truncate_instance", { traceid: "job-1", reason: "测试" }).isError).toBe(false);
    expect(call("get_status", {}).text).toContain("TERMINAL");
  });
});

describe("工具集本身", () => {
  it("每个工具都有标题与描述 —— 模型靠它选工具", () => {
    for (const t of TOOLS) {
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });

  it("工具名唯一", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("空状态目录上查询不炸", () => {
    expect(call("get_status", {}).isError).toBe(false);
    expect(call("explain_message", { messageId: "msg-1" }).isError).toBe(true);
  });
});
