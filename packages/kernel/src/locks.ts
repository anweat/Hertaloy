/**
 * 锁账本 —— 网关的账本，不是实例的通用属性。
 *
 * 对应 FOUNDATION_V5.md §9：
 *   L1 锁只在网关穿越时产生；内核专有，5 种，零配置
 *   L2 owner 唯一是容器；容器内实例（含纯转发边）永不持锁
 *
 * 为什么恰好是"跨网关"：容器内网是有限且完全可见的图，"还有没有东西能动"
 * **本地可判定**（扫一遍消息就行），不需要记账；只有跨网关的等待不可判定
 * （队列里随时可能来消息），才必须记账。
 *
 * **锁不承担正确性。** 强制截断永远可用（§9.1），所以锁记错了不会卡死系统，
 * 只会导致本该自动回收的没自动回收 —— 安全方向的失败。因此这里刻意零配置：
 * 只有内核在这 5 个位置记账，agent 没有任何 API 能碰锁表。
 */

import type { TraceId } from "@nodeflow/contracts";

export const LOCK_KINDS = ["request", "child", "approval", "timer", "manual"] as const;
export type LockKind = (typeof LOCK_KINDS)[number];

export interface Lock {
  readonly id: string;
  /** 唯一 owner = 容器。节点实例不持锁。 */
  readonly holder: TraceId;
  /** 在等谁。等人审批 / 等定时器时为 undefined。 */
  readonly waitingOn?: TraceId;
  /** 哪个节点发起的 —— **仅供展示，不参与调度门控**。 */
  readonly originNode?: string;
  readonly kind: LockKind;
  /** request_id / 子实例 traceid / 审批单号 …… */
  readonly key: string;
  readonly since: number;
}

export interface AcquireInput {
  readonly holder: TraceId;
  readonly kind: LockKind;
  readonly key: string;
  readonly waitingOn?: TraceId;
  readonly originNode?: string;
}

export class LockLedger {
  readonly #locks = new Map<string, Lock>();
  #seq = 0;
  #clock = 0;

  acquire(input: AcquireInput): Lock {
    this.#seq += 1;
    this.#clock += 1;
    const lock: Lock = Object.freeze({
      id: `lock-${this.#seq}`,
      holder: input.holder,
      kind: input.kind,
      key: input.key,
      since: this.#clock,
      ...(input.waitingOn === undefined ? {} : { waitingOn: input.waitingOn }),
      ...(input.originNode === undefined ? {} : { originNode: input.originNode }),
    });
    this.#locks.set(lock.id, lock);
    return lock;
  }

  release(id: string): boolean {
    return this.#locks.delete(id);
  }

  /** 按 (kind, key) 销账。REPLY 到达、子实例终态都走这里。 */
  releaseByKey(kind: LockKind, key: string): readonly Lock[] {
    const hit = [...this.#locks.values()].filter((l) => l.kind === kind && l.key === key);
    for (const lock of hit) this.#locks.delete(lock.id);
    return hit;
  }

  /** 某容器**持有**的锁 —— 终止判定的第三个谓词看这个。 */
  held(holder: TraceId): readonly Lock[] {
    return [...this.#locks.values()].filter((l) => l.holder === holder);
  }

  /**
   * 某实例**在别处造成**的锁 —— 强制截断第 4 步反向清账看这个。
   * 漏了这条，父容器会永远等一个已死的子。
   */
  causedBy(trace: TraceId): readonly Lock[] {
    return [...this.#locks.values()].filter((l) => l.waitingOn === trace);
  }

  all(): readonly Lock[] {
    return [...this.#locks.values()].sort((a, b) => a.since - b.since);
  }

  find(kind: LockKind, key: string): Lock | undefined {
    return [...this.#locks.values()].find((l) => l.kind === kind && l.key === key);
  }

  /**
   * 等待图里的环 = 死锁。
   *
   * **只报警，不裁决**（观测不裁决）。返回参与环的容器 traceid 集合，
   * 供画布高亮，由人来断。
   */
  deadlocks(): readonly (readonly TraceId[])[] {
    const edges = new Map<TraceId, Set<TraceId>>();
    for (const lock of this.#locks.values()) {
      if (lock.waitingOn === undefined) continue;
      const set = edges.get(lock.holder) ?? new Set<TraceId>();
      set.add(lock.waitingOn);
      edges.set(lock.holder, set);
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
}
