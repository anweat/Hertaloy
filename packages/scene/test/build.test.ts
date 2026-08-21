/**
 * `snapshot → Scene`。
 *
 * 夹具是**真跑出来的**（`packages/state/fixture-gen.mts` 造的那个 run），
 * 不是手编的：对着想象的形状写适配器，是这个项目最熟悉的翻车方式。
 */

import { describe, expect, it } from "vitest";
import { buildScene, nodeCellId, parseSnapshot } from "../src/index.js";
import { FIXTURE } from "./fixture.js";

const scene = buildScene(parseSnapshot(FIXTURE));
const flow = (from: string | null, to: string) =>
  scene.flows.find((f) => (f.from?.cell ?? null) === from && f.to.cell === to);

describe("★ 实体：容器即实例，不是两种元素", () => {
  it("三种 kind：声明的槽、它的实例、实例里的节点", () => {
    const kinds = new Set(scene.cells.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["instance", "node", "slot"]));
  });

  it("深度从 traceid 段数免费得到，不需要额外账本", () => {
    expect(scene.cells.find((c) => c.id === "job-1")?.depth).toBe(0);
    expect(scene.cells.find((c) => c.id === "job-1/a1")?.depth).toBe(1);
    expect(scene.cells.find((c) => c.id === "job-1/a1#scan")?.depth).toBe(2);
  });

  it("★ 同一个模板的两个实例身份相同 → 自动同色", () => {
    const a = scene.cells.find((c) => c.id === "job-1/a1");
    const b = scene.cells.find((c) => c.id === "job-1/a2");
    expect(a?.identity).toBe(b?.identity);
    expect(a?.identity).toBe("worker@1");
  });

  it("agent 节点与内置 handler 是不同身份 —— 颜色该分得开", () => {
    const scan = scene.cells.find((c) => c.id === "job-1/a1#scan");
    expect(scan?.identity).toMatch(/^handler:/);
  });
});

describe("★ 流：边和隧道是同一元素的两个确定度", () => {
  it("内网边 certainty 恒 1 —— 注册期就证实过", () => {
    expect(flow(nodeCellId("job-1", "plan"), nodeCellId("job-1", "merge"))?.certainty).toBe(1);
  });

  it("★ 同一条隧道的两个来源各画一条 —— 这才是补 source 换来的东西", () => {
    const fromA = flow(nodeCellId("job-1/a1", "scan"), nodeCellId("job-1", "watch"));
    const fromB = flow(nodeCellId("job-1/a2", "scan"), nodeCellId("job-1", "watch"));
    expect(fromA?.tunnel).toBe("findings");
    expect(fromB?.tunnel).toBe("findings");
    // 补之前这两条长得一模一样，只能在落点上堆一个数字
    expect(fromA?.from?.cell).not.toBe(fromB?.from?.cell);
  });

  it("隧道 certainty 在 0..1 之间 —— 靠命中累积，不是恒定", () => {
    const t = flow(nodeCellId("job-1/a1", "scan"), nodeCellId("job-1", "watch"));
    expect(t?.certainty).toBeGreaterThan(0);
    expect(t?.certainty).toBeLessThan(1);
  });

  it("★ 从没命中过的订阅仍然出场（from 为 null，certainty 0）", () => {
    const quiet = flow(null, nodeCellId("job-1", "idle"));
    expect(quiet).toBeDefined();
    expect(quiet?.certainty).toBe(0);
    expect(quiet?.tunnel).toBe("silence");
  });
});

describe("★ 卡：每个对象一张，取最新版", () => {
  it("一个对象不管写了几版，只出一张卡", () => {
    expect(new Set(scene.cards.map((c) => c.id)).size).toBe(scene.cards.length);
  });

  it("★ `$` 开头的内核内务不上画布", () => {
    // $run / $exec 该表现为节点的 phase，不该在旁边再摆一张卡说同一件事
    expect(scene.cards.filter((c) => c.label.startsWith("$"))).toEqual([]);
  });

  it("卡归属于写它的那个实例 —— 命名空间就是 traceid 前缀", () => {
    const note = scene.cards.find((c) => c.id === "job-1/a1/note-scan");
    expect(note?.owner).toBe("job-1/a1");
  });
});

