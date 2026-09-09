/**
 * 授权日志落盘 —— 从可变头搬到追加写文件之后该成立的事。
 *
 * 搬家买到两样，这里各自钉住：
 *
 *   1. **不再挤进每次全量重写的头** —— head.json 里一个字都没有
 *   2. **证据跨进程还在，而且不因为跑得久被挤掉** —— 追加写没有平方级写入，
 *      也就不需要为了省写入而截断历史
 *
 * 第 2 条是"事后答得出凭什么放行"这句话真正的意思：换一个进程还答得出。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "../src/run-state.js";
import { FileAuthzLog, authzLogPath } from "../src/authz-log.js";
import { headPath } from "../src/head.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-authz-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = {
  nodes: {
    work: {
      kind: "handler",
      handler: "noop",
      ports: { in: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: {},
  children: {},
};

const HUMAN = { kind: "human", id: "alice" } as const;
const AGENT = { kind: "agent", id: "bot" } as const;

/** 起一个进程，做几次决策，退出。 */
function session(fn: (s: RunState) => void): void {
  const state = RunState.open(dir);
  try {
    fn(state);
    state.persist();
  } finally {
    state.close();
  }
}

function seed(s: RunState): void {
  const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
  s.registry.createRoot(ref, "job-1");
  s.runtime.registerHandler("noop", () => ({}));
}

describe("决策落成文件", () => {
  it("放行与拒绝都记，序号单调", () => {
    session((s) => {
      seed(s);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
      expect(() =>
        s.control.send(AGENT, { instance: "job-1/work", port: "in" }, {}),
      ).toThrow();
    });

    const entries = new FileAuthzLog(dir, true).recent();
    expect(entries.map((e) => [e.actor, e.allowed])).toEqual([
      ["human:alice", true],
      ["agent:bot", false],
    ]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    // 拒绝的那条要说清为什么 —— 它往往就是"权限配错了"的现场
    expect(entries[1]?.reason).toMatch(/无权/);
  });

  it("★ head.json 里一个字都没有 —— 不再挤进每次全量重写的头", () => {
    session((s) => {
      seed(s);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
    });

    const head = readFileSync(headPath(dir), "utf8");
    expect(head).not.toContain("audit");
    expect(head).not.toContain("human:alice");
    // 而日志确实在别处
    expect(existsSync(authzLogPath(dir))).toBe(true);
  });
});

describe("★ 换一个进程还答得出", () => {
  it("上个进程的决策仍在，序号接着往下发", () => {
    session((s) => {
      seed(s);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
    });

    session((s) => {
      // 装载时就该看得见上一个进程留下的
      expect(s.authzLog.recent().map((e) => e.seq)).toEqual([1, 2]);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
      // ★ 不从头发号 —— 否则两条决策会共用一个序号，先后就读不出来了
      expect(s.authzLog.recent().map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    expect(new FileAuthzLog(dir, true).recent()).toHaveLength(3);
  });

  it("跑得久也不被挤掉 —— 追加写没有那个平方级，也就不必截断历史", () => {
    session((s) => {
      seed(s);
      for (let i = 0; i < 600; i += 1) {
        s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
      }
    });
    // 内存那版有界（500）；落盘这版没有那个理由，600 条一条不少
    const all = new FileAuthzLog(dir, true).recent(10_000);
    expect(all).toHaveLength(600);
    expect(all.at(-1)?.seq).toBe(600);
  });
});

describe("边界", () => {
  it("★ 只读打开不写日志 —— 那些命令不拿目录锁，写就是两个进程抢一个文件", () => {
    session((s) => {
      seed(s);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
    });

    const readOnly = RunState.open(dir, { readOnly: true });
    try {
      readOnly.control.subtree(HUMAN, "job-1"); // 一次 DQL 决策
    } finally {
      readOnly.close();
    }
    // 仍然只有先前那一条
    expect(new FileAuthzLog(dir, true).recent()).toHaveLength(1);
  });

  it("坏行不挡住整份日志 —— 跳过它，别让一条毁掉证据", () => {
    session((s) => {
      seed(s);
      s.control.send(HUMAN, { instance: "job-1/work", port: "in" }, {});
    });
    const path = authzLogPath(dir);
    writeFileSync(path, `${readFileSync(path, "utf8")}{ 这不是 JSON\n`, "utf8");

    const log = new FileAuthzLog(dir, true);
    expect(log.recent()).toHaveLength(1);
    expect(log.recent()[0]?.actor).toBe("human:alice");
  });

  it("没有日志文件时，recent 是空数组而不是抛", () => {
    expect(new FileAuthzLog(dir, true).recent()).toEqual([]);
  });
});
