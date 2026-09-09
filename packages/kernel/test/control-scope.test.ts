import { describe, expect, it } from "vitest";
import { PermissionTable } from "@nodeflow/contracts";
import { ControlPlane } from "../src/control.js";
import { BoundedAuthzLog } from "../src/authz-log.js";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

function setup(scope: string, mode = "") {
  const store = new ObjectStore();
  const registry = new InstanceRegistry(store);
  const leaf = registerContainerTemplate(store, "leaf", { nodes: {
    sync: { kind: "handler", handler: "forward", ports: {
      in: { direction: "receive" }, out: { direction: "emit" },
    } },
    sink: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } },
    agent: { kind: "handler", agent: { argv: ["unused"] }, ports: { in: { direction: "receive" } } },
  }, edges: { e: { from: { node: "sync", port: "out" }, to: { node: "sink", port: "in" } } } });
  registry.createRoot(registerContainerTemplate(store, "root", {
    nodes: {}, children: { leaves: { template: leaf } },
  }), "job");
  let runtime = new Runtime(store, registry, { backend: {
    async run(r) { return { executionId: r.executionId, termination: "DONE", emissions: {} }; },
    async cancel() {},
  } });
  runtime.spawn("job", "leaves", "a");
  runtime.spawn("job", "leaves", "b");
  runtime.spawn("job", "leaves", "c");
  runtime.registerHandler("noop", () => ({}));
  runtime.registerHandler("forward", () => ({ out: {} }));
  runtime.send({ instance: "job/b/sync", port: "in" }, {});
  runtime.send({ instance: "job/b/agent", port: "in" }, {});
  if (mode === "reconcile") {
    expect(runtime.claimAgent().kind).toBe("claimed");
    const snapshot = runtime.snapshot();
    runtime = new Runtime(store, registry);
    runtime.restore(snapshot);
    expect(runtime.orphanedExecutions()).toHaveLength(1);
  }
  if (mode === "causesOf") {
    runtime.step();
    expect(runtime.causesOf("msg-3")).toEqual(["msg-1"]);
  }
  const permissions = new PermissionTable();
  permissions.grant({ principal: "agent:limited", scope, ops: ["DML", "DQL"] });
  const control = new ControlPlane(runtime, registry, store, permissions, { log: new BoundedAuthzLog() });
  return { control, runtime, registry, store };
}

const actor = { kind: "agent", id: "limited" } as const;
const operations = ["run", "runAgents", "settleAll", "reconcile", "causesOf"] as const;
describe("全局操作须按实际根授权，并明确拒绝子树参数", () => {
  it.each(operations)("仅有子树权限不能通过 %s 访问整棵树", async (op) => {
    const { control, runtime, registry, store } = setup("job/a", op);
    const before = { rt: runtime.snapshot(), reg: registry.snapshot(), store: store.snapshot() };
    const invoke = () => op === "causesOf"
      ? control.causesOf(actor, "job/a", "msg-3") : control[op](actor, "job/a");
    await expect(Promise.resolve().then(invoke)).rejects.toThrow(/无权.*job/);
    expect({ rt: runtime.snapshot(), reg: registry.snapshot(), store: store.snapshot() }).toEqual(before);
  });

  it.each(operations)("即使有根权限，%s 也不能把子树参数默认为整树", async (op) => {
    const { control } = setup("job");
    const invoke = () => op === "causesOf"
      ? control.causesOf(actor, "job/a", "msg-1") : control[op](actor, "job/a");
    await expect(Promise.resolve().then(invoke)).rejects.toThrow(/仅支持根实例/);
  });

  it("有根权限的正常驱动仍完整执行，子树读取仍然可用", async () => {
    const { control, runtime, registry } = setup("job");
    expect(control.run(actor, "job")).toHaveLength(2);
    expect(await control.runAgents(actor, "job")).toHaveLength(1);
    expect(control.settleAll(actor, "job")).toHaveLength(4);
    expect(registry.get("job").status).toBe("TERMINAL");
    expect(control.subtree(actor, "job/a")).toHaveLength(1);
    runtime.checkInvariants();
  });
});
