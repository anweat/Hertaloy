/**
 * 场景差量 —— **派生，不记账**。
 *
 * 渲染器不需要每次都收一整份场景：一次提交往往只动一两个单元，而整份场景
 * 会随实例数与消息数一起长。差量只送变的那些。
 *
 * ## 为什么不做成"内核发变更事件"
 *
 * 想过让内核记一本变更日志。**不做** —— 那是给内核加第二本账，而两份拷贝
 * 必然漂移（锁账本、`#workspaces`、`pending` 都是这么被删掉的）。
 * 这里的差量是从**两份权威场景**当场算出来的：算错了下一轮就自己纠正，
 * 不存在"账和事实分家"这种状态。
 *
 * 代价如实说：服务侧每轮仍要全量重算一份场景。省的是**线上与渲染**那一段。
 * 要省服务侧那一段才需要真的变更日志 —— 等它成为瓶颈再说。
 *
 * ## 只有一种形状
 *
 * 第一帧不是"全量"、后续不是"增量" —— **第一帧就是与空场景的差量**。
 * 于是流上只有一种消息，接收方不必写两套解析。
 */

import type { Card, Cell, Flow, Scene, Tether } from "./scene.js";

/** 一类元素的变化。`removed` 只给键，因为收信方已经有那份内容。 */
export interface Change<T> {
  readonly added: readonly T[];
  readonly changed: readonly T[];
  readonly removed: readonly string[];
}

export interface SceneDelta {
  readonly viewport: string;
  readonly range: Scene["range"];
  readonly cells: Change<Cell>;
  readonly cards: Change<Card>;
  readonly flows: Change<Flow>;
  readonly tethers: Change<Tether>;
}

/** 空场景 —— 第一帧的比较基准。 */
export function emptyScene(viewport = ""): Scene {
  return { range: { from: 0, to: 0 }, cells: [], cards: [], flows: [], tethers: [], viewport };
}

/** 唯一的键法。`removed` 里给的就是它，消费方照着删即可。 */
const byId = (x: { readonly id: string }): string => x.id;

function diffBy<T>(prev: readonly T[], next: readonly T[], key: (t: T) => string): Change<T> {
  const before = new Map(prev.map((t) => [key(t), t]));
  const added: T[] = [];
  const changed: T[] = [];
  const seen = new Set<string>();

  for (const item of next) {
    const k = key(item);
    seen.add(k);
    const old = before.get(k);
    if (old === undefined) {
      added.push(item);
    } else if (JSON.stringify(old) !== JSON.stringify(item)) {
      // 逐字节比对：场景元素都是纯数据，构造顺序稳定，序列化就是可比的
      changed.push(item);
    }
  }
  const removed = [...before.keys()].filter((k) => !seen.has(k));
  return { added, changed, removed };
}

export function diffScenes(prev: Scene, next: Scene): SceneDelta {
  return {
    viewport: next.viewport,
    range: next.range,
    // 四个集合现在都有 id，键法只剩一种 —— 少一处能各自走偏的地方
    cells: diffBy(prev.cells, next.cells, byId),
    cards: diffBy(prev.cards, next.cards, byId),
    flows: diffBy(prev.flows, next.flows, byId),
    tethers: diffBy(prev.tethers, next.tethers, byId),
  };
}

/**
 * 这一帧什么都没动吗。
 *
 * **`range` 不算数**：它是序号轴的量程，随时间漂移但不代表图变了。
 * 把它算进去，静止的 run 也会每轮吐一帧 —— 那正是这套东西要省掉的。
 */
export function isEmptyDelta(d: SceneDelta): boolean {
  const flat = [d.cells, d.cards, d.flows, d.tethers];
  return flat.every((c) => c.added.length === 0 && c.changed.length === 0 && c.removed.length === 0);
}
