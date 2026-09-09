/**
 * 未了结的义务 —— 「还有什么没完」的**唯一**枚举。
 *
 * 取代 `terminationBlockers` 里那三段并列（在途消息 / 在途执行 / 持有的锁）。
 * 那三段是**一种**东西的三个来源，三处漏一处就是"父容器永远等一个已死的子"
 * 那类 bug —— 于是有三个滋生点。合成一条之后只剩一个。
 *
 * 四种义务的事实来源**全都已经存在**，一张新表都不需要建：
 *
 *   | 义务      | 权威                                   |
 *   |-----------|----------------------------------------|
 *   | message   | `Message.state ∈ {QUEUED, CLAIMED}`    |
 *   | execution | `ExecutionRecord.status === "RUNNING"` |
 *   | request   | 待回复请求表                            |
 *   | child     | `instance.status === "OPEN"`           |
 *
 * ## 为什么参数是「事实」而不是 `Runtime`
 *
 * 两个理由，第二个是给以后留的：
 *
 *   1. 纯函数，没有隐藏输入 —— 派生结论可以被逐条钉住（`test/obligations.test.ts`）。
 *   2. **每个容器都可以是一个租户**，而租户将来未必在同一个进程里。所以派生
 *      只许读**本地持有的事实**：远端的等待必须由一条本地记录表达
 *      （`RequestFact` 就是那条本地记录），绝不能靠"去问问对面还活着没"。
 *      按事实取参数，这条纪律就由签名强制，而不是靠记性。
 */

import { type TraceId, containerOf, lastSegment, parentTrace } from "@nodeflow/contracts";
import type { ExecutionFact, InstanceFact, MessageFact, RequestFact } from "./facts.js";
import { isLive } from "./facts.js";

export type { ExecutionFact, InstanceFact, MessageFact, RequestFact } from "./facts.js";

export const OBLIGATION_KINDS = ["message", "execution", "request", "child"] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

/**
 * 一份未了结的义务。
 *
 * `kind` 是**派生描述符**，不是要维护的闭集：加新的等待形态时加的是事实来源，
 * 不是往某个 `as const` 数组里再塞一个字符串然后满世界找记账点。
 */
export interface Obligation {
  readonly kind: ObligationKind;
  /** 谁背着它。唯一 owner 是容器（不变量 L2）。 */
  readonly holder: TraceId;
  /** 在等谁。在途消息 / 在途执行是"自己还在跑"，没有对象。 */
  readonly waitingOn?: TraceId;
  /** 消息 id / executionId / requestId / 子实例 traceid */
  readonly key: string;
  /** 仅供展示，不参与门控。 */
  readonly originNode?: string;
}

export interface ObligationFacts {
  readonly messages: readonly MessageFact[];
  readonly executions: readonly ExecutionFact[];
  readonly requests: readonly RequestFact[];
  readonly instances: readonly InstanceFact[];
}

/**
 * 全部未了结的义务。**纯函数。**
 *
 * 顺序（message → execution → request → child）是稳定的，观测方可以依赖。
 */
export function outstanding(facts: ObligationFacts): readonly Obligation[] {
  const out: Obligation[] = [];

  for (const m of facts.messages) {
    if (!isLive(m)) continue;
    /**
     * holder 仍是**容器**（不变量 L2：唯一 owner 是容器）。
     *
     * V6 阶段 1b 之前这就是 `m.target.traceid`。地址收成一段之后容器是派生的，
     * 但**规则一字未改** —— 见 V6_MODEL.md §10.5：统一之后 L2 的读数不变。
     * 把义务挪到节点自己名下是"节点成为实例"那一半的事，不是地址这一半的。
     */
    out.push({
      kind: "message",
      holder: containerOf(m.target),
      key: m.id,
      originNode: lastSegment(m.target.instance),
    });
  }

  for (const e of facts.executions) {
    if (e.status !== "RUNNING") continue;
    out.push({ kind: "execution", holder: e.traceid, key: e.executionId, originNode: e.nodeId });
  }

  for (const r of facts.requests) {
    // holder 同样仍是容器（L2）—— `requester` 现在是请求方节点自己的路径
    out.push({
      kind: "request",
      holder: containerOf({ instance: r.requester }),
      key: r.requestId,
      originNode: lastSegment(r.requester),
      ...(r.waitingOn === undefined ? {} : { waitingOn: r.waitingOn }),
    });
  }

  // 子实例：**没有第二份拷贝可以忘记更新**。子一进终态，父的这份义务当场消失 ——
  // 而在账本模型里那要靠 `settle` 记得销账、`truncate` 记得反向清账。
  const alive = new Set(facts.instances.map((i) => i.traceid));
  for (const inst of facts.instances) {
    if (inst.status !== "OPEN") continue;
    const parent = parentTrace(inst.traceid);
    if (parent === null || !alive.has(parent)) continue;
    out.push({ kind: "child", holder: parent, key: inst.traceid, waitingOn: inst.traceid });
  }

  return out;
}

/** 某容器名下的义务。这就是"它还能不能终止"的全部依据。 */
export function obligationsOf(
  facts: ObligationFacts,
  trace: TraceId,
): readonly Obligation[] {
  return outstanding(facts).filter((o) => o.holder === trace);
}

/**
 * 渲染成人读的阻塞原因。
 *
 * 消息与执行**聚合成一行**（数量是唯一有用的信息），request / child 各一行
 * （在等谁才是有用的那件事）。这与账本时代的文案逐字一致 —— 归约是
 * 行为保持的，615 条既有用例一条没改就是证明。
 */
export function describeObligations(obligations: readonly Obligation[]): readonly string[] {
  const lines: string[] = [];
  const messages = obligations.filter((o) => o.kind === "message").length;
  if (messages > 0) lines.push(`${messages} 条待处理消息`);
  const executions = obligations.filter((o) => o.kind === "execution").length;
  if (executions > 0) lines.push(`${executions} 个在途 execution`);
  for (const o of obligations) {
    if (o.kind === "message" || o.kind === "execution") continue;
    lines.push(
      `锁 ${o.kind}${o.waitingOn === undefined ? "" : ` · 等 ${o.waitingOn}`}` +
        `${o.originNode === undefined ? "" : `（${o.originNode} 发起）`}`,
    );
  }
  return lines;
}

/**
 * 等待图里的环 = 死锁。**只报警，不裁决**（观测不裁决）。
 *
 * 返回参与环的容器 traceid，供画布高亮，由人来断。
 */
export function deadlocks(obligations: readonly Obligation[]): readonly (readonly TraceId[])[] {
  const edges = new Map<TraceId, Set<TraceId>>();
  for (const o of obligations) {
    if (o.waitingOn === undefined) continue;
    const set = edges.get(o.holder) ?? new Set<TraceId>();
    set.add(o.waitingOn);
    edges.set(o.holder, set);
  }

  const cycles: TraceId[][] = [];
  const state = new Map<TraceId, "visiting" | "done">();
  const stack: TraceId[] = [];

  const visit = (node: TraceId): void => {
    const seen = state.get(node);
    if (seen === "done") return;
    if (seen === "visiting") {
      const start = stack.indexOf(node);
      if (start >= 0) cycles.push(stack.slice(start));
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, "done");
  };

  for (const node of edges.keys()) visit(node);
  return cycles;
}
