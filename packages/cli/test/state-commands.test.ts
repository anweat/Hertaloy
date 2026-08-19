/**
 * 面向人的命令 —— 全部作用在磁盘上的 run。
 *
 * 每个用例都跨命令调用（每次调用各自 open/close 状态目录），
 * 因为这些命令的全部意义就在于**跨进程**。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState, writePermissions } from "@nodeflow/state";
import { drain, history, resources, send, show, status, truncate } from "../src/state-commands.js";

/** 缺省权限表下的人类主体 —— 全权。 */
const HUMAN = { kind: "human", id: "local" } as const;
const AGENT = { kind: "agent", id: "coder-1" } as const;

let dir: string;

const TEMPLATE = {
  nodes: {
    gate: {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-cli-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"), "job-1");
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("status", () => {
  it("列出实例树与在途消息", () => {
    const r = status(dir, HUMAN);
    expect(r.code).toBe(0);
    expect(r.text).toContain("job-1");
    expect(r.text).toContain("OPEN");
    expect(r.text).toContain("在途消息 0 条");
  });

  it("空状态目录说得清楚，不是空输出", () => {
    const empty = mkdtempSync(join(tmpdir(), "hertaloy-empty-"));
    try {
      expect(status(empty, HUMAN).text).toContain("还没有根容器");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("★ send：人的放行走这条，不需要第二套审批机制", () => {
  it("投消息 → 落盘 → 换次调用 status 看得到", () => {
    expect(send(dir, HUMAN, "job-1", "gate", "in", { value: "a", expect: 2 }).code).toBe(0);
    expect(status(dir, HUMAN).text).toContain("在途消息 1 条");
  });

  it("投给不存在的实例 → 拒绝并指路", () => {
    const r = send(dir, HUMAN, "job-9", "gate", "in", {});
    expect(r.code).toBe(1);
    expect(r.text).toContain("hertaloy status");
  });

  it("失败的投递不落盘 —— 状态不该被一次错误命令改动", () => {
    send(dir, HUMAN, "job-9", "gate", "in", {});
    expect(status(dir, HUMAN).text).toContain("在途消息 0 条");
  });
});

describe("★ 全流程：投两次 → 推进 → 查资产", () => {
  it("两条消息各算一份，凑齐后汇聚（跨四次进程调用）", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "same", expect: 2 });
    send(dir, HUMAN, "job-1", "gate", "in", { value: "same", expect: 2 });
    const d = await drain(dir, HUMAN);
    expect(d.code).toBe(0);
    expect(d.text).toContain("提交 2 次，失败 0 次");

    const h = history(dir, HUMAN, "job-1/parts");
    expect(h.code).toBe(0);
    expect(h.text).toContain("2 版");
  });
});

describe("show / history", () => {
  it("show 取最新版，show id@n 取指定版", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "x", expect: 9 });
    await drain(dir, HUMAN);
    expect(JSON.parse(show(dir, HUMAN, "job-1/parts").text).version).toBe(1);
    expect(JSON.parse(show(dir, HUMAN, "job-1/parts@1").text).body.value).toBe("x");
  });

  it("对象不存在时报错而不是返回空", () => {
    expect(history(dir, HUMAN, "job-1/nope").code).toBe(1);
    expect(show(dir, HUMAN, "job-1/nope").code).toBe(1);
  });
});

describe("只读命令不拿锁（§17.8）", () => {
  it("写进程占着锁时，status 仍然能查", () => {
    const holder = RunState.open(dir);
    try {
      expect(status(dir, HUMAN).code).toBe(0);
      expect(show(dir, HUMAN, "job-1/nope").code).toBe(1); // 是"没这对象"，不是"拿不到锁"
    } finally {
      holder.close();
    }
  });

  it("写命令在锁被占时明确拒绝", () => {
    const holder = RunState.open(dir);
    try {
      expect(() => send(dir, HUMAN, "job-1", "gate", "in", {})).toThrow(/已被占用/);
    } finally {
      holder.close();
    }
  });
});

describe("★ truncate：卡住的 run 杀得掉（K3）", () => {
  it("截断后实例进终态，在途消息被丢弃", () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "a", expect: 99 });
    const r = truncate(dir, HUMAN, "job-1", "测试");
    expect(r.code).toBe(0);
    expect(r.text).toContain("丢弃消息 1 条");
    expect(status(dir, HUMAN).text).toContain("TERMINAL");
  });

  it("截断不存在的实例 → 拒绝", () => {
    expect(truncate(dir, HUMAN, "job-9", "x").code).toBe(1);
  });
});

