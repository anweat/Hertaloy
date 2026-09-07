/**
 * ★ 按 id 查详情：授权顺序与四种"没有"。
 *
 * `executionId` / `messageId` 都不带 traceid，而授权按 traceid 前缀判。
 * 顺序只能是：先找到 → 拿它的 traceid → 授权。**找不到时按根授权** ——
 * 否则一个只有子树权限的主体能靠"存在/不存在"探别人子树里有什么。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { ControlPlane } from "../src/control.js";
import { BoundedAuthzLog } from "../src/authz-log.js";
import { AuthorizationError } from "../src/errors.js";
import { PermissionTable } from "@nodeflow/contracts";

const SPEC = {
  nodes: {
    w: {
      kind: "handler",
      handler: "noop",
      ports: { in: { direction: "receive", servo: { vars: {} } }, out: { direction: "emit" } },
    },
  },
  edges: {},
  children: { kids: { template: "", entry: { node: "w", port: "in" } } },
};

const HUMAN = { kind: "human", id: "local" } as const;
const AGENT = { kind: "agent", id: "bot" } as const;

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let control: ControlPlane;

beforeEach(() => {
  store = new ObjectStore();
  const child = registerContainerTemplate(store, "child", { ...SPEC, children: {} });
  const root = registerContainerTemplate(
    store,
    "root",
    { ...SPEC, children: { kids: { template: child, entry: { node: "w", port: "in" } } } },
    "root_config",
  );
  reg = new InstanceRegistry(store);
  reg.createRoot(root, "job");
  rt = new Runtime(store, reg);
  rt.registerHandler("noop", () => ({}));
  const permissions = new PermissionTable();
  permissions.grant({ principal: "human:*", scope: "*", ops: ["DDL", "DML", "DQL"] });
  control = new ControlPlane(rt, reg, store, permissions, { log: new BoundedAuthzLog() });
});

describe("★ 结构化义务有出口了", () => {
  it("给的是 {kind, holder, key}，不是中文文案", () => {
    rt.send({ traceid: "job", node: "w", port: "in" }, {});
    const list = control.obligations(HUMAN, "job");
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("kind");
    expect(list[0]).toHaveProperty("holder", "job");
    expect(list[0]).toHaveProperty("key");
    // 中文那份仍在，但它是渲染，不是协议
    expect(control.blockers(HUMAN, "job").join("")).toMatch(/[一-龥]/);
  });

  it("无权主体拿不到", () => {
    expect(() => control.obligations(AGENT, "job")).toThrow(AuthorizationError);
  });
});

describe("★ 按 id 查执行 / 消息", () => {
  it("查得到自己的", () => {
    const id = rt.send({ traceid: "job", node: "w", port: "in" }, { a: 1 });
    expect(control.message(HUMAN, id)?.target.node).toBe("w");
  });

  it("★ 不存在的 id：有权的人得到 undefined —— 缺席是答复，不是异常", () => {
    expect(control.execution(HUMAN, "exec-999")).toBeUndefined();
    expect(control.message(HUMAN, "msg-999")).toBeUndefined();
  });

  it("★ 无权的人得到「无权」而不是「没有」—— 存在性不是泄漏面", () => {
    const id = rt.send({ traceid: "job", node: "w", port: "in" }, {});
    // 存在的
    expect(() => control.message(AGENT, id)).toThrow(AuthorizationError);
    // 不存在的：同样是无权，分辨不出来 —— 这正是要的
    expect(() => control.message(AGENT, "msg-999")).toThrow(AuthorizationError);
    expect(() => control.execution(AGENT, "exec-999")).toThrow(AuthorizationError);
  });
});
