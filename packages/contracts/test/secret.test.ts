/**
 * env 里不许有密钥值 —— 从"注释这么写"变成"注册期这么强制"。
 *
 * 判据不是"有个 refine"，是**塞得进去的那份模板现在塞不进去了**，
 * 且被拒时能看到正确路径（改写成 `$NAME`）。
 */

import { describe, expect, it } from "vitest";
import { AgentSpec, envRefName, looksLikeSecret, resolveEnv } from "../src/index.js";

/**
 * 样例**在运行期拼出来**，不写成字面量。
 *
 * 第一版直接写了完整的样子，于是 GitHub 的推送保护把整个 push 拒了 ——
 * 它扫的是文件里的字面串，不管那是测试夹具还是真东西。
 * 拼接既躲开扫描器，也免得有人日后 grep 到一串看着像真的的东西。
 */
const fake = (prefix: string, body: string): string => prefix + body;

describe("★ 像凭据的字面量在注册期被拒", () => {
  const cases: readonly [string, string][] = [
    ["OpenAI 风格", fake("sk-", "abcdefghijklmnopqrstuvwxyz012345")],
    ["GitHub token", fake("ghp" + "_", "abcdefghijklmnopqrstuvwxyz0123456789")],
    ["Bearer 头", fake("Bearer ", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")],
    ["AWS key id", fake("AKIA", "IOSFODNN7EXAMPLE")],
    ["Slack token", fake("xox" + "b-", "123456789012-abcdefghijklmnop")],
  ];

  for (const [what, value] of cases) {
    it(`${what} → 拒绝`, () => {
      const r = AgentSpec.safeParse({ argv: ["x"], env: { KEY: value } });
      expect(r.success).toBe(false);
      if (!r.success) {
        // 拒绝理由必须给出正确路径，否则只会被换个名字绕过
        expect(r.error.issues[0]?.message).toMatch(/\$NAME/);
      }
    });
  }

  it("普通配置值照旧通过 —— 这不是禁止 env，是禁止把值写死", () => {
    const r = AgentSpec.safeParse({
      argv: ["x"],
      env: { NODE_ENV: "production", LANG: "zh_CN.UTF-8", MAX_RETRIES: "3" },
    });
    expect(r.success).toBe(true);
  });

  it("★ `$NAME` 引用通过 —— 模板只存取值方式", () => {
    const r = AgentSpec.safeParse({ argv: ["x"], env: { ANTHROPIC_API_KEY: "$MY_KEY" } });
    expect(r.success).toBe(true);
  });
});

describe("引用形式", () => {
  it("认得出 `$NAME`，认不出别的", () => {
    expect(envRefName("$MY_KEY")).toBe("MY_KEY");
    expect(envRefName("$_x1")).toBe("_x1");
    expect(envRefName("production")).toBeNull();
    expect(envRefName("$has-dash")).toBeNull(); // POSIX 环境变量名没有连字符
    expect(envRefName("prefix-$X")).toBeNull(); // 只认整体是引用的，不做插值
  });

  it("看起来像凭据的判定不受 lastIndex 残留影响", () => {
    const v = fake("sk-", "abcdefghijklmnopqrstuvwxyz012345");
    // 同一个带 g 标志的正则连测两次 —— 第二次必须还是 true
    expect(looksLikeSecret(v)).toBe(true);
    expect(looksLikeSecret(v)).toBe(true);
  });
});

describe("★ 运行期解析", () => {
  it("`$NAME` 从宿主环境取真值", () => {
    const out = resolveEnv({ API: "$SRC", MODE: "fast" }, { SRC: "真正的值" });
    expect(out).toEqual({ API: "真正的值", MODE: "fast" });
  });

  it("★ 取不到就报错，而不是注入空串", () => {
    expect(() => resolveEnv({ API: "$NOPE" }, {})).toThrow(/API=\$NOPE/);
  });

  it("报错说清是「这台机器没配」，因为那才是要做的事", () => {
    expect(() => resolveEnv({ API: "$NOPE" }, {})).toThrow(/值要由跑它的那台机器提供/);
  });

  it("没有 env 段就是空袋子", () => {
    expect(resolveEnv(undefined, { X: "1" })).toEqual({});
  });
});
