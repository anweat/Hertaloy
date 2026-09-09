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
import {
  TraceId,
  AliasName,
  TRACE_SEGMENT_PATTERN,
  childTrace,
  parentTrace,
} from "./identity.js";
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

/**
 * 端点地址 = (实例路径, 端口)。**一段，不是两段。**
 *
 * 原来是 `{ traceid, node, port }` —— 容器一段、节点一段。那个两段结构是
 * "节点不是实例"留下的：节点没有身份，只好用 `(容器, 节点名)` 这个对儿来指它。
 * V6 阶段 1b 之后节点自己就是实例路径的一段，于是地址收成一段。
 *
 * **字段改名而不是复用 `traceid`**，是阶段 0 定的纪律：这个字段的**含义变了**
 * （原来指容器，现在指节点自己）。沿用旧名字的话 43 处读点会继续编译通过、
 * 静默地换掉含义 —— 改名让编译器成为那份清单。
 *
 * 容器怎么取：`parentTrace(instance)`。节点声明名怎么取：`lastSegment(instance)`。
 */
export const Endpoint = z
  .object({
    instance: TraceId,
    port: PortName,
  })
  .strict();

export type Endpoint = z.infer<typeof Endpoint>;

/**
 * 投递目标所属的**容器**。
 *
 * 地址必然是"容器/节点"两段以上 —— 消息投给节点的端口，而节点住在容器里，
 * 所以父一定存在。取不到父说明这个地址根本不是投递目标（比如根实例本身），
 * 那是编程错误，不是可以兜底的空值。
 *
 * V6 阶段 1b 之前这就是 `endpoint.traceid`，直接读。现在它是派生的 ——
 * 而这正是"地址收成一段"的意思：容器不再是地址里单独存的一份。
 */
export function containerOf(endpoint: { readonly instance: TraceId }): TraceId {
  const parent = parentTrace(endpoint.instance);
  if (parent === null) {
    throw new Error(`地址 ${endpoint.instance} 没有容器 —— 它不是合法的投递目标`);
  }
  return parent;
}

/**
 * (容器, 节点声明名, 端口) → 端点地址。`containerOf` 的逆。
 *
 * 走 `childTrace` 而不是模板字符串：节点 id 必须是合法路径段，这条由它当场把关
 * （节点 id 与 traceid 段并成一套字符集，见 `NodeId`）。
 */
export function endpointAt(container: TraceId, node: string, port: string): Endpoint {
  return { instance: childTrace(container, node), port };
}

/**
 * 给人看的地址：`实例路径.端口`。
 *
 * 阶段 0 把"显示"单列为一类读点，说该收成一处格式化函数。收成一段之后
 * 这个函数只剩一次插值 —— 那正是"地址是一段"这件事在显示层的样子。
 */
export function formatEndpoint(endpoint: Endpoint): string {
  return `${endpoint.instance}.${endpoint.port}`;
}

/**
 * 消息来源 —— **观测用，不是路由用**。
 *
 * 三种情形，靠字段有无区分，不需要标签：
 *
 *   `{instance, port}`  某实例的 emit 端口发出
 *   `{instance}`        实例自身的生命周期通知（子终止 → 父的 exit 端口）
 *   省略                外部注入（人 / CLI / MCP），图外来的
 *
 * V6 阶段 1b 之前这里是 `{traceid, node?, port?}` —— 与 `Endpoint` 一样的
 * 两段结构。节点成为实例之后 `node` 那一段并进 `instance`，**三个字段收成两个**，
 * 而三种情形的判别方式一字未改：还是靠字段有无。
 *
 * ⚠️ **绝不进 `MessageEnvelope`。** 信封是 agent 看得到的那份，而信封里没有
 * 任何路由字段是结构性保证（M1：编排权威属于边）。source 一旦进信封，
 * agent 就能"看谁发来的再决定怎么办" —— M1 就从结构性变成了口头约定。
 * 它只属于内核内部的消息记录（会随 head 落盘，渲染层从那儿读）。
 */
export const MessageSource = z
  .object({
    instance: TraceId,
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
