/**
 * 全链验收：从场景文件建 run → 条件分发 → 边 → 汇聚 → 契约拦截。
 *
 * 全部**跨进程走 CLI**（每条命令各自 open/close 状态目录），
 * 因为这套东西的意义就在于跨进程。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drain, history, init, send, show, status } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-wf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 载荷 schema —— 端口的入站契约。 */
const TASK_CONTRACT = {
  id: "task-contract",
  kind: "message_contract",
  spec: { type: "object", required: ["score"], properties: { score: { type: "number" } } },
};

/**
 * 审核流：入口按条件分发，两条边分别去 pass / fix，最后汇聚。
 *
 * ```
 *            ┌── then ──→ pass ──┐
 *   gate ────┤                   ├──→ sink
 *            └── else ──→ fix ───┘
 * ```
 */
function reviewFlow(withContract: boolean): Record<string, unknown> {
  const inPort: Record<string, unknown> = {
    direction: "receive",
    servo: {
      vars: {
        cond: { type: "short", from: "$.ok" },
        score: { type: "short", from: "$.score" },
        expect: { type: "short", from: "$.expect" },
      },
    },
  };
  if (withContract) inPort.contract = "task-contract@1";

  const passthrough = (): Record<string, unknown> => ({
    kind: "handler",
    handler: "echo",
    ports: {
      in: {
        direction: "receive",
        servo: {
          vars: {
            score: { type: "short", from: "$.score" },
            expect: { type: "short", from: "$.expect" },
          },
        },
      },
      out: { direction: "emit" },
    },
  });

  return {
    templates: [
      ...(withContract ? [TASK_CONTRACT] : []),
      {
        id: "root",
        kind: "root_config",
        spec: {
          nodes: {
            gate: {
              kind: "handler",
              handler: "branch",
              ports: { in: inPort, then: { direction: "emit" }, else: { direction: "emit" } },
            },
            pass: passthrough(),
            fix: passthrough(),
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
          // 「条件边」= 每个出端口一条**普通**边。条件在节点里，不在边上。
          edges: {
            e_then: { from: { node: "gate", port: "then" }, to: { node: "pass", port: "in" } },
            e_else: { from: { node: "gate", port: "else" }, to: { node: "fix", port: "in" } },
            e_pass: { from: { node: "pass", port: "out" }, to: { node: "sink", port: "got" } },
            e_fix: { from: { node: "fix", port: "out" }, to: { node: "sink", port: "got" } },
          },
          children: {},
          subscriptions: {},
        },
      },
    ],
    root: { template: "root", id: "job-1" },
    send: [],
  };
}

describe("★ hertaloy init：从命令行建持久化 run", () => {
  it("建根 + 注册模板，之后 status 看得到", () => {
    const r = init(dir, HUMAN, reviewFlow(false));
    expect(r.code).toBe(0);
    expect(r.text).toContain("已建 run job-1");
    expect(status(dir, HUMAN).text).toContain("job-1");
  });

  it("C1：一个状态目录一个根，第二次 init 被拒", () => {
    init(dir, HUMAN, reviewFlow(false));
    const again = init(dir, HUMAN, reviewFlow(false));
    expect(again.code).toBe(1);
    expect(again.text).toContain("已有根容器");
  });

  it("根引用了未定义的模板 → 拒绝并列出已定义的", () => {
    const r = init(dir, HUMAN, { templates: [], root: { template: "nope" } });
    expect(r.code).toBe(1);
    expect(r.text).toContain("未定义的模板");
  });

  it("★ 边指向不存在的节点 → 注册期就拦下，不落库", () => {
    const bad = reviewFlow(false) as {
      templates: { spec: { edges: Record<string, unknown> } }[];
    };
    bad.templates[0]!.spec.edges.ghost = {
      from: { node: "gate", port: "then" },
      to: { node: "nowhere", port: "in" },
    };
    const r = init(dir, HUMAN, bad);
    expect(r.code).toBe(1);
    expect(r.text).toContain("注册失败");
    // 真的没落库
    expect(status(dir, HUMAN).text).toContain("还没有根容器");
  });
});

describe("★ 条件分发：条件在节点里，不在边上", () => {
  it("cond 为真 → 走 then 边 → pass", async () => {
    init(dir, HUMAN, reviewFlow(false));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, score: 90, expect: 1 });
    const d = await drain(dir, HUMAN);
    expect(d.code).toBe(0);
    expect(show(dir, HUMAN, "job-1/parts").text).toContain("90");
  });

  it("cond 为假 → 走 else 边 → fix", async () => {
    init(dir, HUMAN, reviewFlow(false));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: false, score: 30, expect: 1 });
    await drain(dir, HUMAN);
    expect(show(dir, HUMAN, "job-1/parts").text).toContain("30");
  });

  it("★ 两条分支各走各的，汇聚点两份都收到", async () => {
    init(dir, HUMAN, reviewFlow(false));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, score: 90, expect: 2 });
    send(dir, HUMAN, "job-1", "gate", "in", { ok: false, score: 30, expect: 2 });
    await drain(dir, HUMAN);

    const h = history(dir, HUMAN, "job-1/parts");
    expect(h.text).toContain("2 版");
    expect(h.text).toContain("90");
    expect(h.text).toContain("30");
  });

  it("链路走完之后实例自然终止", async () => {
    init(dir, HUMAN, reviewFlow(false));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, score: 90, expect: 1 });
    await drain(dir, HUMAN);
    expect(status(dir, HUMAN).text).toContain("TERMINAL");
  });
});

describe("★ 输入契约：不合规的载荷进不了端口", () => {
  it("缺必填字段 → 提交失败并说清缺什么", async () => {
    init(dir, HUMAN, reviewFlow(true));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, expect: 1 });
    const d = await drain(dir, HUMAN);
    expect(d.code).toBe(1);
    expect(d.text).toContain("契约");
  });

  it("类型不符 → 同样被拦", async () => {
    init(dir, HUMAN, reviewFlow(true));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, score: "高分", expect: 1 });
    expect((await drain(dir, HUMAN)).code).toBe(1);
  });

  it("合规载荷正常通过", async () => {
    init(dir, HUMAN, reviewFlow(true));
    send(dir, HUMAN, "job-1", "gate", "in", { ok: true, score: 90, expect: 1 });
    expect((await drain(dir, HUMAN)).code).toBe(0);
  });
});

describe("★ 端口白名单：编不出没声明的分支", () => {
  function routeFlow(): Record<string, unknown> {
    return {
      templates: [
        {
          id: "root",
          kind: "root_config",
          spec: {
            nodes: {
              r: {
                kind: "handler",
                handler: "route",
                ports: {
                  in: {
                    direction: "receive",
                    servo: { vars: { key: { type: "short", from: "$.key" } } },
                  },
                  default: { direction: "emit" },
                },
              },
            },
            edges: {},
            children: {},
            subscriptions: {},
          },
        },
      ],
      root: { template: "root", id: "job-1" },
      send: [],
    };
  }

  it("选了未声明的端口 → 失败，不是悄悄丢", async () => {
    init(dir, HUMAN, routeFlow());
    send(dir, HUMAN, "job-1", "r", "in", { key: "ghost" });
    const d = await drain(dir, HUMAN);
    expect(d.code).toBe(1);
    expect(d.text).toMatch(/未声明|端口/);
  });

  it("选了声明过的端口就正常", async () => {
    init(dir, HUMAN, routeFlow());
    send(dir, HUMAN, "job-1", "r", "in", { key: "default" });
    expect((await drain(dir, HUMAN)).code).toBe(0);
  });
});