describe("★ 权限层真的在起作用（K2）", () => {
  it("缺省表下 agent 被拒 —— 第一不变量的默认值", () => {
    const r = status(dir, AGENT);
    expect(r.code).toBe(1);
    expect(r.text).toContain("拒绝");
    expect(r.text).toContain("agent:coder-1");
  });

  it("拒绝理由里列出当前授权 —— 人得看得见缺什么才改得动配置", () => {
    expect(send(dir, AGENT, "job-1", "gate", "in", {}).text).toContain("human:*");
  });

  it("agent 的写操作同样被拒，且状态没被改动", () => {
    expect(truncate(dir, AGENT, "job-1", "x").code).toBe(1);
    expect(status(dir, HUMAN).text).toContain("OPEN");
  });

  it("status 报出权限表是配置来的还是缺省的", () => {
    expect(status(dir, HUMAN).text).toContain("缺省（人类全权，agent 无权）");
  });

  it("配了 permissions.json 就按文件来 —— 授权后 agent 能查自己的子树", () => {
    writePermissions(dir, [
      { principal: "human:*", scope: "*", ops: ["DDL", "DML", "DQL"] },
      { principal: "agent:coder-1", scope: "job-1", ops: ["DQL"] },
    ]);
    const r = status(dir, AGENT);
    expect(r.code).toBe(0);
    expect(r.text).toContain("permissions.json");
    // 但写操作仍然没给
    expect(truncate(dir, AGENT, "job-1", "x").code).toBe(1);
  });

  it("授权作用域按段边界判定 —— job-1 不覆盖 job-10", () => {
    writePermissions(dir, [{ principal: "agent:coder-1", scope: "job-10", ops: ["DQL"] }]);
    expect(status(dir, AGENT).code).toBe(1);
  });

  it("permissions.json 有一条写坏 → 整表拒绝，不是跳过坏的用好的", () => {
    writeFileSync(
      join(dir, "permissions.json"),
      JSON.stringify({ format: 1, grants: [{ principal: "nope", scope: "*", ops: ["DQL"] }] }),
      "utf8",
    );
    expect(() => status(dir, HUMAN)).toThrow(/第 1 条授权非法/);
  });
});

describe("★ hertaloy resources：动态上载", () => {
  it("空表时说清怎么登记", () => {
    const r = resources(dir, "list", []);
    expect(r.code).toBe(0);
    expect(r.text).toContain("没有登记任何资源");
    expect(r.text).toContain("add");
  });

  it("登记之后列得出来，并说明模板里怎么用", () => {
    const added = resources(dir, "add", ["primary", "git", "/repos/app", "主仓库"]);
    expect(added.code).toBe(0);
    expect(added.text).toContain("路径不进模板");

    const list = resources(dir, "list", []);
    expect(list.text).toContain("primary");
    expect(list.text).toContain("/repos/app");
    expect(list.text).toContain("主仓库");
  });

  it("参数不全就给用法，不猜", () => {
    expect(resources(dir, "add", ["onlyname"]).code).toBe(1);
    expect(resources(dir, "add", ["onlyname"]).text).toContain("用法");
  });

  it("种类不认识 → 拒绝并说清有哪几种", () => {
    const r = resources(dir, "add", ["x", "ftp", "/p"]);
    expect(r.code).toBe(1);
  });

  it("删得掉", () => {
    resources(dir, "add", ["a", "dir", "/x"]);
    expect(resources(dir, "remove", ["a"]).code).toBe(0);
    expect(resources(dir, "list", []).text).toContain("没有登记任何资源");
  });
});
