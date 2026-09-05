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
import { AliasName, Ref } from "./identity.js";
import { Json } from "./json.js";
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
 * | 网关广播 | `alias` | PUBLISH，绑定解析出 0..N 个目标，**不记义务**（发后不管）|
 * | 网关请求 | `alias` + `callback` | REQUEST，要求恰好 1 个目标，内核记一份 `request` 义务，回复落 `callback` 端口 |
 * | 网关回复 | `reply: true` | 回复本次正在处理的 REQUEST，销账 |
 *
 * handler 仍然只写端口名 —— 是端口的声明决定这条输出走内网还是走网关，
 * 不是 handler 选的。第一不变量与 M1 都不因为加了网关而破口。
 */
const EmitPortShape = z
  .object({
    direction: z.literal("emit"),
    contract: Ref.optional(),
    /**
     * **别名出口**。声明了它，目标由绑定表解析（`kernel/aliases.ts`）。
     *
     * `alias` 单独 = PUBLISH（0..N 个目标）；`alias` + `callback` = REQUEST
     * （要求恰好 1 个目标，回复落 `callback` 端口）。
     *
     * 这里原本是 `tunnel`：全局标签 + 全树扫描匹配订阅 + 逐订阅方求 scope。
     * 换成别名之后，"这条 emit 去哪儿"**注册期就判定得了**，而且租户之间
     * 不再共享一个名字空间。
     */
    alias: AliasName.optional(),
    /** 回复落回的**本节点**端口名 —— callback 只回已声明端点（不变量 M3）。 */
    callback: PortName.optional(),
    reply: z.literal(true).optional(),
    /**
     * **等不到回复时，当作收到了这个** —— 只对 REQUEST（`alias` + `callback`）
     * 有意义，且**必填**。
     *
     * 服务方永久失败（重试耗尽 / 预算耗尽 / 被截断）时，请求方在等一个
     * 永远不会来的回复。内核会代投一条，但**形状不能由内核定**：callback
     * 端口的 servo 是照着回复的形状写的，内核自造一个 `{status, service, reason}`
     * 投过去，会在变量提取那一步就被拒（实测：`路径 $.a 取不到值`），
     * 消息进 FAILED，请求方的 handler **根本没被叫醒** —— 通知发了等于没发。
     *
     * ## 为什么写在请求方这边，不写在服务方的 reply 端口上
     *
     * 一个服务方会被**多个**请求方调用，而它们的 callback servo 各不相同。
     * 服务方声明一份默认回复满足不了所有人 —— 那只在"恰好一个请求方"时成立。
     *
     * 写在这边还买到一样：**注册期本地就能校验**。载荷要过的是本节点
     * `callback` 端口的契约与 servo，两者都在同一个模板里，不必去读服务方的
     * 定义（租户纪律：派生只许读本地持有的事实）。
     *
     * **必填**，照"显式表态"的先例：不写不是"我不需要"，是"我忘了"，
     * 而这两者不该长得一样 —— 别名时代根必须显式接线，同一条理由。
     */
    unavailable: Json.optional(),
  })
  .strict();

function checkGatewayMode(
  v: {
    readonly alias?: unknown;
    readonly callback?: unknown;
    readonly reply?: unknown;
    readonly unavailable?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const usesGateway = v.alias !== undefined || v.callback !== undefined;
  if (usesGateway && v.reply !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "emit 端口不能同时是网关出口（alias）与网关回复（reply）",
    });
  }
  if (v.callback !== undefined && v.alias === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "声明了 `callback` 就必须声明 `alias` —— 回复落点只对 REQUEST 有意义",
    });
  }
  if (v.unavailable !== undefined && v.callback === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unavailable"],
      message: "`unavailable` 只对 REQUEST（`alias` + `callback`）有意义 —— 它是等不到回复时的替代",
    });
  }
  if (v.callback !== undefined && v.unavailable === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unavailable"],
      message:
        "声明了 `callback` 就必须声明 `unavailable`：服务方永久失败时你在等一个" +
        "永远不会来的回复。内核代投的通知形状过不了你自己 callback 端口的 servo，" +
        "会在提取那一步被拒 —— handler 根本不会被叫醒。写清楚等不到时当作收到什么",
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
