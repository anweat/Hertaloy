/**
 * 调度 —— **内核唯一真正的策略缝**。
 *
 * ## 为什么这个能开口子，队列不能
 *
 * 判据不是"能不能被替换"，而是：**换掉它，哪条不变量会破？**
 *
 *   换掉队列    → 投递一次、冻结对象（回滚依赖它）、order 语义 全破 → 不开
 *   换掉执行记录 → 孤儿判定破                                    → 不开
 *   换掉义务枚举 → L1 / L5 破                                    → 不开
 *   换掉别名解析 → M2 / A1 / A2 / A3 破                          → 不开
 *   **换掉先跑哪条 → 一条都不破**                                → 开
 *
 * 前四样是**组件**（内部分解，为了可测与可读），只有这一样是**缝**。
 * 把内部分解当成可插拔点，等于把"我能替换它"误当成"别人应该被允许替换它"。
 *
 * ## 缝的安全性靠结构，不靠调用方自觉
 *
 * 内核**先筛**：只有 `QUEUED`、目标实例 `OPEN`、节点种类对得上的消息才成为候选。
 * 调度器**只排序不放行** —— 它拿到的是一个候选集，只能从里面挑一个或者不挑。
 *
 * 而且挑完还要复核：**返回的必须是发出去的那批里的一个**。一个写坏的调度器
 * 因此**造不出**"跑一条不该跑的消息"，不是靠它自觉。这与"半状态不可表达"
 * 是同一条路子：结构性保证优于纪律。
 *
 * ## 它不管什么
 *
 * - **不管公平性与饥饿。**默认 FIFO 天然无饥饿；换成优先级就可能饿死低优先级，
 *   那是换的人要负责的事，内核不替它兜。
 * - **不管重试。**退避与放弃在失败路径里（`maxAttempts`），不在这儿。
 * - **不管并发。**一次只挑一条；同 `(实例, 节点)` 的并发由执行记录的
 *   driving 标记挡住，与调度无关。
 */

import type { TraceId } from "@nodeflow/contracts";
import { InvariantError } from "./errors.js";
import type { MessageFact } from "./facts.js";

/**
 * 一条可以立刻开跑的候选 —— 内核已经筛过，剩下的只是"先跑哪条"。
 */
export interface Candidate {
  /** 消息本身。调度器可以读 target / state，但改不了它（冻结对象）。 */
  readonly message: MessageFact;
  readonly traceid: TraceId;
  readonly nodeId: string;
  /**
   * 在投递顺序里的位置，越小越老。
   *
   * 给出来是因为**顺序是策略要用的信息，而不该让调度器去翻队列** ——
   * 它拿不到队列，也不该拿到。
   */
  readonly position: number;
}

/**
 * 挑一条来跑，或者返回 `null` 表示"这一轮不跑"。
 *
 * 返回 `null` 与"没有候选"对内核是同一件事：本轮空闲。所以一个总是返回
 * `null` 的调度器会让 `drain` 立刻收敛而不是转圈 —— 它只是不干活，
 * 不会把系统卡在半途。
 */
export type Scheduler = (candidates: readonly Candidate[]) => Candidate | null;

/**
 * 默认：先到先跑。
 *
 * 候选已经按投递顺序给出，所以取第一个就是 FIFO。**这是唯一天然无饥饿的策略**，
 * 也是内核不换它的理由 —— 换与不换的责任分界就在这儿。
 */
export const fifo: Scheduler = (candidates) => candidates[0] ?? null;

/**
 * 复核调度器的选择。**这是缝的安全边界。**
 *
 * 返回的必须**恰好是**发出去的那批里的一个（按引用比对，不按内容 ——
 * 内容相同的伪造对象也不算，那说明调度器在自己造候选）。
 *
 * 不合规就**抛**，不静默当成"本轮空闲"：后者会让一个写坏的调度器表现为
 * "系统没活干"，而队列里明明积着消息 —— 那正是"两端都绿、中间没人走"
 * 的又一个变种。编程错误就该响。
 */
export function acceptedPick(
  candidates: readonly Candidate[],
  picked: Candidate | null,
): Candidate | null {
  if (picked === null) return null;
  if (!candidates.includes(picked)) {
    throw new InvariantError(
      `调度器返回了不在候选集里的消息 ${picked.message.id}。` +
        `调度只排序不放行 —— 能跑哪些由内核筛，本轮候选：` +
        `${candidates.map((c) => c.message.id).join(", ") || "（空）"}`,
    );
  }
  return picked;
}
