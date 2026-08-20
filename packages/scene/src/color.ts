/**
 * 自动色彩 —— **色相是身份，明度和饱和度是状态**。
 *
 * 这条分工是整套配色的全部规矩：
 *
 *   色相 hue    由身份（模板 ref / 契约 id）哈希得到 —— 同一个模板的所有实例同色，
 *               一眼看出"这五个泡泡是同一种 worker"
 *   明度 L      锁死。所有球视觉重量相同，没有一个比别的吵 —— 这就是"简洁明亮"
 *   饱和 C      由状态调制：idle 降饱和、running 提饱和
 *
 * ## 为什么是 OKLCH 而不是 HSL
 *
 * HSL 固定 L **根本不管用**：同样 `hsl(x, 60%, 70%)`，黄色区域看着明显更亮、
 * 蓝色明显更暗。于是"锁死明度"落空，画面会有几个球莫名其妙地跳出来。
 * OKLCH 是感知均匀的 —— 等距的 hue 步长看起来才等距，锁死 L 才真的锁得住。
 *
 * ## 哈希碰撞不处理
 *
 * 两个模板色相撞近了就撞近了。**全局稳定**（同一个模板永远同色、刷新不变、
 * 你我看到的一样）比"这一屏内最大区分"值钱得多 —— 后者要按当前可见集合
 * 去挪色相，一平移一展开颜色就变，那才是真的看不懂。
 *
 * 真撞疼了的修法是加**第二重身份线索**（同一个哈希派生的小标记），不是动色相。
 *
 * ## failed / voided 不靠颜色
 *
 * 色相已经被身份占满了。异常状态靠**形状**：failed 瘪掉（不再是正球），
 * voided 收缩消失。顺带对色盲友好。
 */

import type { Phase } from "./scene.js";

/** FNV-1a。要的只是"稳定且散得开"，不需要密码学强度。 */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 身份 → 色相角。同一个 id 永远同一个角，跨进程跨刷新都一样。 */
export function identityHue(identity: string): number {
  return (hash32(identity) % 3600) / 10;
}

export interface Swatch {
  /** 球体主色 */
  readonly base: string;
  /** 高光（光源固定左上） */
  readonly light: string;
  /** 暗部与接触阴影 */
  readonly shade: string;
  /** 边缘光 —— 半透明容器靠它读出"这是个泡" */
  readonly rim: string;
}

/** 锁死的明度。三个值分别给高光 / 主体 / 暗部，全场一致。 */
const L_LIGHT = 0.94;
const L_BASE = 0.8;
const L_SHADE = 0.62;

/** 状态 → 饱和度倍率。只动 C，不动 L。 */
const CHROMA: Record<Phase, number> = {
  idle: 0.35,
  running: 1.15,
  done: 0.85,
  failed: 0.5,
  voided: 0.2,
};

const C_BASE = 0.13;

function oklch(l: number, c: number, h: number, alpha = 1): string {
  const a = alpha === 1 ? "" : ` / ${alpha}`;
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${a})`;
}

/**
 * 身份 + 状态 → 一组色。
 *
 * `activity` 只在主体色上加一点点明度（最多 +0.05）—— 让"刚有消息流过"
 * 看得出来，但不至于把锁死明度这条规矩废掉。
 */
export function swatch(identity: string, phase: Phase, activity = 0): Swatch {
  const h = identityHue(identity);
  const c = C_BASE * (CHROMA[phase] ?? 1);
  const lift = Math.min(Math.max(activity, 0), 1) * 0.05;
  return {
    base: oklch(L_BASE + lift, c, h),
    light: oklch(L_LIGHT, c * 0.6, h),
    shade: oklch(L_SHADE, c, h),
    rim: oklch(0.98, c * 0.4, h, 0.9),
  };
}

/**
 * 连接的颜色。有契约就跟契约的色相，没有就走中性灰。
 *
 * 中性灰是**有意的**：一条没声明契约的边，视觉上就该比声明了的弱一点。
 */
export function flowColor(contract: string | undefined, certainty: number): string {
  const a = 0.15 + Math.min(Math.max(certainty, 0), 1) * 0.7;
  if (contract === undefined) return oklch(0.65, 0.01, 250, a);
  return oklch(0.62, 0.11, identityHue(contract), a);
}
