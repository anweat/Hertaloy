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
  /**
   * `slot` 是**声明**，`instance` 是它的实现，`node` 是一步。
   *
   * 加 `slot` 不是加第五种元素 —— 它仍然是"有端口、可能有内部的东西"，
   * 只是处在"已声明、尚未实现"的状态。少了它，定义面上**声明了还没 spawn
   * 的子槽整个不存在**，而那恰恰是"可实例化"的那个位置。
   * 与"从没命中过的订阅仍然要画"是同一条道理。
   */
  readonly kind: "instance" | "node" | "slot";
  /** 实例填的是哪个子槽；根实例没有。 */
  readonly slot?: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly label: string;
  /** 身份 —— 色相由它哈希得到。实例用模板 ref，节点用 handler / agent 名。 */
  readonly identity: string;
  readonly ports: readonly Anchor[];

  // ── 通道 ──
  /**
   * 生存期，按**消息序号**度量 —— `to` 为 null 表示还活着。
   *
   * 这是"生命周期"那条轴的落点：实例的生存期是一段区间，渲染成带的长度，
   * 于是"谁还活着 / 谁死了 / 谁比谁活得久"一眼可读，不用靠颜色编码。
   *
   * ⚠️ **是推出来的，不是内核记的。** `ContainerInstance` 只有 status，
   * 没有出生/终止序号，所以这里取"最早/最晚碰到这个 traceid 的消息"。
   * 后果：早于窗口（最近 200 条）的出生点看不见，会被截在窗口左沿。
   * 真要精确得内核记一笔 —— 和 `Message.source` 是同一类缺口，
   * 但这个近似够画图，先不动内核。
   */
  readonly span: { readonly from: number; readonly to: number | null };
  /** 这个 cell 上发生过消息的序号 —— 带上的刻点。 */
  readonly marks: readonly number[];
  /**
   * **结构性进度** —— 能从现有数据推出来的那一半。
   *
   *   子槽    已终止实例 / 已创建实例    扇出场景下这就是进度，也是最常用的那种
   *   实例    已碰过的节点 / 模板节点数
   *
   * ⚠️ 实例那一条**对有环的流程没有意义**：循环会反复碰同一批节点，
   * 分母不动而分子早就到顶。所以它是"覆盖率"不是"完成度"，别当进度条用。
   *
   * 真正的语义进度（"我在跑第 3 组测试"）内核**原则上**推不出来 ——
   * 有环的流程没有分母。那一半只能靠 agent 上报，是另一件事。
   */
  readonly progress?: { readonly done: number; readonly total: number };
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
  /**
   * 这条流实际发生过的序号。空数组 = 声明了但从没走过。
   *
   * 序号轴布局里，一条消息就是**在某个序号上从一条道跳到另一条道**，
   * 所以"何时"和"何事"一样是渲染要的。
   */
  readonly at: readonly number[];
  readonly tunnel?: string;
  readonly contract?: string;
}

/**
 * 系 —— 不承载消息的连接。和 Flow 的区别是**有没有东西在流动**。
 *
 * `waits` 与前三种有一点不同：前三种是结构性的（改了模板才会变），
 * 它是**运行期的、会消失的**。归在同一个元素里是因为判据仍然成立
 * （它不承载消息，只是一条有向的关系），但渲染上该让它看起来是"活的"。
 */
export interface Tether {
  readonly from: string;
  readonly to: string;
  readonly relation: "contains" | "refs" | "derives" | "waits";
  /** `waits` 专用：锁的种类，说明为什么在等。 */
  readonly because?: string;
}

export interface Scene {
  /** 序号轴的范围 —— 渲染器拿它当横轴刻度。 */
  readonly range: { readonly from: number; readonly to: number };
  readonly cells: readonly Cell[];
  readonly cards: readonly Card[];
  readonly flows: readonly Flow[];
  readonly tethers: readonly Tether[];
  /** 视口 = traceid 前缀。裁剪就是前缀查询。 */
  readonly viewport: string;
}
