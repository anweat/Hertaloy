/**
 * `AgentSpec` 的形状 —— 从 contracts 搬过来的那半。
 *
 * 密钥那半留在了契约层（`NodeExecutionSpec`）：不写凭据是**对象库的规矩**
 * （§17.7），不是执行面的规矩。这里管的是执行面自己的字段：能力上界、
 * 工作区来源、profile。
 *
 * 这些仍然在**注册期**被拒 —— `registerContainerTemplate` 有一条校验缝，
 * CLI 把 `checkAgentSpec` 接进去。搬走不等于推到运行期。
 */

import { describe, expect, it } from "vitest";
import { AgentSpec, checkAgentSpec } from "../src/agent-spec.js";

describe("★ 节点能力：声明在模板上，不在工具面里", () => {
  it("能力可以逐节点声明 —— 此前是整个 run 一条", () => {
    const r = AgentSpec.safeParse({
      argv: ["claude"],
      capabilities: { network: "none", wallClockSeconds: 600, retain: "on-failure" },
    });
    expect(r.success).toBe(true);
  });

  it("★ 审计 agent 断网、研究 agent 放行 —— 这个此前表达不出来", () => {
    const audit = AgentSpec.safeParse({ argv: ["codex"], capabilities: { network: "none" } });
    const research = AgentSpec.safeParse({ argv: ["claude"], capabilities: { network: "open" } });
    expect(audit.success && research.success).toBe(true);
  });

  it("省略就是用 backend 缺省 —— 纯增字段，老模板不受影响", () => {
    const r = AgentSpec.safeParse({ argv: ["x"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.capabilities).toBeUndefined();
  });

  it("认不得的策略要拒 —— 别让打错的字悄悄变成缺省", () => {
    const r = AgentSpec.safeParse({ argv: ["x"], capabilities: { network: "hostt" } });
    expect(r.success).toBe(false);
  });

  it("多余字段要拒 —— 能力集是闭的", () => {
    const r = AgentSpec.safeParse({ argv: ["x"], capabilities: { gpu: true } });
    expect(r.success).toBe(false);
  });
});

describe("checkAgentSpec —— 注册期缝上挂的那个", () => {
  it("没问题就返回空清单", () => {
    expect(checkAgentSpec({ argv: ["x"] }, "nodes.a.agent")).toEqual([]);
  });

  it("★ 有问题就给人读得懂的一行，带路径", () => {
    const out = checkAgentSpec(
      { argv: ["x"], workspace: { source: "primary", from: "b" } },
      "nodes.a.agent",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^nodes\.a\.agent/);
    expect(out[0]).toMatch(/要么给 source|不能都给/);
  });

  it("argv 是必须的 —— 没有命令行就不是一条 agent 声明", () => {
    expect(checkAgentSpec({ profile: "codex" }, "nodes.a.agent")).not.toEqual([]);
  });
});
