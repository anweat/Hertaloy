/**
 * 事实的最小投影 —— 纯函数吃的是这些，不是完整记录。
 *
 * ## 为什么要单独一处
 *
 * `obligations.ts` / `invariants.ts` / `aliases.ts` 各自都要"一个实例长什么样"。
 * 抽出来的时候三处各写了一遍，于是同一个概念有三份声明：两份 `InstanceFact`
 * 逐字相同、第三份多一个 `slot`；`ExecutionFact` 两份各取了不同的子集。
 *
 * 结构上它们都是真类型（`ContainerInstance` / `ExecutionRecord` / `Message`）的
 * 子集，所以 TypeScript 在调用点会替我们对账 —— **但语义上不会**。哪天
 * `status` 的含义变了，三份声明会一起静默地错，而"三处都绿"正是这个项目
 * 被咬过四次的形状。
 *
 * 所以：**一个事实，一处声明**。纯函数仍然只吃自己要的字段（签名里写清楚），
 * 但"要的字段"从同一份定义里取。
 *
 * ## 依赖方向
 *
 * 本文件**不依赖 kernel 里任何东西**，只依赖 contracts。上层各模块单向引它。
 * 反过来引会立刻成环 —— 那是这条边界的自检。
 */

import type { TraceId } from "@nodeflow/contracts";

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export type MessageState = "QUEUED" | "CLAIMED" | "CONSUMED" | "FAILED" | "DISCARDED";

/**
 * 还会动的状态。其余三种都已了结。
 *
 * 放在这里而不是 `queue.ts`：**"哪些状态还算活着"是语义，不是队列的实现细节**。
 * 义务枚举与不变量检查都要用它，让它们去引队列就把依赖方向弄反了。
 */
export const LIVE_MESSAGE_STATES: readonly MessageState[] = ["QUEUED", "CLAIMED"];

export function isLive(message: { readonly state: string }): boolean {
  return (LIVE_MESSAGE_STATES as readonly string[]).includes(message.state);
}

/** 一条消息里，纯函数用得上的那部分。完整的 `Message` 在 `queue.ts`。 */
export interface MessageFact {
  readonly id: string;
  readonly target: { readonly traceid: TraceId; readonly node: string };
  readonly state: string;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 一次执行里，纯函数用得上的那部分。完整的 `ExecutionRecord` 在 `executions.ts`。
 *
 * `nodeId` 与 `claimed` 原本被两处各取一半 —— 合成一份的代价只是用例的夹具多写
 * 一个字段，换来的是"执行记录"在内核里只有一种说法。
 */
export interface ExecutionFact {
  readonly executionId: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly status: string;
  /** 被 claim 的消息集合 —— 冲突域的一半。 */
  readonly claimed: readonly string[];
}

// ---------------------------------------------------------------------------
// 待回复请求
// ---------------------------------------------------------------------------

export interface RequestFact {
  readonly requestId: string;
  readonly requester: TraceId;
  readonly node: string;
  /**
   * 服务方。**本地记录**，不去问对面 —— 租户将来未必在同一个进程里，
   * 派生只许读本地持有的事实。
   */
  readonly waitingOn?: TraceId;
}

// ---------------------------------------------------------------------------
// 实例
// ---------------------------------------------------------------------------

export interface InstanceFact {
  readonly traceid: TraceId;
  /** 它占父容器的哪个子槽。根没有。别名的槽枚举要读它。 */
  readonly slot?: string;
  readonly status: string;
}
