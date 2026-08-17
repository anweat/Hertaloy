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
import { Ref, Tunnel } from "./identity.js";
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

/**
 * emit 端口有三种模式，互斥：
 *
 * | 模式 | 声明 | 行为 |
 * |---|---|---|
 * | 内网边 | 都不声明 | 按模板的边路由（默认）|
 * | 网关广播 | `tunnel` | PUBLISH 到隧道，0..N 个订阅者，**不记锁**（发后不管）|
 * | 网关请求 | `tunnel` + `callback` | REQUEST，要求恰好 1 个订阅者，内核记一把 `request` 锁，回复落 `callback` 端口 |
 * | 网关回复 | `reply: true` | 回复本次正在处理的 REQUEST，销账 |
 *
 * handler 仍然只写端口名 —— 是端口的声明决定这条输出走内网还是走网关，
 * 不是 handler 选的。第一不变量与 M1 都不因为加了网关而破口。
 */
const EmitPortShape = z
  .object({
    direction: z.literal("emit"),
    contract: Ref.optional(),
    tunnel: Tunnel.optional(),
    /** 回复落回的**本节点**端口名 —— callback 只回已声明端点（不变量 M3）。 */
    callback: PortName.optional(),
    reply: z.literal(true).optional(),
  })
  .strict();

function checkGatewayMode(
  v: {
    readonly tunnel?: unknown;
    readonly callback?: unknown;
    readonly reply?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const usesTunnel = v.tunnel !== undefined || v.callback !== undefined;
  if (usesTunnel && v.reply !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "emit 端口不能同时是网关出隧道（tunnel）与网关回复（reply）",
    });
  }
  if (v.callback !== undefined && v.tunnel === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "声明了 `callback` 就必须声明 `tunnel` —— 回复落点只对 REQUEST 有意义",
    });
  }
}

export const EmitPort = EmitPortShape.superRefine(checkGatewayMode);

export const Port = z
  .discriminatedUnion("direction", [ReceivePort, EmitPortShape])
  .superRefine((v, ctx) => {
    if (v.direction === "emit") checkGatewayMode(v, ctx);
  });

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
