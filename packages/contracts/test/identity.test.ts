import { describe, expect, it } from "vitest";
import {
  Ref,
  TraceId,
  Principal,
  parseRef,
  formatRef,
  parsePrincipal,
  formatPrincipal,
  isDescendantOf,
  isRootTrace,
  parentTrace,
  childTrace,
  traceSegments,
} from "../src/identity.js";

describe("Ref —— 精确版本引用（不变量 V4）", () => {
  it("接受 `object_id@N`，object_id 可含 `/`", () => {
    expect(Ref.safeParse("plan@1").success).toBe(true);
    expect(Ref.safeParse("rules/py-strict@3").success).toBe(true);
    expect(parseRef("rules/py-strict@3")).toEqual({
      objectId: "rules/py-strict",
      version: 3,
    });
    expect(formatRef("plan", 2)).toBe("plan@2");
  });

  it("拒绝任何非精确形式", () => {
    for (const bad of ["plan", "plan@", "plan@0", "plan@latest"]) {
      expect(Ref.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("拒绝前导零、非整数与非法分隔形式", () => {
    for (const bad of [
      "plan@01",
      "plan@-1",
      "a@1@2",
      "@1",
      "plan@1.5",
      "plan@ 1",
      "",
    ]) {
      expect(Ref.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("接受合法的精确版本引用", () => {
    for (const good of ["a@1", "graph_template/export-flow@12", "rules/py-strict@999"]) {
      expect(Ref.safeParse(good).success, good).toBe(true);
    }
  });

  it("parseRef 拒绝多个版本分隔符", () => {
    expect(() => parseRef("a@1@2")).toThrow();
  });
});

describe("TraceId —— 实例路径（不变量 C2）", () => {
  it("接受 `/` 分隔的小写路径，并能拆装", () => {
    expect(TraceId.safeParse("job-1/coder-2/review-1").success).toBe(true);
    expect(traceSegments("job-1/coder-2")).toEqual(["job-1", "coder-2"]);
    expect(isRootTrace("job-1")).toBe(true);
    expect(isRootTrace("job-1/coder-2")).toBe(false);
    expect(parentTrace("job-1/coder-2")).toBe("job-1");
    expect(parentTrace("job-1")).toBeNull();
    expect(childTrace("job-1", "coder-2")).toBe("job-1/coder-2");
  });

  it("拒绝非法段", () => {
    for (const bad of ["Job-1", "job_1", "/job-1", "job-1/"]) {
      expect(TraceId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("拒绝非法连字符、分隔符、空白与大写形式", () => {
    for (const bad of ["-job", "job-", "job//coder", "job 1", "", "JOB"]) {
      expect(TraceId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("接受单段与多级小写路径", () => {
    for (const good of ["a", "a/b/c/d/e"]) {
      expect(TraceId.safeParse(good).success, good).toBe(true);
    }
  });

  // ★ Task 1 明确要求：前缀查询不得把 job-1 与 job-10 混淆
  it("前缀匹配落在段边界上，不是朴素 startsWith", () => {
    expect(isDescendantOf("job-1/coder-2", "job-1")).toBe(true);
    expect(isDescendantOf("job-1", "job-1")).toBe(true);
    expect(isDescendantOf("job-10", "job-1")).toBe(false);
    expect(isDescendantOf("job-10/coder-2", "job-1")).toBe(false);
    expect(isDescendantOf("job-1", "job-1/coder-2")).toBe(false);
  });

  it("相似段名与其他根路径不属于目标后代", () => {
    expect(isDescendantOf("job-1a", "job-1")).toBe(false);
    expect(isDescendantOf("job-2/x", "job-1")).toBe(false);
  });
});

describe("Principal —— 可信边界注入（§11）", () => {
  it("接受 kind:id，id 可含 `:`", () => {
    expect(parsePrincipal("human:alice")).toEqual({ kind: "human", id: "alice" });
    expect(parsePrincipal("service:urn:acct:1")).toEqual({
      kind: "service",
      id: "urn:acct:1",
    });
    expect(formatPrincipal({ kind: "agent", id: "planner" })).toBe("agent:planner");
  });

  it("拒绝未知 kind、空 id 与无冒号形式", () => {
    for (const bad of ["alice", "admin:alice", "human:", ":alice"]) {
      expect(() => parsePrincipal(bad), bad).toThrow();
    }
  });

  it("拒绝 id 空白、kind 大写与空主体形式", () => {
    for (const bad of ["human:a b", "HUMAN:alice", ":", ""]) {
      expect(() => parsePrincipal(bad), bad).toThrow();
    }
  });

  it("接受 system 与 agent 主体", () => {
    expect(parsePrincipal("system:kernel")).toEqual({ kind: "system", id: "kernel" });
    expect(parsePrincipal("agent:planner")).toEqual({ kind: "agent", id: "planner" });
  });

  it("schema 本身不认字符串形式 —— 解析必须显式经过可信边界", () => {
    expect(Principal.safeParse("human:alice").success).toBe(false);
    expect(Principal.safeParse({ kind: "human", id: "alice" }).success).toBe(true);
  });
});

describe("★ 内核保留对象必须引用得到", () => {
  it("`$` 前缀的保留名是合法 Ref —— 存得进去就得引用得到", () => {
    expect(Ref.safeParse("job-1/$run@1").success).toBe(true);
    expect(Ref.safeParse("job-1/coder-1/$exec@12").success).toBe(true);
  });

  it("用户资产名仍然引用得到", () => {
    expect(Ref.safeParse("job-1/result@3").success).toBe(true);
    expect(Ref.safeParse("rules/py-strict@1").success).toBe(true);
  });

  it("版本仍然必填且无前导零", () => {
    expect(Ref.safeParse("job-1/$exec").success).toBe(false);
    expect(Ref.safeParse("job-1/$exec@01").success).toBe(false);
  });
});
