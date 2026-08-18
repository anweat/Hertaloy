import { describe, expect, it } from "vitest";
import { diagnose, formatChecks } from "../src/doctor.js";

describe("hertaloy doctor", () => {
  const checks = diagnose();

  it("node 与 profiles 一定在", () => {
    expect(checks.find((c) => c.name === "node")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "profiles")?.detail).toMatch(/claude-code/);
  });

  it("★ local runner 自报不是安全边界 —— 这条要出现在人眼前，不只在类型里", () => {
    const local = checks.find((c) => c.name === "runner: local");
    expect(local?.detail).toMatch(/不是安全边界/);
  });

  it("缺 runner 不算阻塞 —— 只是少一种隔离强度", () => {
    for (const c of checks) {
      if (c.name.startsWith("runner:") || c.name.startsWith("git")) expect(c.blocking).toBe(false);
    }
  });

  it("报告里每条都有结论行", () => {
    const text = formatChecks(checks);
    expect(text).toMatch(/主链(可用|不可用)/);
    for (const c of checks) expect(text).toContain(c.name);
  });
});
