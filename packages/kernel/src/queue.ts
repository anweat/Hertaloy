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
 * 2. **`order` 是投递顺序，不是优先级**。落库时它就是 `$msg` 的写入序；
 *    调度策略读的是它的一个过滤视图，两者别混。
 * 3. **落盘形状由 Runtime 合成**，本类不认识 head。抽出来不改持久化格式，
 *    是为了让这一步能单独回滚。
 *
 * ## 队列里只有活的（V6 阶段 5）
 *
 * 消息一进终态就落进对象库、离开队列（Runtime 的 `#settleMessage`）。所以
 * `all()` / `get()` 答的是**在途**，不是全部 —— 完整的那份问 `Runtime.messages()`。
 * 队列因此不再是"历史 + 在途"两用的容器，`prune` 那套取舍随之消失。
 */

import { InvariantError } from "./errors.js";
import type { Endpoint, Json, MessageSource, TraceId } from "@nodeflow/contracts";
import type { Snapshotable } from "./tx.js";
import { type MessageFact, type MessageState, isLive } from "./facts.js";

/**
 * 终态消息落在哪 —— 与 `execLog` 同形：**按节点分对象，一条一版**。
 *
 * 不用"一个 trace 一个大对象"：对象库每版存整份正文，那样每落一条消息就重写
 * 一次全量，正是刚从头里赶走的那个平方级。
 */
export function msgLog(traceid: TraceId, nodeId: string): string {
  return `${traceid}/${nodeId}/$msg`;
}

/**
 * `msg-N` → N —— **投递序**。
 *
 * 号是本文件的 `enqueue` 发的，所以在这儿解析它不是"猜格式"，是**发号方读自己的号**。
 * （渲染层另有一份同样的解析，那边是消费方，理由不同：它没有别的时间刻度可用。）
 *
 * 要它是因为终态消息落库之后按「实例 × 节点 × 版本」取回来，那是**按节点分组**，
 * 不是投递序 —— 而下游的染色窗口取的是"最后 N 条"。不排序就会取成"最后一个节点的 N 条"。
 */
export function deliveryOrderOf(messageId: string): number {
  const m = /(\d+)$/.exec(messageId);
  return m === null ? 0 : Number(m[1]);
}

/**
 * 完整的消息。`MessageFact`（`facts.ts`）是它里面纯函数用得上的那部分。
 */
export interface Message extends MessageFact {
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
  readonly attempts: number;
}

interface QueueSnapshot {
  readonly messages: Map<string, Message>;
  readonly order: string[];
  readonly seq: number;
}

export type { MessageState } from "./facts.js";
export { isLive, LIVE_MESSAGE_STATES } from "./facts.js";

export class MessageQueue implements Snapshotable {
  readonly #messages = new Map<string, Message>();
  /** 投递顺序。落库写入序与调度都读它，但读法不同（见文件头纪律 2）。 */
  readonly #order: string[] = [];
  #seq = 0;


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

  /**
   * 还在排队的（`QUEUED`）。调度从这里取活。
   *
   * 直接按投递顺序挑，**不先 `all()` 物化整张表再过滤** —— `#pickWork`
   * 每一步都调它，中间那个 M 长数组是纯浪费（M 条消息 ⇒ M 步 ⇒ M² 次分配）。
   */
  queued(): readonly Message[] {
    return this.#select((m) => m.state === "QUEUED");
  }

  /** 某实例名下还会动的消息（`QUEUED` / `CLAIMED`）。 */
  liveFor(trace: TraceId): readonly Message[] {
    return this.#select((m) => m.target.traceid === trace && isLive(m));
  }

  /** 按投递顺序筛，只分配结果那一份。 */
  #select(keep: (m: Message) => boolean): readonly Message[] {
    const out: Message[] = [];
    for (const id of this.#order) {
      const m = this.#messages.get(id) as Message;
      if (keep(m)) out.push(m);
    }
    return out;
  }

  setState(id: string, state: MessageState, failure?: string): void {
    this.replace(id, failure === undefined ? { state } : { state, failure });
  }

  replace(id: string, patch: Partial<Message>): void {
    this.#messages.set(id, Object.freeze({ ...this.get(id), ...patch }));
  }

  /**
   * 移出队列 —— **只由 Runtime 的终态收口点调用**（`#settleMessage`）。
   *
   * 这里原来是 `prune()`：按 `keepConsumedMessages` 保留最近 N 条已消费消息，
   * 其余丢弃。那套机制在丢一件**只有队列里有**的东西，所以它必须在
   * "头会无界涨"与"历史会消失"之间选一个，两边都不对。
   *
   * 现在终态消息先落进对象库（`<traceid>/<node>/$msg` 一版）再离队 ——
   * 于是丢的只是内存里的第二份，历史一条不少。选择因此不存在了，
   * `keepConsumedMessages` 也跟着消失。
   *
   * `#seq` **不回退**：消息 id 全局单调，离队不释放号段。
   */
  drop(id: string): void {
    if (!this.#messages.delete(id)) return;
    const at = this.#order.indexOf(id);
    if (at >= 0) this.#order.splice(at, 1);
  }
}
