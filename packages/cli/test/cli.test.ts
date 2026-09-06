import { describe, expect, it } from "vitest";
import { run, validate } from "../src/commands.js";
import { BUILTIN_NAMES } from "../src/builtins.js";

const leaf = {
  nodes: {
    w: {
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

describe("hertaloy validate —— 干跑校验，不落库", () => {
  it.each([{ extends: 42 }, { extends: "base@1", override: [] }])("覆盖层先检查自身结构：%j", (spec) => {
    expect(validate(spec).code).toBe(1);
  });

  it("合法覆盖层明确提示合并校验尚需基定义", () => {
    const result = validate({ extends: "base@1", override: {} });
    expect(result.code).toBe(0);
    expect(result.text).toContain("需要基定义");
  });

  /**
   * `AgentSpec` 搬去 sandbox 之后，最容易出的事是"缝没通"：schema 还在，
   * 但没人在注册期调它，于是 `workspace` 写错要等到跑 agent 才发现。
   *
   * 这三条钉的就是那条线真的通着 —— `instances.ts` 那句"K5、E1 是同一类：
   * 实现在，路不通"记的是同一种失败。
   */
  it("★ agent 段的形状错在这里就被拒 —— 缝通到 validate", () => {
    const r = validate({
      nodes: {
        a: {
          kind: "handler",
          agent: { argv: ["claude"], workspace: { source: "primary", from: "b" } },
          ports: { in: { direction: "receive" } },
        },
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/nodes\.a\.agent/);
    expect(r.text).toMatch(/要么给 source|不能都给/);
  });

  it("★ 认不得的能力策略也拒 —— 别让打错的字悄悄变成缺省", () => {
    const r = validate({
      nodes: {
        a: {
          kind: "handler",
          agent: { argv: ["claude"], capabilities: { network: "opne" } },
          ports: { in: { direction: "receive" } },
        },
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/nodes\.a\.agent/);
  });

  it("合法的 agent 段照旧通过", () => {
    const r = validate({
      nodes: {
        a: {
          kind: "handler",
          agent: { argv: ["claude"], capabilities: { network: "none" } },
          ports: { in: { direction: "receive" } },
        },
      },
    });
    expect(r.code).toBe(0);
  });

  it("合法模板给出摘要", () => {
    const r = validate(leaf);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/合法：1 个节点/);
  });

  it("★ 非法模板给 LLM 可读错误 —— 这是 G1 自我修正内循环的出口", () => {
    const r = validate({
      nodes: { a: { kind: "handler", handler: "noop", ports: { out: { direction: "emit" } } } },
      edges: { e1: { from: { node: "a", port: "out" }, to: { node: "ghost", port: "in" } } },
    });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/节点 `ghost` 不存在。可用节点：a/);
  });

  it("结构非法也带路径", () => {
    const r = validate({ nodes: { a: { kind: "strategy", ports: {} } } });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/结构非法/);
  });
});

describe("hertaloy run —— 一次性场景", () => {
  it("★ 跑通汇聚：三条消息进来，读到满三份才产出", () => {
    const r = run({
      templates: [{ id: "root", kind: "root_config", spec: leaf }],
      root: { template: "root", id: "job-1" },
      send: [1, 2, 3].map((v) => ({
        traceid: "job-1",
        node: "w",
        port: "in",
        payload: { value: v, expect: 3 },
      })),
    });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/提交 3 次，失败 0 次/);
    expect(r.text).toMatch(/job-1\s+TERMINAL/);
    // 因果边逐条打印
    expect(r.text).toMatch(/job-1#3\s+w\s+\["msg-3"\]/);
  });

  it("未定义的根模板给出可用列表", () => {
    const r = run({ templates: [], root: { template: "ghost", id: "job-1" } });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/根容器引用了未定义的模板 `ghost`/);
  });

  it("注册失败直接报，不往下跑", () => {
    const r = run({
      templates: [
        {
          id: "root",
          kind: "root_config",
          spec: { nodes: {}, edges: { e: { from: { node: "x", port: "o" }, to: { node: "y", port: "i" } } } },
        },
      ],
      root: { template: "root", id: "job-1" },
    });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/注册失败.*节点 `x` 不存在/s);
  });

  it("报告末尾列出可用内置 handler", () => {
    const r = run({
      templates: [{ id: "root", kind: "root_config", spec: { nodes: {}, edges: {} } }],
      root: { template: "root", id: "job-1" },
    });
    expect(r.text).toMatch(new RegExp(`可用内置 handler：${BUILTIN_NAMES.join(", ")}`));
  });
});
