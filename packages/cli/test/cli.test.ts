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
  subscriptions: {},
};

describe("hertaloy validate —— 干跑校验，不落库", () => {
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
