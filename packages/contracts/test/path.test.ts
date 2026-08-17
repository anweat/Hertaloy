import { describe, expect, it } from "vitest";
import { Path, parsePath, isProjection } from "../src/path.js";

describe("Path —— servo 的最小路径子集", () => {
  it("接受 `$`、`.name`、`[n]`、`[*]`", () => {
    expect(Path.safeParse("$").success).toBe(true);
    expect(Path.safeParse("$.plan.tasks[0].specRef").success).toBe(true);
    expect(parsePath("$.tasks[0]")).toEqual([
      { kind: "key", name: "tasks" },
      { kind: "index", index: 0 },
    ]);
    expect(isProjection("$.tasks[*].id")).toBe(true);
    expect(isProjection("$.tasks[0].id")).toBe(false);
  });

  it("接受根数组、连续索引与下划线名称", () => {
    for (const good of ["$[0]", "$[*]", "$.a[0][*].b", "$._x", "$.a_1"]) {
      expect(Path.safeParse(good).success, good).toBe(true);
    }
  });

  it("拒绝一切控制流形式 —— filter 就是控制流，归策略节点（S2）", () => {
    for (const bad of ["$.a[?(@.x==1)]", "$..a", "$.a[1:3]", "length($.a)"]) {
      expect(Path.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("拒绝缺根、非法名称、索引与并集形式", () => {
    for (const bad of [
      "a.b",
      "$.",
      "$.1a",
      "$[01]",
      "$[-1]",
      "$[]",
      "$.a|b",
      "$['a']",
      "$.a,b",
    ]) {
      expect(Path.safeParse(bad).success, bad).toBe(false);
    }
  });
});
