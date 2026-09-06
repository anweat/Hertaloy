/**
 * ★ traceid 作为**路径**，在深处是否处处一致。
 *
 * traceid 这一个字符串同时是六样东西：
 *
 *   实例身份 · 子树查询的前缀 · 对象库的命名空间 · 落盘的目录路径 ·
 *   授权的作用域 · 画布视口的裁剪键
 *
 * 段边界前缀判定（`isDescendantOf`）是它们共用的规则，但**代码里有三处
 * 各自重写了一遍**（`store.collect`、`scene/build`、`state/snapshot`）。
 * 当前三处等价，可这条规则已经因为"某处自成一格"出过一次事
 * （按 `job-1/` 回收漏掉 `run/job-1/…`）。
 *
 * 更要紧的是：绝大多数用例只到**两层**（`job-1/coder-1`）。而"嵌套容器"
 * 是这个内核的立身之本 —— 三层以上整条路通不通，此前没有任何用例回答。
 */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState, writePermissions } from "@nodeflow/state";
import { objectDir } from "@nodeflow/state";
import { scene, show } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;

/** 叶子：没有子槽。 */
const LEAF = {
  nodes: { work: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {},
  children: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-deep-"));
  const s = RunState.open(dir);
  try {
    const leaf = registerContainerTemplate(s.store, "leaf", LEAF);
    const mid = registerContainerTemplate(s.store, "mid", {
      nodes: { relay: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
      edges: {},
      children: { leaves: { template: leaf } },
    });
    const root = registerContainerTemplate(
      s.store,
      "root",
      {
        nodes: { top: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
        edges: {},
        children: { mids: { template: mid } },
      },
      "root_config",
    );
    s.registry.createRoot(root, "job-1");
    // 三层：job-1 → job-1/mid-1 → job-1/mid-1/leaf-1
    s.registry.spawn("job-1", "mids", "mid-1");
    s.registry.spawn("job-1/mid-1", "leaves", "leaf-1");
    // 兄弟支，用来检验前缀不越界
    s.registry.spawn("job-1", "mids", "mid-2");
    // 深处写一个对象 —— 命名空间也在深处
    s.store.put("job-1/mid-1/leaf-1/result", "artifact", { text: "深处的产物" });
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("★ 子树与直接子容器：段边界，不是字符串前缀", () => {
  it("subtree 按段边界收，children 只收一层", () => {
    const s = RunState.open(dir, { readOnly: true });
    try {
      expect(s.registry.subtree("job-1").map((i) => i.traceid)).toEqual([
        "job-1",
        "job-1/mid-1",
        "job-1/mid-1/leaf-1",
        "job-1/mid-2",
      ]);
      // 从中层看下去：只有它自己和它的叶子，兄弟支不在
      expect(s.registry.subtree("job-1/mid-1").map((i) => i.traceid)).toEqual([
        "job-1/mid-1",
        "job-1/mid-1/leaf-1",
      ]);
      // 直接子容器只有一层，孙子不算
      expect(s.registry.children("job-1").map((i) => i.traceid)).toEqual([
        "job-1/mid-1",
        "job-1/mid-2",
      ]);
    } finally {
      s.close();
    }
  });

  it("★ `mid-1` 不覆盖 `mid-10` —— 段边界的意义就在这", () => {
    const s = RunState.open(dir);
    try {
      s.registry.spawn("job-1", "mids", "mid-10");
      // 字符串前缀会把 mid-10 算进 mid-1 的子树；段边界不会
      expect(s.registry.subtree("job-1/mid-1").map((i) => i.traceid)).toEqual([
        "job-1/mid-1",
        "job-1/mid-1/leaf-1",
      ]);
    } finally {
      s.close();
    }
  });
});

describe("★ 同一条前缀规则在对象库、磁盘、授权、画布上都成立", () => {
  it("对象命名空间：按前缀收得到深处的产物", () => {
    const s = RunState.open(dir, { readOnly: true });
    try {
      expect(s.store.collect("job-1", "result").map((v) => v.object_id)).toEqual([
        "job-1/mid-1/leaf-1/result",
      ]);
      // 从中层收也收得到；从兄弟支收不到
      expect(s.store.collect("job-1/mid-1", "result")).toHaveLength(1);
      expect(s.store.collect("job-1/mid-2", "result")).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  it("落盘目录就是那条路径，逐段展开", () => {
    expect(objectDir("job-1/mid-1/leaf-1/result")).toBe("job-1/mid-1/leaf-1/result");
    expect(existsSync(join(dir, "objects", "job-1", "mid-1", "leaf-1", "result", "@1.json"))).toBe(
      true,
    );
  });

  it("★ 授权作用域到中层：够得着叶子，够不着兄弟支", () => {
    writePermissions(dir, [{ principal: "agent:mid", scope: "job-1/mid-1", ops: ["DQL"] }]);
    const MID = { kind: "agent", id: "mid" } as const;

    // 深处的对象读得到 —— object_id 也是这条 traceid 命名空间
    expect(show(dir, MID, "job-1/mid-1/leaf-1/result@1").code).toBe(0);
    // 而根与兄弟支读不到
    expect(scene(dir, MID, "job-1").code).toBe(1);
    expect(scene(dir, MID, "job-1/mid-2").code).toBe(1);
    /**
     * ★ 自己的作用域可以，**而且拿得到能画的图**。
     *
     * 这条断言不是多余的：模板住在 traceid 树**之外**的扁平命名空间
     * （`mid@1` → 授权目标是 `mid`）。一度给模板单独加了授权，于是被授权看
     * 自己子树的主体反而拿不到定义，画出来的是没有节点的空壳 ——
     * 报错是"无权对 `mid` 执行 DQL"，而 `mid` 根本不在任何 traceid 作用域里。
     *
     * 授权单位是实例子树；模板跟着实例走。节点单元存在，就是这条的证据。
     */
    const r = scene(dir, MID, "job-1/mid-1");
    expect(r.code).toBe(0);
    const cells = (JSON.parse(r.text) as { cells: { id: string; kind: string }[] }).cells;
    expect(cells.some((c) => c.kind === "node")).toBe(true);
  });

  it("★ 画布视口用同一条规则裁剪，深度也对得上", () => {
    const full = JSON.parse(scene(dir, HUMAN).text) as {
      cells: { id: string; kind: string; depth: number }[];
    };
    const ids = full.cells.filter((c) => c.kind === "instance").map((c) => c.id);
    expect(ids).toContain("job-1/mid-1/leaf-1");
    // 深度是 traceid 的段数免费得来的，不需要另一本账
    expect(full.cells.find((c) => c.id === "job-1")?.depth).toBe(0);
    expect(full.cells.find((c) => c.id === "job-1/mid-1")?.depth).toBe(1);
    expect(full.cells.find((c) => c.id === "job-1/mid-1/leaf-1")?.depth).toBe(2);

    // 视口收到中层：兄弟支不在，叶子在
    const zoomed = JSON.parse(scene(dir, HUMAN, "job-1/mid-1").text) as {
      viewport: string;
      cells: { id: string; kind: string }[];
    };
    const zids = zoomed.cells.filter((c) => c.kind === "instance").map((c) => c.id);
    expect(zoomed.viewport).toBe("job-1/mid-1");
    expect(zids).toContain("job-1/mid-1/leaf-1");
    expect(zids).not.toContain("job-1/mid-2");
    expect(zids).not.toContain("job-1");
  });
});
