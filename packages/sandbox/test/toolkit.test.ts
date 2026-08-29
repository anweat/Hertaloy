/**
 * 沙箱内的工具集。
 *
 * 判据不是"脚本写出去了"，是**agent 真的跑它、而且结果真的合成了 emissions**。
 * 装了没人调、或调了合成不出来，都是这个项目最熟悉的那种漏接。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, writeRequest, type SandboxPaths } from "../src/layout.js";
import {
  emissionsFromJournal,
  installToolkit,
  progressFromJournal,
  readJournal,
} from "../src/toolkit.js";

let root: string;
let paths: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hertaloy-tk-"));
  paths = createSandbox(root);
  installToolkit(paths);
  writeRequest(paths, { allowedEmitPorts: ["out", "err"] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 像 agent 那样调：cwd 是 workspace，路径相对它。 */
function tool(...args: readonly string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ["../.hertaloy/bin/hertaloy.mjs", ...args],
      { cwd: paths.workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out, err: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

describe("★ agent 真的能调它", () => {
  it("装出来的就是一个能跑的脚本", () => {
    expect(existsSync(join(paths.bin, "hertaloy.mjs"))).toBe(true);
    const r = tool("emit", "out", '{"ok":true}');
    expect(r.code).toBe(0);
    expect(r.out).toContain("已记录 emit out");
  });

  it("★ 路径相对 cwd —— agent 的 cwd 是 workspace，照着契约做必须成功", () => {
    // `emitPath` 那条教训：告诉 agent 的话本身错了，比没说更糟
    expect(tool("emit", "out", "{}").code).toBe(0);
  });

  it("元目录靠脚本自己的位置推出来，换了 cwd 也照样能跑", () => {
    const r = execFileSync(
      process.execPath,
      [join(paths.bin, "hertaloy.mjs"), "emit", "out", "{}"],
      { cwd: root, encoding: "utf8" },
    );
    expect(r).toContain("已记录");
  });
});

describe("★ 端口当场校验 —— 不必等跑完才拿 INVALID_OUTPUT", () => {
  it("越界端口立刻拒，并列出可用的", () => {
    const r = tool("emit", "ghost", "{}");
    expect(r.code).toBe(2);
    expect(r.err).toContain("不在允许列表");
    expect(r.err).toContain("out");
    expect(r.err).toContain("err");
  });

  it("载荷不是 JSON 也立刻拒", () => {
    const r = tool("emit", "out", "{不是json");
    expect(r.code).toBe(2);
    expect(r.err).toContain("不是合法 JSON");
  });

  it("被拒的调用不进日志 —— 没发生的事不该留记录", () => {
    tool("emit", "ghost", "{}");
    expect(readJournal(paths)).toEqual([]);
  });
});

describe("★ 顺序与合成", () => {
  it("序号靠文件名，每次调用都是新进程也不会乱", () => {
    tool("emit", "out", '{"n":1}');
    tool("progress", "1", "3", "第一步");
    tool("emit", "out", '{"n":2}');
    expect(readJournal(paths).map((e) => `${e.seq}:${e.op}`)).toEqual([
      "1:emit",
      "2:progress",
      "3:emit",
    ]);
  });

  it("★ 同一端口后写的赢", () => {
    tool("emit", "out", '{"n":1}');
    tool("emit", "out", '{"n":2}');
    expect(emissionsFromJournal(readJournal(paths))).toEqual({ out: { n: 2 } });
  });

  it("不同端口各自留下", () => {
    tool("emit", "out", '{"a":1}');
    tool("emit", "err", '{"b":2}');
    expect(emissionsFromJournal(readJournal(paths))).toEqual({ out: { a: 1 }, err: { b: 2 } });
  });

  it("一条 emit 都没有就返回 null —— 让调用方回落到 emit.json", () => {
    tool("progress", "1", "2");
    expect(emissionsFromJournal(readJournal(paths))).toBeNull();
  });
});

describe("★ 语义进度：只能上报，推不出来", () => {
  it("取最后一条", () => {
    tool("progress", "1", "7", "起步");
    tool("progress", "4", "7", "跑测试");
    expect(progressFromJournal(readJournal(paths))).toEqual({ done: 4, total: 7, note: "跑测试" });
  });

  it("没上报就是 null —— 不编一个出来", () => {
    tool("emit", "out", "{}");
    expect(progressFromJournal(readJournal(paths))).toBeNull();
  });

  it("参数不合法就拒，不写半条", () => {
    expect(tool("progress", "x", "7").code).toBe(2);
    expect(tool("progress", "1", "0").code).toBe(2);
    expect(readJournal(paths)).toEqual([]);
  });
});

describe("★ 坏数据不该让整份记录陪葬", () => {
  it("坏行跳过，其余照读", () => {
    tool("emit", "out", '{"good":1}');
    writeFileSync(join(paths.journal, "0002.emit.json"), "{不是json", "utf8");
    tool("emit", "err", '{"also":1}');
    const entries = readJournal(paths);
    // 坏的那条没了，好的两条都在 —— 丢掉全部等于丢掉排查现场
    expect(entries.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("认不出名字的文件不进日志", () => {
    writeFileSync(join(paths.journal, "README"), "x", "utf8");
    tool("emit", "out", "{}");
    expect(readJournal(paths)).toHaveLength(1);
  });
});

describe("★ 未知操作要报可用的", () => {
  it("列出 emit 与 progress", () => {
    const r = tool("publish", "findings", "{}");
    expect(r.code).toBe(2);
    expect(r.err).toContain("emit progress");
  });

  it("★ 没有 publish 是有意的 —— 走内网还是网关由端口声明决定（M1）", () => {
    // 给 agent 一个 publish 就等于让它挑传输方式，M1 当场降级成口头约定
    expect(readFileSync(join(paths.bin, "hertaloy.mjs"), "utf8")).not.toContain('"publish"');
  });
});

describe("★ 日志目录本来就在", () => {
  it("createSandbox 就建好了，工具不用自己 mkdir", () => {
    expect(readdirSync(paths.journal)).toEqual([]);
  });
});
