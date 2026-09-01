/**
 * 执行记录 —— claim / execute / apply 的持久事实。
 *
 * 从 `runtime.ts` 抽出来的第三块。与 `queue.ts` 同一个路子：这里只回答
 * "有哪些执行、各自什么状态"，不回答"下一步该 claim 谁"（那是调度）。
 *
 * ## 两种寿命，刻意分开
 *
 * 这个类装着**两样寿命不同的东西**，混在一个对象里是有理由的，但绝不能混在
 * 一份快照里：
 *
 * | | `records` | `driving` |
 * |---|---|---|
 * | 是什么 | 一次执行的持久事实 | 本进程正在驱动哪些 (实例, 节点) |
 * | 寿命 | 跨进程，落盘 | **进程本地**，重启即空 |
 * | 落盘 | ✅ 在 head 里 | ❌ 绝不 |
 *
 * 放一起，是因为**孤儿判定要同时读这两样**：
 *
 * > 孤儿 = 记录还是 `RUNNING` ∧ 本进程没在驱动它
 *
 * "有没有进程在跑"根本不是持久状态。正因为 `driving` 重启即空，
 * 上一个进程留下的 `RUNNING` 记录才会在新进程里自动显形为孤儿 ——
 * 这不是靠额外的状态机（`RECONCILING` / `ADOPTED` / `ABANDONED`），
 * 是靠两种寿命的差。§17.14 说的就是这件事。
 *
 * 拆成两个类反而会把这条判定切开，那才是把一个事实弄成两处。
 */

import { InvariantError } from "./errors.js";
import type { TraceId, Termination, Usage } from "@nodeflow/contracts";
import type { Snapshotable } from "./tx.js";

/**
 * 还在跑吗。
 *
 * 早先这里有七个值，而实测：七个里只有 `RUNNING` 被代码分支读过，其余六个
 * 只写不读，是**伪装成状态的展示数据**。所以拆成两个字段，各自只表达一件事：
 *
 *   status      还在跑吗（唯一被分支的）
 *   termination 怎么结束的（`Termination` 是唯一权威，不再有第二套编码）
 */
export type ExecutionStatus = "RUNNING" | "SETTLED" | "VOIDED";

/** claim/execute/apply 的持久事实 —— 取消与崩溃接管的唯一依据。 */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly status: ExecutionStatus;
  /**
   * 怎么结束的。`RUNNING` 时没有；`VOIDED` 时无意义 —— 结果被栅栏丢掉了，
   * backend 说了什么都不作数。
   */
  readonly termination?: Termination;
  /** 被 claim 的消息集合 —— 冲突域的一半。 */
  readonly claimed: readonly string[];
  /** claim 时的实例 generation —— 冲突域的另一半，apply 时复核（L3）。 */
  readonly generation: number;
  readonly usage?: Usage;
}

interface LedgerSnapshot {
  readonly records: Map<string, ExecutionRecord>;
  readonly seq: number;
}

/** `(实例, 节点)` —— 冲突域的门就开在这个粒度上。 */
function slot(traceid: TraceId, nodeId: string): string {
  return `${traceid}/${nodeId}`;
}

export class ExecutionLedger implements Snapshotable {
  readonly #records = new Map<string, ExecutionRecord>();
  #seq = 0;
  /**
   * **进程本地**，不进快照（见文件头）。
   *
   * `transact` 也管不着它 —— 回滚不会撤销这里的增删，所以增删的时机要自己拿捏：
   * 置位推迟到"确定要执行"之后，清除放在状态收口的同一处。
   */
  readonly #driving = new Set<string>();

  snapshot(): unknown {
    return { records: new Map(this.#records), seq: this.#seq };
  }

  restore(snap: unknown): void {
    const s = snap as LedgerSnapshot;
    this.#records.clear();
    for (const [k, v] of s.records) this.#records.set(k, v);
    this.#seq = s.seq;
    // `#driving` **刻意不恢复**：装载的那一刻，本进程一个都没在驱动。
    // 上一个进程留下的 RUNNING 记录因此自动显形为孤儿。
  }

  nextId(): string {
    this.#seq += 1;
    return `exec-${this.#seq}`;
  }

  put(record: ExecutionRecord): void {
    this.#records.set(record.executionId, Object.freeze({ ...record }));
  }

  /** 按 id 取。**取不到是编程错误** —— id 只由本类发放。 */
  get(executionId: string): ExecutionRecord {
    const found = this.#records.get(executionId);
    if (found === undefined) throw new InvariantError(`未知 execution：${executionId}`);
    return found;
  }

  all(): readonly ExecutionRecord[] {
    return [...this.#records.values()];
  }

  /** 打补丁。与消息一样是换新对象，不原地改。 */
  replace(executionId: string, patch: Partial<ExecutionRecord>): void {
    this.put({ ...this.get(executionId), ...patch });
  }

  // --- 进程本地：本进程在驱动谁 -------------------------------------------

  isDriving(traceid: TraceId, nodeId: string): boolean {
    return this.#driving.has(slot(traceid, nodeId));
  }

  markDriving(traceid: TraceId, nodeId: string): void {
    this.#driving.add(slot(traceid, nodeId));
  }

  releaseDriving(traceid: TraceId, nodeId: string): void {
    this.#driving.delete(slot(traceid, nodeId));
  }

  /** 本进程正在驱动的数量 —— 只给用例与排查看。 */
  drivingCount(): number {
    return this.#driving.size;
  }

  /**
   * 孤儿：记录还是 `RUNNING`，而**本进程没在驱动它**。
   *
   * 判定同时读两种寿命的东西，这正是它们放在一个类里的理由。
   */
  orphans(): readonly ExecutionRecord[] {
    return this.all().filter((r) => r.status === "RUNNING" && !this.isDriving(r.traceid, r.nodeId));
  }
}
