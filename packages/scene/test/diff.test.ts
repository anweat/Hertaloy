/**
 * 场景差量 —— 渲染侧要的那一半。
 *
 * 这里钉三件事：
 *   1. 只有一种形状（第一帧 = 与空场景的差量），流上不出现两类消息
 *   2. 没变化就是空差量 —— 静止的 run 不该每轮都吐
 *   3. `range` 漂移不算变化，否则第 2 条永远不成立
 */

import { describe, expect, it } from "vitest";
import { buildScene, parseSnapshot } from "../src/index.js";
import { diffScenes, emptyScene, isEmptyDelta, tetherKey } from "../src/diff.js";
import type { Scene } from "../src/scene.js";
import { FIXTURE } from "./fixture.js";

const full: Scene = buildScene(parseSnapshot(FIXTURE));

describe("★ 只有一种形状：第一帧就是与空场景的差量", () => {
  it("第一帧把整份场景当作 added 送出，不需要另一种「全量帧」", () => {
    const first = diffScenes(emptyScene(full.viewport), full);
    expect(first.cells.added).toHaveLength(full.cells.length);
    expect(first.tethers.added).toHaveLength(full.tethers.length);
    expect(first.cells.changed).toHaveLength(0);
    expect(first.cells.removed).toHaveLength(0);
    expect(isEmptyDelta(first)).toBe(false);
  });

  it("接完第一帧再比，什么都没有 —— 收信方与发信方对上了", () => {
    expect(isEmptyDelta(diffScenes(full, full))).toBe(true);
  });
});

describe("★ 变化按身份认，不按位置", () => {
  it("改一个单元 → 只有它出现在 changed 里", () => {
    const target = full.cells[1]!;
    const next: Scene = {
      ...full,
      cells: full.cells.map((c) => (c.id === target.id ? { ...c, activity: c.activity + 1 } : c)),
    };
    const d = diffScenes(full, next);
    expect(d.cells.changed.map((c) => c.id)).toEqual([target.id]);
    expect(d.cells.added).toHaveLength(0);
    expect(d.cells.removed).toHaveLength(0);
  });

  it("删一个单元 → removed 只给键，不给内容（收信方已经有了）", () => {
    const gone = full.cells[0]!;
    const next: Scene = { ...full, cells: full.cells.filter((c) => c.id !== gone.id) };
    const d = diffScenes(full, next);
    expect(d.cells.removed).toEqual([gone.id]);
  });

  it("顺序变了但内容没变 → 不算变化", () => {
    const next: Scene = { ...full, cells: [...full.cells].reverse() };
    expect(isEmptyDelta(diffScenes(full, next))).toBe(true);
  });

  /**
   * tether 没有 id，用 `{from, to, relation}` 当键 —— 不给它造第二份身份。
   */
  it("tether 按复合键认", () => {
    expect(full.tethers.length).toBeGreaterThan(0);
    const t = full.tethers[0]!;
    expect(tetherKey(t)).toBe(`${t.from} ${t.to} ${t.relation}`);
    const next: Scene = { ...full, tethers: full.tethers.slice(1) };
    expect(diffScenes(full, next).tethers.removed).toEqual([tetherKey(t)]);
  });
});

describe("★ range 漂移不算变化", () => {
  it("只有量程动了 → 仍是空差量，静止的 run 不吐帧", () => {
    const next: Scene = { ...full, range: { from: full.range.from + 5, to: full.range.to + 5 } };
    const d = diffScenes(full, next);
    expect(isEmptyDelta(d)).toBe(true);
    // 但量程本身要带上，收信方画轴要用
    expect(d.range).toEqual(next.range);
  });
});
