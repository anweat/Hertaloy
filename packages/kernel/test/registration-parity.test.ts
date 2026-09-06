import { describe, expect, it } from "vitest";
import { registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";

describe("完整模板与覆盖层共用注册边界", () => {
  it.each([false, true])("缺失的子模板没有 entry 也拒绝（overlay=%s）", (overlay) => {
    const store = new ObjectStore();
    const base = registerContainerTemplate(store, "base", { nodes: {} });
    const children = { missing: { template: "absent@1" } };
    const spec = overlay ? { extends: base, override: { children } } : { nodes: {}, children };
    expect(() => registerContainerTemplate(store, "bad", spec)).toThrow(/子模板/);
    expect(store.history("bad")).toHaveLength(0);
  });

  it("覆盖层仍经过宿主注入的执行规格校验，合法版本仍可注册", () => {
    const store = new ObjectStore();
    const base = registerContainerTemplate(store, "base", {
      nodes: { a: { kind: "handler", agent: { argv: ["ok"] }, ports: {} } },
    });
    const validate = (spec: unknown) =>
      (spec as { argv: string[] }).argv[0] === "ok" ? [] : ["执行规格被宿主拒绝"];
    expect(() => registerContainerTemplate(store, "bad", {
      extends: base, override: { "nodes/a/agent/argv": ["bad"] },
    }, "container_template", validate)).toThrow(/执行规格被宿主拒绝/);
    expect(store.history("bad")).toHaveLength(0);
    const ref = registerContainerTemplate(store, "good", {
      extends: base, override: {},
    }, "container_template", validate);
    expect(store.resolve(ref).provenance.derived_from).toEqual([base]);
  });

  it.each([false, true])("根配置必须绑定使用的别名（overlay=%s）", (overlay) => {
    const store = new ObjectStore();
    const spec = { nodes: { a: { kind: "handler", handler: "noop", ports: {
      out: { direction: "emit", alias: "missing" },
    } } } };
    const base = registerContainerTemplate(store, "base", spec);
    expect(() => registerContainerTemplate(store, "bad",
      overlay ? { extends: base, override: {} } : spec, "root_config",
    )).toThrow(/missing/);
    expect(store.history("bad")).toHaveLength(0);
  });

  it("覆盖不可让 unavailable 信号失去 callback 所需字段", () => {
    const store = new ObjectStore();
    const base = registerContainerTemplate(store, "base", {
      nodes: { a: { kind: "handler", handler: "noop", ports: {
        got: { direction: "receive", servo: { vars: { value: { type: "short", from: "$.value" } } } },
        ask: { direction: "emit", alias: "svc", callback: "got", unavailable: { value: "offline" } },
      } } },
    });
    expect(() => registerContainerTemplate(store, "bad", {
      extends: base, override: { "nodes/a/ports/ask/unavailable": {} },
    })).toThrow(/unavailable.*servo/);
    expect(store.history("bad")).toHaveLength(0);
  });
});
