/**
 * 跨状态机的约束检查 —— DBMS 里 CHECK constraint 该在的位置（§10.4）。
 *
 * 这些规则以前散在各处的 `if` 里，没有一处声明；现在集中在这里，
 * 而且是**纯函数**：喂一组事实，返回违规清单。与 `obligations.ts` 同一个路子。
 *
 * ## 为什么要纯函数
 *
 * 1. **构造得出违规状态才测得到。**挂在 `Runtime` 上时，要测"两个执行同时
 *    claim 了一条消息"就得先把运行时摆成那个样子 —— 而正确的运行时**摆不出来**。
 *    纯函数可以直接把那组事实喂进去。
 * 2. 检查本身是查询，不改任何状态。混在命令对象里只是因为数据在那儿。
 *
 * ## 它不检查什么
 *
 * 归约之后有两类检查**不需要存在**了，这里刻意不写：
 *
 *   - "child 锁指向不存在的实例"、"锁还在但子实例已 TERMINAL" —— 义务从
 *     `instance.status` 算出来，不存在的实例算不出义务，已终态的也算不出。
 *     不是"检查得更好"，是**违规状态构造不出来**。
 *   - 别名解析出 0 个目标 —— 绑定存在性在注册期就判了（A2），
 *     运行期的 0 个是合法的"这个槽里现在没有活实例"。
 */

import { containerOf } from "@nodeflow/contracts";
import type { Obligation } from "./obligations.js";
import { type ExecutionFact, type InstanceFact, type MessageFact, isLive } from "./facts.js";

export type { ExecutionFact, InstanceFact } from "./facts.js";

export interface InvariantFacts {
  readonly messages: readonly MessageFact[];
  readonly executions: readonly ExecutionFact[];
  readonly instances: readonly InstanceFact[];
  /** 全表。按 holder 过滤在本模块里做。 */
  readonly obligations: readonly Obligation[];
}

/**
 * 返回违规清单。空数组 = 一切正常。
 *
 * **返回而不是抛**：调用方决定怎么处置（`Runtime.checkInvariants` 抛，
 * 而写用例时往往只想看清单）。
 */
export function stateProblems(facts: InvariantFacts): readonly string[] {
  const problems: string[] = [];
  const byId = new Map(facts.messages.map((m) => [m.id, m]));

  // --- 消息 CLAIMED ⟺ 存在引用它的 RUNNING 记录 -------------------------
  const claimedByRecord = new Set<string>();
  for (const rec of facts.executions) {
    if (rec.status !== "RUNNING") continue;
    for (const id of rec.claimed) claimedByRecord.add(id);
  }
  for (const msg of facts.messages) {
    if (msg.state === "CLAIMED" && !claimedByRecord.has(msg.id)) {
      problems.push(`消息 ${msg.id} 是 CLAIMED，但没有 RUNNING 记录引用它`);
    }
  }
  for (const id of claimedByRecord) {
    const msg = byId.get(id);
    if (msg !== undefined && msg.state !== "CLAIMED") {
      problems.push(`RUNNING 记录引用了 ${id}，但它是 ${msg.state}`);
    }
  }

  /**
   * **一条消息至多被一条 RUNNING 记录 claim。**
   *
   * 只看 RUNNING 是有理由的：重试后旧记录仍列着那条消息，但那是**历史**
   * 不是活跃 claim —— 把 SETTLED 也算进来会把正常的重试判成违规
   * （第一版就是这么写的，测试当场炸了）。
   *
   * 真正要挡的是"两个执行同时以为自己拥有这条消息"，那正是 claim 被偷走时的样子。
   */
  const owner = new Map<string, string>();
  for (const rec of facts.executions) {
    if (rec.status !== "RUNNING") continue;
    for (const id of rec.claimed) {
      const prev = owner.get(id);
      if (prev !== undefined) {
        problems.push(`消息 ${id} 同时被 ${prev} 与 ${rec.executionId} claim`);
      } else {
        owner.set(id, rec.executionId);
      }
    }
  }

  // --- TERMINAL ⇒ 无在途消息、无在等的事、无 RUNNING 执行 -----------------
  for (const inst of facts.instances) {
    if (inst.status !== "TERMINAL") continue;

    const live = facts.messages.filter(
      (m) => containerOf(m.target) === inst.traceid && isLive(m),
    );
    if (live.length > 0) {
      problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍有 ${live.length} 条在途消息`);
    }

    const waiting = facts.obligations.filter(
      (o) => o.holder === inst.traceid && (o.kind === "request" || o.kind === "child"),
    );
    if (waiting.length > 0) {
      problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍在等 ${waiting.length} 件事`);
    }

    for (const rec of facts.executions) {
      if (containerOf(rec) === inst.traceid && rec.status === "RUNNING") {
        problems.push(`实例 ${inst.traceid} 已 TERMINAL，却仍有 RUNNING 执行 ${rec.executionId}`);
      }
    }
  }

  return problems;
}

/** 违规清单渲染成一条错误信息。空清单返回 `null`。 */
export function formatProblems(problems: readonly string[]): string | null {
  if (problems.length === 0) return null;
  return ["状态不变量被破坏：", ...problems].join("\n  ");
}
