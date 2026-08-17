import { describe, expect, it } from "vitest";
import { BindVar, PortVar, declaredBudget } from "../src/variable.js";

describe("BindVar —— 编译期绑定（来源只能是 card / literal）", () => {
  it("接受带上界的 card 长变量与无上界的 literal 短变量", () => {
    expect(
      BindVar.safeParse({ type: "long", card: "rules/py-strict@3", max_tokens: 4000 })
        .success,
    ).toBe(true);
    expect(BindVar.safeParse({ type: "short", literal: "./src" }).success).toBe(true);
  });

  it("接受带上界的 ref card 与 long literal", () => {
    expect(
      BindVar.safeParse({ type: "ref", card: "plan@2", max_tokens: 1500 }).success,
    ).toBe(true);
    expect(
      BindVar.safeParse({ type: "long", literal: "…", max_tokens: 100 }).success,
    ).toBe(true);
  });

  it("拒绝零个或两个来源", () => {
    expect(BindVar.safeParse({ type: "short" }).success).toBe(false);
    expect(
      BindVar.safeParse({ type: "short", literal: "./src", card: "prompt/coder@1" })
        .success,
    ).toBe(false);
  });

  it("拒绝路径来源 —— 编译期绑定不能从运行期 payload 取（位置即绑定时机）", () => {
    expect(BindVar.safeParse({ type: "short", from: "$.a" }).success).toBe(false);
  });

  it("拒绝非法预算与非精确 card 引用", () => {
    for (const max_tokens of [0, -1, 1.5]) {
      expect(
        BindVar.safeParse({ type: "long", literal: "x", max_tokens }).success,
      ).toBe(false);
    }
    expect(
      BindVar.safeParse({ type: "ref", card: "rules/py-strict", max_tokens: 100 })
        .success,
    ).toBe(false);
  });
});

describe("预算上界（不变量 B1）", () => {
  it("`long` / `ref` 缺 max_tokens 即拒绝", () => {
    expect(BindVar.safeParse({ type: "long", card: "prompt/coder@1" }).success).toBe(false);
    expect(PortVar.safeParse({ type: "ref", from: "$.specRef" }).success).toBe(false);
  });

  it("`short` 声明 max_tokens 即拒绝 —— 它不计入预算", () => {
    expect(
      BindVar.safeParse({ type: "short", literal: "x", max_tokens: 10 }).success,
    ).toBe(false);
  });

  it("declaredBudget 只累加声明了上界的变量", () => {
    expect(
      declaredBudget([
        { type: "long", max_tokens: 4000 },
        { type: "ref", max_tokens: 1500 },
        { type: "short" },
      ]),
    ).toBe(5500);
  });

  it("declaredBudget 对空变量集返回零", () => {
    expect(declaredBudget([])).toBe(0);
  });
});

describe("PortVar —— 运行期填充（来源只能是路径）", () => {
  it("接受路径来源", () => {
    expect(
      PortVar.safeParse({ type: "long", from: "$.testReport.failures", max_tokens: 2000 })
        .success,
    ).toBe(true);
  });

  it("拒绝 card / literal 来源", () => {
    expect(PortVar.safeParse({ type: "short", card: "prompt/coder@1" }).success).toBe(false);
  });

  it("拒绝非法路径与同时声明 from、card", () => {
    expect(
      PortVar.safeParse({ type: "short", from: "$.a[?(@.x==1)]" }).success,
    ).toBe(false);
    expect(
      PortVar.safeParse({ type: "short", from: "$.a", card: "prompt/coder@1" }).success,
    ).toBe(false);
  });
});
