import { describe, expect, it } from "vitest";
import { evaluatePath, extractPortVars } from "../src/extract.js";

const payload = {
  plan: { tasks: [{ id: "t1", spec: "spec@1" }, { id: "t2", spec: "spec@2" }] },
  flag: false,
};

describe("evaluatePath —— 纯提取", () => {
  it("点路径、索引、投影", () => {
    expect(evaluatePath(payload, "$.plan.tasks[0].id")).toBe("t1");
    expect(evaluatePath(payload, "$.plan.tasks[*].id")).toEqual(["t1", "t2"]);
    expect(evaluatePath(payload, "$")).toEqual(payload);
    expect(evaluatePath(payload, "$.flag")).toBe(false);
  });

  it("取不到返回 undefined，不补默认值", () => {
    expect(evaluatePath(payload, "$.missing")).toBeUndefined();
    expect(evaluatePath(payload, "$.plan.tasks[9].id")).toBeUndefined();
    expect(evaluatePath(payload, "$.plan[0]")).toBeUndefined();
    expect(evaluatePath(payload, "$.flag.deeper")).toBeUndefined();
  });
});

describe("extractPortVars —— 全有或全无", () => {
  const port = {
    direction: "receive" as const,
    servo: {
      vars: {
        first: { type: "short" as const, from: "$.plan.tasks[0].id" },
        all: { type: "short" as const, from: "$.plan.tasks[*].id" },
      },
    },
  };

  it("全部命中则返回变量袋", () => {
    const result = extractPortVars(port, payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vars).toEqual({ first: "t1", all: ["t1", "t2"] });
  });

  it("任一变量取不到即整体失败，并指名是哪个变量", () => {
    const result = extractPortVars(
      {
        direction: "receive",
        servo: {
          vars: {
            ok: { type: "short", from: "$.flag" },
            bad: { type: "short", from: "$.nope" },
          },
        },
      },
      payload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.variable).toBe("bad");
    }
  });

  it("无 servo 的端口与 emit 端口返回空变量袋", () => {
    expect(extractPortVars({ direction: "receive" }, payload)).toEqual({
      ok: true,
      vars: {},
    });
    expect(extractPortVars({ direction: "emit" }, payload)).toEqual({ ok: true, vars: {} });
  });
});
