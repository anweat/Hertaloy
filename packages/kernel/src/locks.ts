/**
 * 锁 —— **已经不是一张表了，是义务枚举的展示投影。**
 *
 * 原本这里是 `LockLedger`：一个可变的 `Map`，由 `spawn` / `settle` / `truncate` /
 * `#commitPlan` 四处记账。证伪实验（`test/obligations.test.ts` + 跨 353 条既有
 * 用例的普查）给出的结论是：
 *
 * > **账本里没有任何一行承载着推不出来的事实。**
 *
 * 于是它是同一事实的第二份拷贝，而两份拷贝必然漂移 —— 与 §3.2 拒绝在信封里
 * 存 `causation_ids` 是同一条论证。普查当场抓到了那次漂移：服务方被截断时，
 * 账本销了账、`#pending` 没删，两边对同一个请求给出相反的答案。
 *
 * 删掉账本之后，那类 bug **不可能再发生**：
 *
 *   - 子实例一进终态，父的这份义务当场消失 —— 不必"记得"销账
 *   - 请求一了结，`#pending` 删掉，义务当场消失 —— 不必"记得"反向清账
 *   - 造不出"有子实例但没有对应义务"的半状态 —— 它不可表达
 *
 * 保留 `Lock` 这个**形状**，是因为它是给人看的词汇（画布上的"阻塞锁"、
 * `hertaloy status` 的输出）。它现在每次现算，没有任何东西维护它。
 *
 * L1/L2 两条不变量原样成立，只是落点变了：
 *   L1  义务只在网关穿越与嵌套处产生（`request` / `child` 两种 kind）
 *   L2  owner 唯一是容器 —— `Obligation.holder` 永远是 traceid
 */

import type { TraceId } from "@nodeflow/contracts";
import { type Obligation, deadlocks as cyclesOf } from "./obligations.js";

export const LOCK_KINDS = ["request", "child"] as const;
export type LockKind = (typeof LOCK_KINDS)[number];

export interface Lock {
  readonly id: string;
  /** 唯一 owner = 容器。节点实例不持锁。 */
  readonly holder: TraceId;
  /** 在等谁。`request` 等服务方，`child` 等子实例。 */
  readonly waitingOn?: TraceId;
  /** 哪个节点发起的 —— **仅供展示，不参与调度门控**。 */
  readonly originNode?: string;
  readonly kind: LockKind;
  /** request_id / 子实例 traceid */
  readonly key: string;
  /** 派生顺序。义务枚举的顺序是稳定的，所以这个也是。 */
  readonly since: number;
}

function isLockKind(kind: string): kind is LockKind {
  return (LOCK_KINDS as readonly string[]).includes(kind);
}

/**
 * 只读视图 —— **没有 `acquire` / `release`**。
 *
 * 少掉的那两个方法就是这次归约的全部内容：以前它们是四处记账点，
 * 现在没有记账这回事。
 */
export class LockView {
  readonly #locks: readonly Lock[];

  constructor(obligations: readonly Obligation[]) {
    let seq = 0;
    const out: Lock[] = [];
    for (const o of obligations) {
      if (!isLockKind(o.kind)) continue;
      seq += 1;
      out.push(
        Object.freeze({
          id: `lock-${seq}`,
          holder: o.holder,
          kind: o.kind,
          key: o.key,
          since: seq,
          ...(o.waitingOn === undefined ? {} : { waitingOn: o.waitingOn }),
          ...(o.originNode === undefined ? {} : { originNode: o.originNode }),
        }),
      );
    }
    this.#locks = Object.freeze(out);
  }

  /** 某容器**持有**的锁 —— 终止判定看的是义务枚举，这里只供展示。 */
  held(holder: TraceId): readonly Lock[] {
    return this.#locks.filter((l) => l.holder === holder);
  }

  /** 某实例**在别处造成**的锁。 */
  causedBy(trace: TraceId): readonly Lock[] {
    return this.#locks.filter((l) => l.waitingOn === trace);
  }

  all(): readonly Lock[] {
    return this.#locks;
  }

  find(kind: LockKind, key: string): Lock | undefined {
    return this.#locks.find((l) => l.kind === kind && l.key === key);
  }

  /**
   * 等待图里的环 = 死锁。**只报警，不裁决**（观测不裁决）。
   * 算法住在 `obligations.ts` —— 那才是等待关系的家。
   */
  deadlocks(): readonly (readonly TraceId[])[] {
    return cyclesOf(
      this.#locks.map((l) => ({
        kind: l.kind,
        holder: l.holder,
        key: l.key,
        ...(l.waitingOn === undefined ? {} : { waitingOn: l.waitingOn }),
      })),
    );
  }
}
