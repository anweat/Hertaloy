/**
 * 消息信封契约。
 *
 * 对应 FOUNDATION_V5.md §3.3 / §8：
 * - 信封由内核构造并保护；servo 与 agent 只能碰 payload。
 * - **信封里没有任何路由字段**（不变量 M1：编排权威属于边）—— 这是结构性的，不是运行时检查。
 * - **不存 `causation_ids`**：因果由 RunSnapshot 承担（提交记录的输入集→输出集就是因果边）。
 *   信封只带协议必需的 `in_reply_to`。
 */

import { z } from "zod";
import { Json } from "./json.js";
import { TraceId, Tunnel } from "./identity.js";
import { PortName } from "./port.js";

export const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const NodeId = z.string().regex(NODE_ID_PATTERN, "节点 id 必须是标识符");

/** 端点地址 = (实例路径, 节点, 端口)。 */
export const Endpoint = z
  .object({
    traceid: TraceId,
    node: NodeId,
    port: PortName,
  })
  .strict();

export type Endpoint = z.infer<typeof Endpoint>;

/**
 * 消息来源 —— **观测用，不是路由用**。
 *
 * 三种情形，靠字段有无区分，不需要标签：
 *
 *   `{traceid, node, port}`  某节点的 emit 端口发出
 *   `{traceid}`              实例自身的生命周期通知（子终止 → 父的 exit 端口）
 *   省略                     外部注入（人 / CLI / MCP），图外来的
 *
 * ⚠️ **绝不进 `MessageEnvelope`。** 信封是 agent 看得到的那份，而信封里没有
 * 任何路由字段是结构性保证（M1：编排权威属于边）。source 一旦进信封，
 * agent 就能"看谁发来的再决定怎么办" —— M1 就从结构性变成了口头约定。
 * 它只属于内核内部的消息记录（会随 head 落盘，渲染层从那儿读）。
 */
export const MessageSource = z
  .object({
    traceid: TraceId,
    node: NodeId.optional(),
    port: PortName.optional(),
  })
  .strict();

export type MessageSource = z.infer<typeof MessageSource>;

export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const MessageEnvelope = z
  .object({
    message_id: z.string().regex(MESSAGE_ID_PATTERN, "message_id 必须是标识符"),
    target: Endpoint,
    /** REPLY 关联到发起的 REQUEST。非回复消息不带此字段。 */
    in_reply_to: z.string().regex(MESSAGE_ID_PATTERN).optional(),
    /** 经队列投递时携带；内网边传递时不带。 */
    tunnel: Tunnel.optional(),
    payload: Json,
  })
  .strict();

export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/**
 * 订阅寻址 = **隧道标签 ∩ traceid 前缀**（不变量 M2）。
 * `scope` 省略表示不限作用域。
 */
export const SubscriptionAddress = z
  .object({
    tunnel: Tunnel,
    scope: TraceId.optional(),
  })
  .strict();

export type SubscriptionAddress = z.infer<typeof SubscriptionAddress>;
