/**
 * 伪 3D 球面渲染器 —— 第一版。
 *
 * 四层，一层 WebGL 都不用（RENDERING.md §6）：
 *
 *   1. 球面着色    径向渐变（光源固定左上）+ 高光斑 + 边缘暗
 *   2. 半透明容器  子实例浮在父球**里面** —— 归属关系因此不用画线
 *   3. 景深        z = 嵌套深度：越深越小、越淡
 *   4. 视差        留给动效轮，要交互才看得出来
 *
 * 配色规矩：色相 = 身份（哈希），明度锁死，饱和度由状态调制。
 * 这里只**读** `swatch()` 给的颜色 —— 颜色不进场景，也不在渲染器里现编。
 *
 * 布局是渲染器自己的事（场景里没有 position）：这一版用最朴素的
 * 环形嵌套，够看出结构就行。物理与生长树是后面两个渲染器。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

// ── 配色：与 packages/scene/src/color.ts 同一套规矩 ────────────────
const L_LIGHT = 0.94;
const L_BASE = 0.8;
const L_SHADE = 0.62;
const C_BASE = 0.13;
const CHROMA = { idle: 0.35, running: 1.15, done: 0.85, failed: 0.5, voided: 0.2 };

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const identityHue = (id) => (hash32(id) % 3600) / 10;
const oklch = (l, c, h, a = 1) =>
  `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${a === 1 ? "" : ` / ${a}`})`;

function swatch(identity, phase, activity = 0) {
  const h = identityHue(identity);
  const c = C_BASE * (CHROMA[phase] ?? 1);
  const lift = Math.min(Math.max(activity, 0), 1) * 0.05;
  return {
    hue: h,
    base: oklch(L_BASE + lift, c, h),
    light: oklch(L_LIGHT, c * 0.6, h),
    shade: oklch(L_SHADE, c, h),
    rim: oklch(0.98, c * 0.4, h, 0.9),
  };
}

function flowColor(contract, certainty) {
  const a = 0.15 + Math.min(Math.max(certainty, 0), 1) * 0.7;
  if (contract === undefined) return oklch(0.65, 0.01, 250, a);
  return oklch(0.62, 0.11, identityHue(contract), a);
}

// ── 布局：环形嵌套。场景里没有 position，位置是渲染器的事 ──────────
function layout(scene) {
  const byId = new Map(scene.cells.map((c) => [c.id, c]));
  const childrenOf = new Map();
  for (const cell of scene.cells) {
    if (cell.parent === null || !byId.has(cell.parent)) continue;
    if (!childrenOf.has(cell.parent)) childrenOf.set(cell.parent, []);
    childrenOf.get(cell.parent).push(cell);
  }

  const placed = new Map();

  /** 一个 Cell 要多大：叶子给基准，容器由内部撑开。 */
  function radiusOf(cell) {
    const kids = childrenOf.get(cell.id) ?? [];
    if (kids.length === 0) return cell.kind === "instance" ? 34 : 26;
    const inner = kids.map(radiusOf);
    const biggest = Math.max(...inner);
    // 够放下一圈孩子，再留一点边距 —— 容器是"装得下"，不是"画得大"
    const ring = kids.length === 1 ? biggest : (biggest * 1.25) / Math.sin(Math.PI / kids.length);
    return ring + biggest + 26;
  }

  function place(cell, cx, cy) {
    const r = radiusOf(cell);
    placed.set(cell.id, { cell, cx, cy, r });
    const kids = childrenOf.get(cell.id) ?? [];
    if (kids.length === 0) return;
    const inner = Math.max(...kids.map(radiusOf));
    const ring = kids.length === 1 ? 0 : (inner * 1.25) / Math.sin(Math.PI / kids.length);
    // 从正上方起排，顺时针 —— 顺序稳定，图才不会每次刷新都换个样
    kids.forEach((kid, i) => {
      const angle = (i / kids.length) * Math.PI * 2 - Math.PI / 2;
      place(kid, cx + Math.cos(angle) * ring, cy + Math.sin(angle) * ring);
    });
  }

  const roots = scene.cells.filter((c) => c.parent === null || !byId.has(c.parent));
  let x = 0;
  for (const root of roots) {
    const r = radiusOf(root);
    place(root, x + r, r);
    x += r * 2 + 60;
  }
  return placed;
}

// ── 绘制 ───────────────────────────────────────────────────────────
function el(name, attrs, ...kids) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

/**
 * 一个球的渐变。**光源固定左上，全场一致** —— 不一致会立刻穿帮。
 */
function sphereGradient(id, sw) {
  return el(
    "radialGradient",
    { id, cx: "0.35", cy: "0.3", r: "0.75" },
    el("stop", { offset: "0%", "stop-color": sw.light }),
    el("stop", { offset: "55%", "stop-color": sw.base }),
    el("stop", { offset: "100%", "stop-color": sw.shade }),
  );
}

