/**
 * 授权决策日志 —— **一条缝，不是状态**。
 *
 * ## 它原本在错的地方
 *
 * 这份日志一直挂在 `Runtime` 上（`#audit` + `recordAuthz`），进 `snapshot()`，
 * 随可变头落盘。两处不对：
 *
 * 1. **授权不是编排状态。**Runtime 是纯引擎，它不知道谁在调它 —— 这正是
 *    §11 把权限检查放在 ControlPlane 而不穿进内核签名的理由。日志掉进 Runtime
 *    只是因为 Runtime 恰好持有落盘通路，那是"数据在那儿"，不是"职责在那儿"。
 * 2. **头每次提交全量重写**，所以无界日志会让累计写入变平方级。原来的
 *    `AUDIT_KEEP = 500` 是给这个病打的补丁 —— 补丁本身说明存错了地方。
 *    §17.6 早就写清了：**日志是观测，追加写，不参与重放**。
 *
 * ## 为什么它是合法的缝
 *
 * 判据仍是那条：**换掉它，哪条不变量会破？**
 *
 * 一条都不破。授权的正确性由 `PermissionTable.decide` 加"拒绝就抛"给出；
 * 日志是**证据**，不是判据。换成写文件、写 syslog、丢掉，授权行为一个字不变。
 *
 * 所以它与 `onCommit`、`scheduler` 同类：**能换而且换不坏**。
 *
 * ## 为什么构造 ControlPlane 时必须给
 *
 * 不设默认值、不许省略。`ControlPlane` 在 `RunState` 里是**每次访问现构造**的，
 * 一个"默认内存实现"会在每次构造时新开一份，于是日志每次都是空的 ——
 * 而调用方看不出任何异常。那正是"两端都绿、中间没人走"。
 * 必填就逼每个构造点当场决定日志去哪。
 */

import type { AuditEntry } from "@nodeflow/contracts";

export interface AuthzLog {
  /**
   * 记一次决策。**放行和拒绝都记** —— 被拒的那次尤其要留下，
   * 它往往就是"权限配错了"的现场。
   *
   * `seq` 由实现分配，调用方不给：序号的单调性是日志自己的性质。
   */
  record(entry: Omit<AuditEntry, "seq">): void;
  /** 最近的若干条，旧的在前。给观测与排查用。 */
  recent(limit?: number): readonly AuditEntry[];
}

/**
 * 内存实现，**有界**。给用例与不需要留证据的场合用。
 *
 * 生产里该用落盘的那个（`@nodeflow/state` 的 `FileAuthzLog`）——
 * 进程一退这里就没了，而"事后答得出凭什么放行"要的正是跨进程。
 */
export class BoundedAuthzLog implements AuthzLog {
  #entries: AuditEntry[] = [];
  #seq = 0;
  readonly #keep: number;

  constructor(keep = 500) {
    this.#keep = keep;
  }

  /** 一共记过多少条（含已被挤掉的）—— 只给用例与排查看。 */
  get count(): number {
    return this.#seq;
  }

  record(entry: Omit<AuditEntry, "seq">): void {
    this.#seq += 1;
    this.#entries.push({ ...entry, seq: this.#seq });
    if (this.#entries.length > this.#keep) {
      this.#entries = this.#entries.slice(-this.#keep);
    }
  }

  recent(limit?: number): readonly AuditEntry[] {
    if (limit === undefined) return [...this.#entries];
    return this.#entries.slice(-limit);
  }
}
