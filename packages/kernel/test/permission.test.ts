/**
 * 批 C：DDL/DML/DQL 分层 + 前缀 scope 授权（FOUNDATION_V5.md §11）。
 *
 * 关键设计断言：**权限检查在控制面，不在内核签名里**。
 * Runtime 保持纯引擎 —— 它不知道谁在调它，也就不可能被"payload 里自称的 actor"骗到。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PermissionTable, parsePrincipal, scopeCovers } from "@nodeflow/contracts";
import { ControlPlane, OPERATION_CLASS } from "../src/control.js";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { AuthorizationError } from "../src/errors.js";

const leafSpec = {
  nodes: { w: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {},
  children: {},
  subscriptions: {},
};

const alice = parsePrincipal("human:alice");
const bot = parsePrincipal("agent:planner");
const stranger = parsePrincipal("human:mallory");

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let perms: PermissionTable;
let cp: ControlPlane;

beforeEach(() => {
  store = new ObjectStore();
  const leaf = registerContainerTemplate(store, "leaf", leafSpec);
  const root = registerContainerTemplate(
    store,
    "root",
    { nodes: {}, edges: {}, children: { k: { template: leaf } }, subscriptions: {} },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(root, "job-1");
  rt = new Runtime(store, reg);
  rt.registerHandler("noop", () => ({}));
  perms = new PermissionTable();
  cp = new ControlPlane(rt, reg, store, perms);
});

describe("默认拒绝", () => {
  it("空授权表下任何操作都被拒，错误说清缺什么", () => {
    expect(() => cp.spawn(alice, "job-1", "k", "c1")).toThrow(AuthorizationError);
    expect(() => cp.spawn(alice, "job-1", "k", "c1")).toThrow(
      /human:alice 无权对 `job-1` 执行 DML 类操作.*空表，默认拒绝/s,
    );
  });
});

describe("操作分三类，权限按类给", () => {
  it("给了 DQL 不等于给了 DML", () => {
    perms.grant({ principal: "human:alice", scope: "job-1", ops: ["DQL"] });

    expect(cp.subtree(alice, "job-1").map((i) => i.traceid)).toEqual(["job-1"]);
    expect(() => cp.spawn(alice, "job-1", "k", "c1")).toThrow(/执行 DML 类操作/);
  });

  it("给了 DML 不等于给了 DDL —— 改运行状态与改定义是两回事", () => {
    perms.grant({ principal: "human:alice", scope: "*", ops: ["DML", "DQL"] });

    cp.spawn(alice, "job-1", "k", "c1");
    expect(() => cp.define(alice, "newtpl", leafSpec)).toThrow(/执行 DDL 类操作/);
  });

  it("操作到类别的映射就是那张表，不散在各处 if 里", () => {
    expect(OPERATION_CLASS.define).toBe("DDL");
    expect(OPERATION_CLASS.truncate).toBe("DML");
    expect(OPERATION_CLASS.query).toBe("DQL");
  });
});

describe("scope 复用段边界前缀判定（第六次复用）", () => {
  it("★ 授权 job-1 覆盖子树，但不越到 job-10", () => {
    expect(scopeCovers("job-1", "job-1")).toBe(true);
    expect(scopeCovers("job-1", "job-1/coder-2")).toBe(true);
    expect(scopeCovers("job-1", "job-10")).toBe(false);
    expect(scopeCovers("job-1", "job-10/coder")).toBe(false);
    expect(scopeCovers("*", "任意")).toBe(true);
  });

  it("★ 行级安全：只授权自己那棵子树，碰不到别人的", () => {
    perms.grant({ principal: "human:alice", scope: "job-1", ops: ["DML", "DQL"] });
    cp.spawn(alice, "job-1", "k", "c1");

    // 同一棵树内可以
    cp.send(alice, { traceid: "job-1/c1", node: "w", port: "in" }, {});
    // 另一棵树不行
    expect(() => cp.truncate(alice, "job-2", "越界")).toThrow(/无权对 `job-2`/);
  });
});

describe("主体模式", () => {
  it("`kind:*` 授权整类主体；不同 kind 不互通", () => {
    perms.grant({ principal: "agent:*", scope: "job-1", ops: ["DQL"] });
    expect(cp.subtree(bot, "job-1")).toHaveLength(1);
    expect(() => cp.subtree(alice, "job-1")).toThrow(AuthorizationError);
  });

  it("`*` 是全权 —— 根容器 MCP 全权就是这么一条数据（G3）", () => {
    perms.grant({ principal: "*", scope: "*", ops: ["DDL", "DML", "DQL"] });
    cp.define(alice, "anything", leafSpec);
    cp.spawn(stranger, "job-1", "k", "c1");
    expect(cp.locks(bot, "job-1")).toHaveLength(1);
  });
});

describe("★ 权限是数据不是代码", () => {
  it("换策略只改授权表，内核与控制面代码不动", () => {
    perms.grant({ principal: "human:alice", scope: "job-1", ops: ["DQL"] });
    expect(() => cp.spawn(alice, "job-1", "k", "c1")).toThrow(AuthorizationError);

    perms.grant({ principal: "human:alice", scope: "job-1", ops: ["DML"] });
    expect(cp.spawn(alice, "job-1", "k", "c1").traceid).toBe("job-1/c1");
  });

  it("授权表可枚举 —— 观测与审计靠它", () => {
    perms.grant({ principal: "human:alice", scope: "job-1", ops: ["DML"] });
    perms.grant({ principal: "agent:*", scope: "*", ops: ["DQL"] });
    expect(perms.grants()).toHaveLength(2);
    expect(perms.decide(alice, "DML", "job-1").reason).toMatch(/由授权 human:alice · job-1 · DML/);
  });
});

describe("★ Runtime 仍是纯引擎", () => {
  it("绕过控制面直接用 Runtime 不受权限约束 —— 这是有意的分层", () => {
    // 内核不认识 principal，所以不可能被 payload 里自称的 actor 骗到；
    // 注入 principal 是可信边界（控制面 / 服务端 session）的职责。
    expect(() => rt.spawn("job-1", "k", "direct")).not.toThrow();
    expect(reg.has("job-1/direct")).toBe(true);
  });
});
