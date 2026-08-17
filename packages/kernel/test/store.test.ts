import { describe, expect, it } from "vitest";
import { ObjectStore, contentHash, refOf, stableStringify } from "../src/store.js";
import { InvariantError } from "../src/errors.js";

describe("ObjectStore —— 版本分配的唯一权威（V1）", () => {
  it("版本从 1 起单调，per object_id 独立", () => {
    const store = new ObjectStore();
    expect(store.put("plan", "plan", { n: 1 }).version).toBe(1);
    expect(store.put("plan", "plan", { n: 2 }).version).toBe(2);
    expect(store.put("spec", "spec", { n: 1 }).version).toBe(1);
    expect(refOf(store.head("plan"))).toBe("plan@2");
    expect(store.history("plan")).toHaveLength(2);
  });

  it("object_id 含 `@` 直接拒绝", () => {
    const store = new ObjectStore();
    expect(() => store.put("plan@1", "plan", {})).toThrow(InvariantError);
  });
});

describe("内容寻址与幂等（V3）", () => {
  it("同内容重复提交返回同一版本，不新增", () => {
    const store = new ObjectStore();
    const first = store.put("plan", "plan", { a: 1, b: 2 });
    const again = store.put("plan", "plan", { b: 2, a: 1 });
    expect(again.version).toBe(first.version);
    expect(store.history("plan")).toHaveLength(1);
  });

  it("stableStringify 与键序无关，嵌套同样归一", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("引用永远精确（V4）", () => {
  it("resolve 只接受 `id@N`", () => {
    const store = new ObjectStore();
    store.put("plan", "plan", { n: 1 });
    expect(store.resolve("plan@1").body).toEqual({ n: 1 });
    expect(() => store.resolve("plan")).toThrow();
    expect(() => store.resolve("plan@2")).toThrow(InvariantError);
  });

  it("旧版本在新版本发布后依然可解析（V2 独立于实例）", () => {
    const store = new ObjectStore();
    store.put("plan", "plan", { n: 1 });
    store.put("plan", "plan", { n: 2 });
    expect(store.resolve("plan@1").body).toEqual({ n: 1 });
  });
});

describe("lineage", () => {
  it("回溯 derived_from DAG", () => {
    const store = new ObjectStore();
    store.put("spec", "spec", { n: 1 });
    store.put("plan", "plan", { n: 1 }, { at_seq: 0, derived_from: ["spec@1"] });
    store.put("report", "report", { n: 1 }, { at_seq: 0, derived_from: ["plan@1"] });
    const dag = store.lineage("report@1");
    expect(dag.get("report@1")).toEqual(["plan@1"]);
    expect(dag.get("plan@1")).toEqual(["spec@1"]);
    expect(dag.get("spec@1")).toEqual([]);
  });
});
