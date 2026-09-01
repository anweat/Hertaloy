/**
 * 消息队列 —— 内网与网关的传输本身。
 *
 * 从 `runtime.ts` 抽出来的第一块。抽的理由不是行数，是**职责边界清楚**：
 * 这里只回答"有哪些消息、各自什么状态、投递顺序如何"，不回答"下一条该谁跑"
 * （那是调度，要读实例状态与模板，留在 Runtime）。
 *
 * ## 三条纪律
 *
 * 1. **消息是冻结对象**，改状态一律换一个新对象（`replace`）。共享可变消息
 *    会让"提交是事务"这条在回滚时失真 —— 快照拷的是引用。
 * 2. **`order` 是投递顺序，不是优先级**。`prune` 依赖它判断谁更老；
 *    调度策略读的是它的一个过滤视图，两者别混。
 * 3. **落盘形状由 Runtime 合成**，本类不认识 head。抽出来不改持久化格式，
 *    是为了让这一步能单独回滚。
 */

import { InvariantError } from "./errors.js";
import type { Endpoint, Json, MessageSource, TraceId } from "@nodeflow/contracts";
import type { Snapshotable } from "./tx.js";

export type MessageState = "QUEUED" | "CLAIMED" | "CONSUMED" | "FAILED" | "DISCARDED";

export interface Message {
  readonly id: string;
  readonly target: Endpoint;
  readonly payload: Json;
  readonly state: MessageState;
  readonly failure?: string;
  /** 经哪个别名出的网关。观测用；内网边传递时不带。 */
  readonly alias?: string;
  /**
   * 谁发的 —— **观测用，不是路由用**（详见 contracts 的 MessageSource）。
   *
   * 补它是因为渲染层要的一件事从现有数据完全推不出来：网关消息带 `alias`
   * 和 `target`，却不带来源，于是"这次命中是从哪个实例来的"算不出 ——
   * 而那正是"让浮动节点的命中被看见"这件事本身。扇入边（多条边汇到同一端口）
   * 也有同样的歧义。
   *
   * 省略 = 外部注入（人 / CLI / MCP）。图外来的消息本来就没有图内的来源。
   */
  readonly source?: MessageSource;
  /** 协议级关联，**绝不进 payload**。 */
  readonly requestId?: string;
  readonly inReplyTo?: string;
  readonly attempts: number;
}

/** 还会动的状态。其余三种都已了结。 */
export const LIVE_MESSAGE_STATES: readonly MessageState[] = ["QUEUED", "CLAIMED"];

export function isLive(message: Message): boolean {
  return LIVE_MESSAGE_STATES.includes(message.state);
}

interface QueueSnapshot {
  readonly messages: Map<string, Message>;
  readonly order: string[];
  readonly seq: number;
}

export class MessageQueue implements Snapshotable {
  readonly #messages = new Map<string, Message>();
  /** 投递顺序。`prune` 与调度都读它，但读法不同（见文件头纪律 2）。 */
  readonly #order: string[] = [];
  #seq = 0;
  /**
   * 保留多少条**已消费**消息。负数表示不清理。
   *
   * 这是头唯一无界增长的来源，而头**每次提交全量重写** —— 于是累计写入是
   * 消息数的平方级。实测：2000 条已消费消息 → head.json 1.1 MB，
   * 而其中在队列里的是 0 条。
   */
  #keepConsumed: number;

  constructor(keepConsumed: number) {
    this.#keepConsumed = keepConsumed;
  }

  snapshot(): unknown {
    return { messages: new Map(this.#messages), order: [...this.#order], seq: this.#seq };
  }

  restore(snap: unknown): void {
    const s = snap as QueueSnapshot;
    this.#messages.clear();
    for (const [k, v] of s.messages) this.#messages.set(k, v);
    this.#order.length = 0;
    this.#order.push(...s.order);
    this.#seq = s.seq;
  }

  /** 投一条新消息，返回它的 id。 */
  enqueue(spec: Omit<Message, "id" | "state" | "attempts">): string {
    this.#seq += 1;
    const id = `msg-${this.#seq}`;
    this.#messages.set(id, Object.freeze({ ...spec, id, state: "QUEUED" as const, attempts: 0 }));
    this.#order.push(id);
    return id;
  }

  /** 按 id 取。**取不到是编程错误**，不是空值 —— 消息 id 只由本类发放。 */
  get(id: string): Message {
    const found = this.#messages.get(id);
    if (found === undefined) throw new InvariantError(`未知消息：${id}`);
    return found;
  }

  has(id: string): boolean {
    return this.#messages.has(id);
  }

  /** 全部消息，**按投递顺序**。 */
  all(): readonly Message[] {
    return this.#order.map((id) => this.#messages.get(id) as Message);
  }

  /** 还在排队的（`QUEUED`）。调度从这里取活。 */
  queued(): readonly Message[] {
    return this.all().filter((m) => m.state === "QUEUED");
  }

  /** 某实例名下还会动的消息（`QUEUED` / `CLAIMED`）。 */
  liveFor(trace: TraceId): readonly Message[] {
    return this.all().filter((m) => m.target.traceid === trace && isLive(m));
  }

  setState(id: string, state: MessageState, failure?: string): void {
    this.replace(id, failure === undefined ? { state } : { state, failure });
  }

  replace(id: string, patch: Partial<Message>): void {
    this.#messages.set(id, Object.freeze({ ...this.get(id), ...patch }));
  }

  /**
   * 回收已消费消息。
   *
   * **不丢 `DISCARDED`**，那是截断留下的，迟到的结果还要靠它走冲突域复核（L3）；
   * 也不丢 `FAILED`，那是排查现场。只丢 `CONSUMED` —— 它已经产生过下游了。
   */
  prune(): void {
    if (this.#keepConsumed < 0 || this.#messages.size <= this.#keepConsumed * 2) return;
    const consumed: string[] = [];
    for (const id of this.#order) {
      if (this.#messages.get(id)?.state === "CONSUMED") consumed.push(id);
    }
    const excess = consumed.length - this.#keepConsumed;
    if (excess <= 0) return;
    // `#order` 是投递顺序，所以前面的就是更老的
    const doomed = new Set(consumed.slice(0, excess));
    for (const id of doomed) this.#messages.delete(id);
    const kept = this.#order.filter((id) => !doomed.has(id));
    this.#order.length = 0;
    this.#order.push(...kept);
  }
}
