import { describe, expect, it } from "vitest";
import { Port, allowedEmitPorts, servoVarNames } from "../src/port.js";

const receiveWithServo = {
  direction: "receive" as const,
  servo: { vars: { task: { type: "short" as const, from: "$.description" } } },
};

describe("Port —— servo 只在 receive 端口（结构强制）", () => {
  it("接受带 servo 的 receive 与只有 contract 的 emit", () => {
    expect(Port.safeParse(receiveWithServo).success).toBe(true);
    expect(
      Port.safeParse({ direction: "emit", contract: "CodeResult@2" }).success,
    ).toBe(true);
  });

  it("拒绝 emit 端口带 servo", () => {
    expect(
      Port.safeParse({ direction: "emit", servo: { vars: {} } }).success,
    ).toBe(false);
  });

  it("拒绝未知方向、字段、变量名与非精确契约", () => {
    expect(Port.safeParse({ direction: "inout" }).success).toBe(false);
    expect(Port.safeParse({ direction: "receive", foo: true }).success).toBe(false);
    expect(
      Port.safeParse({
        direction: "receive",
        servo: { vars: { "1bad": { type: "short", from: "$.description" } } },
      }).success,
    ).toBe(false);
    expect(Port.safeParse({ direction: "emit", contract: "CodeResult" }).success).toBe(false);
  });
});

describe("从拓扑推导（第一不变量的落点）", () => {
  it("allowed_emit_ports = 声明了 emit 的端口集，排序稳定", () => {
    expect(
      allowedEmitPorts({
        out: { direction: "emit" },
        in: receiveWithServo,
        err: { direction: "emit" },
      }),
    ).toEqual(["err", "out"]);
  });

  it("allowedEmitPorts 对空端口与全 receive 端口返回空集", () => {
    expect(allowedEmitPorts({})).toEqual([]);
    expect(
      allowedEmitPorts({
        first: { direction: "receive" },
        second: receiveWithServo,
      }),
    ).toEqual([]);
  });

  it("servoVarNames 对无 servo 的端口返回空集", () => {
    expect(servoVarNames(receiveWithServo)).toEqual(["task"]);
    expect(servoVarNames({ direction: "emit" })).toEqual([]);
    expect(servoVarNames({ direction: "receive" })).toEqual([]);
  });

  it("servoVarNames 对多变量 servo 按字典序返回", () => {
    expect(
      servoVarNames({
        direction: "receive",
        servo: {
          vars: {
            zebra: { type: "short", from: "$.zebra" },
            alpha: { type: "short", from: "$.alpha" },
            middle: { type: "short", from: "$.middle" },
          },
        },
      }),
    ).toEqual(["alpha", "middle", "zebra"]);
  });
});
