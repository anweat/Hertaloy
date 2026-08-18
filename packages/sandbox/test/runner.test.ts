/**
 * S2：运行器（FOUNDATION_V5.md §14.1 / §14.5）。
 *
 * 用 node 自己当"假 agent" —— 离线、跨平台、不依赖 docker/wsl。
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, destroySandbox, type SandboxPaths } from "../src/layout.js";
import { LocalRunner } from "../src/runner.js";

const runner = new LocalRunner();
let root: string;
let p: SandboxPaths;

/** 造一个假 agent 脚本，放在沙箱外（它是"工具"，不是 agent 的产出）。 */
function fakeAgent(body: string): string {
  const file = join(root, "agent.mjs");
  writeFileSync(file, body, "utf8");
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hertaloy-run-"));
  p = createSandbox(root);
});

afterEach(() => destroySandbox(root));

describe("跑一条命令行", () => {
  it("拿到退出码与 stdout/stderr", async () => {
    const agent = fakeAgent(
      `process.stdout.write("干完了"); process.stderr.write("提醒"); process.exit(0);`,
    );
    const out = await runner.run({ argv: ["node", agent], root });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("干完了");
    expect(out.stderr).toBe("提醒");
    expect(out.timedOut).toBe(false);
    expect(out.wallClockSeconds).toBeGreaterThan(0);
  });

  it("★ cwd 落在 workspace —— agent 看到的是工作树，不是契约目录", async () => {
    writeFileSync(join(p.workspace, "hello.txt"), "在工作区里", "utf8");
    const agent = fakeAgent(
      `import {readFileSync} from "node:fs"; process.stdout.write(readFileSync("hello.txt","utf8"));`,
    );
    const out = await runner.run({ argv: ["node", agent], root });
    expect(out.stdout).toBe("在工作区里");
  });

  it("非零退出码如实上报 —— 运行器不做语义判断", async () => {
    const agent = fakeAgent(`process.exit(3);`);
    const out = await runner.run({ argv: ["node", agent], root });
    expect(out.code).toBe(3);
  });

  it("命令不存在不抛异常，记进 stderr", async () => {
    const out = await runner.run({ argv: ["这个命令不存在-hertaloy"], root });
    expect(out.code).toBeNull();
    expect(out.stderr).toMatch(/启动失败/);
  });
});

describe("超时与取消", () => {
  it("★ 超时杀掉 —— 这是 wallClockSeconds 的真落点", async () => {
    const agent = fakeAgent(`setTimeout(() => process.exit(0), 60_000);`);
    const out = await runner.run({ argv: ["node", agent], root, timeoutSeconds: 0.4 });
    expect(out.timedOut).toBe(true);
    expect(out.wallClockSeconds).toBeLessThan(10);
  }, 20_000);

  it("★ 取消杀掉（best effort，气密性仍靠 generation fence）", async () => {
    const agent = fakeAgent(`setTimeout(() => process.exit(0), 60_000);`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await runner.run({ argv: ["node", agent], root, signal: ac.signal });
    expect(out.cancelled).toBe(true);
  }, 20_000);

  it("★ 杀的是进程树 —— 只杀父进程会留下孤儿继续写沙箱、继续烧钱", async () => {
    const marker = join(p.workspace, "orphan.txt");
    const agent = fakeAgent(`
      import {spawn} from "node:child_process";
      const child = spawn(process.execPath, ["-e", \`setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"孤儿还活着"),1200)\`], {stdio:"ignore"});
      setTimeout(() => process.exit(0), 60_000);
    `);
    const out = await runner.run({ argv: ["node", agent], root, timeoutSeconds: 0.4 });
    expect(out.timedOut).toBe(true);

    await new Promise((r) => setTimeout(r, 2200));
    let orphanWrote = true;
    try {
      readFileSync(marker, "utf8");
    } catch {
      orphanWrote = false;
    }
    expect(orphanWrote).toBe(false);
  }, 30_000);
});

describe("环境与隔离声明", () => {
  it("env 能注入（凭据靠它进沙箱）", async () => {
    const agent = fakeAgent(`process.stdout.write(process.env.HERTALOY_TEST ?? "无");`);
    const out = await runner.run({ argv: ["node", agent], root, env: { HERTALOY_TEST: "注入的" } });
    expect(out.stdout).toBe("注入的");
  });

  it("★ local 自报不是安全边界 —— 机器可读，一路透传到文档与告警", () => {
    expect(runner.isolates).toBe(false);
    expect(runner.kind).toBe("local");
  });
});
