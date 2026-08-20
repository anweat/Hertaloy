/**
 * 场景 —— 渲染器拿到的全部东西，没有别的入口（RENDERING.md §3）。
 *
 * 固定词汇：**2 实体 + 2 连接**。判据是可证伪的 ——
 * 补新后端时如果需要第五种元素，说明这套词汇错了。
 *
 * 两条铁规矩：
 *   **颜色不进场景** —— 只带身份（`identity` / `contract`），颜色由 color.ts 推导
 *   **位置不进场景** —— 场景是拓扑 + 通道，位置是渲染器的事
 *
 * 后一条正是两个渲染器（静态生长树 / 球链物理）能吃同一份数据的原因。
 */

/** 渲染需要区分的状态。三个执行状态 + 三个终止压成这五个。 */
export type Phase = "idle" | "running" | "done" | "failed" | "voided";

/** 端口 —— Cell 上的一个锚点，不是实体（§2.5）。 */
export interface Anchor {
  readonly name: string;
  readonly direction: "receive" | "emit";
  /** 契约 id → 查色表得颜色。**不存颜色。** */
  readonly contract?: string;
}

export interface AnchorRef {
  readonly cell: string;
  readonly port: string;
}

/**
 * 胞 —— 有端口、可能有内部的东西。
 *
 * **节点和实例是同一种元素**：`ChildSlot.entry` 已经定义了子树如何以单个
 * 端口的身份被寻址，所以折叠视图是内核本来就有的投影，不是前端发明的简化。
 */
export interface Cell {
  readonly id: string;
  readonly kind: "instance" | "node";
  readonly parent: string | null;
  readonly depth: number;
  readonly label: string;
  /** 身份 —— 色相由它哈希得到。实例用模板 ref，节点用 handler / agent 名。 */
  readonly identity: string;
  readonly ports: readonly Anchor[];

  // ── 通道 ──
  readonly phase: Phase;
  /** 0..1，最近窗口里的流量 → 亮度 */
  readonly activity: number;
  /** 内部规模 → 泡泡半径 / 子树宽度 */
  readonly extent: number;
  readonly pinned: boolean;
}

/** 卡 —— 无端口、不可寻址、只能被引用。 */
export interface Card {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly owner: string;
  readonly version: number;
}

/**
 * 流 —— 可能承载消息的连接。
 *
 * **边和隧道是同一种元素的两个确定度**：边 certainty 恒 1（注册期证实），
 * 隧道靠命中累积。于是"染色渐显、多次命中固化成假边"不是特效，
 * 是 `certainty` 这个通道的可视化本身。
 */
export interface Flow {
  readonly id: string;
  /** 隧道从没命中过时为 null —— 仍然要画，画成挂在落点上的一根须。 */
  readonly from: AnchorRef | null;
  readonly to: AnchorRef;
  readonly certainty: number;
  readonly activity: number;
  readonly tunnel?: string;
  readonly contract?: string;
}

/** 系 —— 不承载消息的连接。和 Flow 的区别是有没有东西在流动。 */
export interface Tether {
  readonly from: string;
  readonly to: string;
  readonly relation: "contains" | "refs" | "derives";
}

export interface Scene {
  readonly cells: readonly Cell[];
  readonly cards: readonly Card[];
  readonly flows: readonly Flow[];
  readonly tethers: readonly Tether[];
  /** 视口 = traceid 前缀。裁剪就是前缀查询。 */
  readonly viewport: string;
}
