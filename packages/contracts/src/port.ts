/**
 * 端口与 servo 契约。
 *
 * 对应 FOUNDATION_V5.md §6.2 / §6.3：
 * 端口是**变量的出入口**，不是消息收发口；servo 依附端口，是一张映射表不是一段程序。
 *
 * **servo 只出现在 receive 端口** —— 用判别式联合强制，而不是靠运行时检查：
 * emit 端口的输出由 handler 产生，没有可提取的来源。
 */

import { z } from "zod";
import { Ref } from "./identity.js";
import { PortVar, VarName } from "./variable.js";

export const PORT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PortName = z
  .string()
  .regex(PORT_NAME_PATTERN, "端口名必须是标识符");

/** servo：变量名 → 提取声明。输出变量集 = 键集，编译期已知（不变量 S1）。 */
export const Servo = z
  .object({
    vars: z.record(VarName, PortVar),
  })
  .strict();

export type Servo = z.infer<typeof Servo>;

export const ReceivePort = z
  .object({
    direction: z.literal("receive"),
    servo: Servo.optional(),
    contract: Ref.optional(),
  })
  .strict();

export const EmitPort = z
  .object({
    direction: z.literal("emit"),
    contract: Ref.optional(),
  })
  .strict();

export const Port = z.discriminatedUnion("direction", [ReceivePort, EmitPort]);

export type ReceivePort = z.infer<typeof ReceivePort>;
export type EmitPort = z.infer<typeof EmitPort>;
export type Port = z.infer<typeof Port>;

export const PortMap = z.record(PortName, Port);
export type PortMap = z.infer<typeof PortMap>;

/**
 * `allowed_emit_ports` —— 第一不变量的落地点。
 * 由拓扑推导，不是用户可选填的字段。
 */
export function allowedEmitPorts(ports: PortMap): readonly string[] {
  return Object.entries(ports)
    .filter(([, p]) => p.direction === "emit")
    .map(([name]) => name)
    .sort();
}

/** 本端口 servo 提出的变量名集合。空 servo 返回空集。 */
export function servoVarNames(port: Port): readonly string[] {
  if (port.direction !== "receive" || port.servo === undefined) return [];
  return Object.keys(port.servo.vars).sort();
}