export function render(scene, host) {
  const placed = layout(scene);
  const all = [...placed.values()];
  const maxX = Math.max(...all.map((p) => p.cx + p.r)) + 40;
  const maxY = Math.max(...all.map((p) => p.cy + p.r)) + 40;

  const defs = el("defs");
  const svg = el("svg", {
    xmlns: SVG_NS,
    viewBox: `-20 -20 ${maxX} ${maxY}`,
    width: "100%",
  });
  svg.append(defs);

  // 柔和阴影 —— 飘着的东西阴影要淡而散
  defs.append(
    el(
      "filter",
      { id: "soft", x: "-40%", y: "-40%", width: "180%", height: "180%" },
      el("feGaussianBlur", { in: "SourceAlpha", stdDeviation: "6" }),
      el("feOffset", { dy: "5", result: "off" }),
      el(
        "feComponentTransfer",
        {},
        el("feFuncA", { type: "linear", slope: "0.18" }),
      ),
      el("feMerge", {}, el("feMergeNode"), el("feMergeNode", { in: "SourceGraphic" })),
    ),
  );

  const gShadow = el("g");
  const gFlow = el("g");
  const gCell = el("g");
  const gLabel = el("g");
  svg.append(gShadow, gFlow, gCell, gLabel);

  // ── 球：由外向内画（深度浅的先），于是嵌套天然叠对 ──
  const order = all.sort((a, b) => a.cell.depth - b.cell.depth);
  for (const { cell, cx, cy, r } of order) {
    const sw = swatch(cell.identity, cell.phase, cell.activity);
    const gid = `s-${cell.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
    defs.append(sphereGradient(gid, sw));

    const isContainer = cell.kind === "instance";
    /**
     * 景深：越深越淡。**容器还要更透** —— 子实例得从它里面看得见，
     * 而"看得见里面"就是 contains 关系本身，所以这一类连接不用画线。
     */
    const depthFade = Math.max(0.35, 1 - cell.depth * 0.12);
    const opacity = isContainer ? depthFade * 0.42 : depthFade;

    gShadow.append(
      el("ellipse", {
        cx,
        cy: cy + r * 0.92,
        rx: r * 0.72,
        ry: r * 0.16,
        fill: "oklch(0.55 0.02 250)",
        opacity: (0.1 * depthFade).toFixed(3),
      }),
    );

    gCell.append(
      el("circle", {
        cx,
        cy,
        r,
        fill: `url(#${gid})`,
        opacity: opacity.toFixed(3),
        stroke: isContainer ? sw.rim : "none",
        "stroke-width": isContainer ? 1.5 : 0,
      }),
    );

    // 高光斑 —— 一个圆读成球，最便宜的那一下
    gCell.append(
      el("ellipse", {
        cx: cx - r * 0.3,
        cy: cy - r * 0.36,
        rx: r * 0.26,
        ry: r * 0.17,
        fill: "white",
        opacity: (isContainer ? 0.25 : 0.5) * depthFade,
        transform: `rotate(-25 ${cx - r * 0.3} ${cy - r * 0.36})`,
      }),
    );

    const label = el(
      "text",
      {
        x: cx,
        y: isContainer ? cy - r + 18 : cy + 4,
        "text-anchor": "middle",
        "font-size": isContainer ? 12 : 11,
        "font-weight": isContainer ? 600 : 500,
        fill: "oklch(0.35 0.02 250)",
        opacity: depthFade,
      },
    );
    label.textContent = cell.label;
    gLabel.append(label);
  }

  // ── 流：certainty 决定虚实与浓淡；边恒 1，隧道靠命中累积 ──
  for (const f of scene.flows) {
    const to = placed.get(f.to.cell);
    if (to === undefined) continue;
    const color = flowColor(f.contract, f.certainty);

    if (f.from === null) {
      /**
       * 从没命中过的订阅 —— 画成挂在落点上的一根须。
       * "声明了但从没人往这儿发"是很值钱的观察，不该因为没流量就消失。
       */
      gFlow.append(
        el("path", {
          d: `M ${to.cx} ${to.cy} q -26 -20 -44 -6`,
          stroke: color,
          "stroke-width": 1.5,
          "stroke-dasharray": "2 5",
          fill: "none",
          "stroke-linecap": "round",
        }),
      );
      continue;
    }

    const from = placed.get(f.from.cell);
    if (from === undefined) continue;
    const mx = (from.cx + to.cx) / 2;
    const my = (from.cy + to.cy) / 2 - Math.abs(to.cx - from.cx) * 0.12;
    const d = `M ${from.cx} ${from.cy} Q ${mx} ${my} ${to.cx} ${to.cy}`;

    // 隐形加宽命中路径（Node-RED 那招）—— 低 certainty 的线很淡，不加宽点不中
    gFlow.append(
      el("path", { d, stroke: "transparent", "stroke-width": 20, fill: "none" }),
    );
    gFlow.append(
      el("path", {
        d,
        stroke: color,
        "stroke-width": (1 + f.certainty * 2).toFixed(2),
        "stroke-dasharray": f.certainty >= 1 ? null : `${3 + f.certainty * 8} ${6 - f.certainty * 4}`,
        fill: "none",
        "stroke-linecap": "round",
      }),
    );
  }

  // ── 卡：无端口、不可寻址，所以不参与连线，贴在主人身边 ──
  for (const card of scene.cards) {
    const owner = placed.get(card.owner);
    if (owner === undefined) continue;
    const sw = swatch(card.kind, "done", 0);
    const cx = owner.cx + owner.r * 0.72;
    const cy = owner.cy - owner.r * 0.72;
    gCell.append(
      el("rect", {
        x: cx - 9,
        y: cy - 11,
        width: 18,
        height: 22,
        rx: 3,
        fill: sw.base,
        stroke: sw.shade,
        "stroke-width": 0.8,
        transform: `rotate(-8 ${cx} ${cy})`,
      }),
    );
  }

  host.replaceChildren(svg);
  return svg;
}