describe("★ 场景是纯函数", () => {
  it("同一份快照build 两次，结果逐字节相同", () => {
    const a = buildScene(parseSnapshot(FIXTURE));
    const b = buildScene(parseSnapshot(FIXTURE));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("★ 视口就是前缀 —— 裁剪即前缀查询", () => {
    const zoomed = buildScene(parseSnapshot(FIXTURE), "job-1/a1");
    expect(zoomed.cells.every((c) => c.id.startsWith("job-1/a1"))).toBe(true);
    expect(zoomed.cells.some((c) => c.id.startsWith("job-1/a2"))).toBe(false);
  });
});

describe("★ 边界上 parse，不 as", () => {
  it("形状不符要响，而且指得出是哪个字段", () => {
    expect(() => parseSnapshot({ root: "x", instances: {} })).toThrow(/快照格式不符/);
  });

  it("坏字段的路径出现在错误里", () => {
    expect(() =>
      parseSnapshot({ ...(FIXTURE as object), messages: [{ id: 1, target: {}, state: "X" }] }),
    ).toThrow(/messages\.0/);
  });
});

describe("★ 生命周期是一段区间，不是一个颜色", () => {
  const cell = (id: string) => scene.cells.find((c) => c.id === id);

  it("已终止的实例带有右端 —— 收口", () => {
    expect(cell("job-1/a1")?.span.to).not.toBeNull();
  });

  it("★ 还开着的实例右端为 null —— 带不收口", () => {
    expect(cell("job-1/a3")?.span.to).toBeNull();
    expect(cell("job-1")?.span.to).toBeNull();
  });

  it("★ 晚出生的左端更靠右 —— 出生点看得见", () => {
    const a = cell("job-1/a1")?.span.from ?? 0;
    const b = cell("job-1/a3")?.span.from ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it("节点的生存期继承实例（节点与实例同生共死）", () => {
    expect(cell("job-1/a1#scan")?.span).toEqual(cell("job-1/a1")?.span);
  });

  it("刻点是自己身上发生的事，不是父的", () => {
    const scan = cell("job-1/a1#scan");
    expect(scan?.marks.length).toBeGreaterThan(0);
    expect(cell("job-1#idle")?.marks).toEqual([]); // 从没被碰过
  });

  it("序号轴的范围覆盖所有刻点", () => {
    for (const c of scene.cells) {
      for (const m of c.marks) {
        expect(m).toBeGreaterThanOrEqual(scene.range.from);
        expect(m).toBeLessThanOrEqual(scene.range.to);
      }
    }
  });
});

describe("★ 执行状态：跑着的、失败的、没跑过的", () => {
  const phase = (id: string) => scene.cells.find((c) => c.id === id)?.phase;

  it("agent 在外面跑 → running（这才是有宽度的那段）", () => {
    expect(phase("job-1#review")).toBe("running");
  });

  it("agent 跑失败 → failed，失败往下传", () => {
    expect(phase("job-1#audit")).toBe("failed");
  });

  it("同步 handler 没有执行记录 → idle（它没有可观测的 RUNNING 窗口）", () => {
    expect(phase("job-1#plan")).toBe("idle");
  });
});

describe("★ 子槽：声明是一等公民", () => {
  const slot = (id: string) => scene.cells.find((c) => c.id === id);

  it("声明的子槽出场", () => {
    expect(slot("job-1~a")?.kind).toBe("slot");
    expect(slot("job-1~a")?.identity).toBe("worker@1");
  });

  it("★ 一次都没 spawn 过的槽也出场 —— 声明本身是信息", () => {
    // 与"从没命中过的订阅仍然要画"同一条道理
    expect(slot("job-1~b")).toBeDefined();
    expect(scene.cells.filter((c) => c.parent === "job-1~b")).toEqual([]);
  });

  it("★ 同一个槽的 N 个实例都挂在那个槽上 —— 画布上它们叠在一个位置", () => {
    const onA = scene.cells.filter((c) => c.parent === "job-1~a");
    expect(onA.map((c) => c.id).sort()).toEqual(["job-1/a1", "job-1/a2", "job-1/a3"]);
    expect(onA.every((c) => c.slot === "a")).toBe(true);
  });

  it("★ 叠在一起但命运不同 —— 不是一个东西的三个副本", () => {
    expect(scene.cells.find((c) => c.id === "job-1/a1")?.span.to).not.toBeNull();
    expect(scene.cells.find((c) => c.id === "job-1/a3")?.span.to).toBeNull();
  });

  it("槽带着 entry / exit 锚点 —— 折叠时它就是靠这个被寻址的", () => {
    expect(slot("job-1~a")?.ports.map((p) => p.direction).sort()).toEqual(["emit", "receive"]);
  });

  it("根实例没有槽", () => {
    expect(scene.cells.find((c) => c.id === "job-1")?.slot).toBeUndefined();
  });
});
