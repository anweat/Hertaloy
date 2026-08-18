/**
 * handler 输出的 JSON 化（创建时约束）。
 *
 * 校验包在 `registerHandler` 上 —— 一次施加，全局保证。
 * 每条用例对应一种**静默损坏或挂死**，那正是不校验时最难查的失败方式。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { jsonViolations } from "@nodeflow/contracts";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";

const spec = {
  nodes: {
    n: {
      kind: "handler",
      handler: "bad",
      ports: { in: { direction: "receive" }, out: { direction: "emit" } },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;

beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "root", spec, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  rt = new Runtime(store, reg);
});

function runWith(fn: () => unknown): () => void {
  rt.registerHandler("bad", fn as never);
  rt.send({ traceid: "job-1", node: "n", port: "in" }, {});
  return () => rt.drain();
}

describe("jsonViolations 认得出每一种静默损坏", () => {
  it("undefined / 函数 / Symbol —— 键会被静默丢弃", () => {
    expect(jsonViolations({ a: undefined })[0]?.message).toMatch(/静默丢弃/);
    expect(jsonViolations({ a: () => 1 })[0]?.message).toMatch(/function/);
    expect(jsonViolations({ a: Symbol("x") })[0]?.message).toMatch(/symbol/);
  });

  it("NaN / Infinity —— 会被静默写成 null", () => {
    expect(jsonViolations({ a: NaN })[0]?.message).toMatch(/静默写成 null/);
    expect(jsonViolations({ a: Infinity })[0]?.message).toMatch(/静默写成 null/);
  });

  it("Date / Map / Set / 类实例 —— 会被静默写成 {}", () => {
    for (const v of [new Date(), new Map(), new Set()]) {
      expect(jsonViolations({ a: v })[0]?.message).toMatch(/不是 JSON 值/);
    }
  });

  it("★ 循环引用 —— 不拦会让规范化序列化挂死", () => {
    const cyclic: Record<string, unknown> = { name: "环" };
    cyclic.self = cyclic;
    expect(jsonViolations(cyclic)[0]?.message).toMatch(/循环引用/);
  });

  it("合法 JSON 零违规，路径定位到具体位置", () => {
    expect(jsonViolations({ a: [1, "x", null, { b: true }] })).toEqual([]);
    expect(jsonViolations({ out: { tasks: [{ when: NaN }] } })[0]?.path).toBe(
      "$.out.tasks[0].when",
    );
  });
});

describe("★ 创建时约束：校验包在 registerHandler 上", () => {
  it("返回 Date 直接抛，且指出是哪个 handler、哪条路径", () => {
    expect(runWith(() => ({ out: { at: new Date() } }))).toThrow(InvariantError);
  });

  it("返回循环引用直接抛，而不是挂死", () => {
    const run = runWith(() => {
      const c: Record<string, unknown> = {};
      c.self = c;
      return { out: c };
    });
    expect(run).toThrow(/循环引用/);
  });

  it("返回 NaN 直接抛", () => {
    expect(runWith(() => ({ out: { score: NaN } }))).toThrow(/静默写成 null/);
  });

  it("合法输出照常通过", () => {
    const run = runWith(() => ({ out: { ok: true, n: 1, list: [null, "x"] } }));
    expect(run).not.toThrow();
  });

  it("★ 抛出后事务回滚，不留半状态", () => {
    const run = runWith(() => ({ out: { at: new Date() } }));
    expect(run).toThrow();
    expect(rt.messages().every((m) => m.state === "QUEUED")).toBe(true);
    expect(reg.get("job-1").seq).toBe(0);
    rt.checkInvariants();
  });
});

describe("ctx.put 的 body 同样校验", () => {
  it("写入非 JSON body 直接抛 —— 它同样进 store 与内容哈希", () => {
    const run = runWith(function (this: void, _v: unknown, ctx: { put: (a: string, b: string, c: unknown) => unknown }) {
      ctx.put("bad", "thing", { at: new Date() } as never);
      return {};
    } as never);
    expect(run).toThrow(/不是合法 JSON/);
    expect(store.has("job-1/bad")).toBe(false);
  });
});
