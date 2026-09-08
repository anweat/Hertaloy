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
import { TraceId, AliasName, TRACE_SEGMENT_PATTERN } from "./identity.js";
import { PortName } from "./port.js";

/**
 * 节点 id **就是实例路径的一段** —— 不是另一种"标识符"。
 *
 * 它原来有自己的字符集 `/^[A-Za-z_][A-Za-z0-9_-]*$/`，比 traceid 段宽：
 * 允许大写和下划线。今天不打架，是因为 spawn 的路径段**由调用方给**
 * （`slot` 命名声明、`segment` 命名实例，两者解耦），节点 id 从不进 traceid。
 *
 * 而节点是**默认实例化**的：没有调用方来给段，段只能是节点 id 自己。
 * 于是这两套字符集必须并成一套 —— 并且宽的那套不能留：
 *
 * 实例身份必须**存得下**。Windows / macOS 默认不区分大小写，`Coder` 与
 * `coder` 落到同一个目录，`objects.ts` 的碰撞检测会当场拒写 —— 一棵完全
 * 合法的容器树变成写不进去的树。那个检测是给对象 id 兜的**诊断**，
 * 不该升格成实例身份的**准入**。
 *
 * 收紧的实际代价是零：全仓 80 个用例文件没有一个节点 id 用到放宽的那部分。
 */
export const NodeId = z
  .string()
  .regex(
    TRACE_SEGMENT_PATTERN,
    "节点 id 必须是合法的实例路径段：小写字母数字起止，中间可含连字符（它会成为 traceid 的一段）",
  );

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
    /** 经网关（别名）投递时携带；内网边传递时不带。 */
    alias: AliasName.optional(),
    payload: Json,
  })
  .strict();

export type MessageEnvelope = z.infer<typeof MessageEnvelope>;
