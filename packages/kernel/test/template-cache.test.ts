/**
 * ★ 模板解析按**版本对象**记一份 —— 而这份记忆过期在结构上不可能。
 *
 * `#template(ref)` 原来每次调用都对整份模板做一次 zod `safeParse`，
 * 而 `#pickWork` 对**每一步的每一条排队消息**都调它 —— 于是 drain 是
 * M²/2 次全量解析。实测（`packages/kernel/bench.mts`，同口径分进程）：
 *
 *     M=200   198.0ms → 21.5ms      M=800   7715.8ms → 181.9ms
 *     M=400   735.4ms → 50.7ms      M=1600 26836.1ms → 755.4ms
 *
 * 缓存的键是 `ObjectVersion` **对象本身**，不是 ref 字符串。版本深冻结、
 * 每次 `put` 造新对象、事务回滚是把数组截短 —— 所以"同一个 ref 指向不同
 * 内容"在这里表现为**换了一个键**，而不是一条脏记录。下面第二条钉的就是它。
 */

import { expect, it } from "vitest";
import { InstanceRegistry } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";

const tplWith = (node: string) => ({
  nodes: { [node]: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {},
  children: {},
});

it("同一个固定 ref 反复取，拿到的是同一个对象 —— 没有重复解析", () => {
  const store = new ObjectStore();
  store.put("tpl", "root_config", tplWith("a"));
  const reg = new InstanceRegistry(store);
  reg.createRoot("tpl@1", "job");

  const first = reg.template("job");
  expect(reg.template("job")).toBe(first);
  expect(reg.template("job")).toBe(first);
  expect(Object.keys(first.nodes)).toEqual(["a"]);
});

it("★ 回滚后同一个 ref 换了内容 → 读到的是新内容，不是旧缓存", () => {
  const store = new ObjectStore();
  const empty = store.snapshot();
  store.put("tpl", "root_config", tplWith("a"));
  const reg = new InstanceRegistry(store);
  reg.createRoot("tpl@1", "job");
  expect(Object.keys(reg.template("job").nodes)).toEqual(["a"]); // 先把 tpl@1 读进缓存

  // 事务回滚把 tpl@1 抹掉，同一个 ref 上换一份内容重新落
  store.restore(empty);
  store.put("tpl", "root_config", tplWith("b"));

  // ★ 键是版本对象 —— 上一版那个对象已经拿不到了，所以命不中
  expect(Object.keys(reg.template("job").nodes)).toEqual(["b"]);
});

it("坏模板照旧当场报错，失败不进缓存也不变成静默成功", () => {
  const store = new ObjectStore();
  const empty = store.snapshot();
  store.put("tpl", "root_config", tplWith("a"));
  const reg = new InstanceRegistry(store);
  reg.createRoot("tpl@1", "job"); // 建实例这一步就会解析一次，所以先给合法的
  expect(Object.keys(reg.template("job").nodes)).toEqual(["a"]);

  // 同一个 ref 换成一份不合法的内容
  store.restore(empty);
  store.put("tpl", "root_config", { nodes: { a: { kind: "不是这个" } } });

  expect(() => reg.template("job")).toThrow(/不是合法容器模板/);
  // 第二次仍然报错 —— 解析失败不写缓存，也没被上一版的成功结果顶替
  expect(() => reg.template("job")).toThrow(/不是合法容器模板/);
});

it("缓存的解析结果不能被调用方改写，固定版本与运行读取保持一致", () => {
  const store = new ObjectStore();
  store.put("tpl", "root_config", tplWith("a"));
  const reg = new InstanceRegistry(store);
  reg.createRoot("tpl@1", "job");
  const parsed = reg.template("job");
  try { parsed.nodes.a!.ports.in!.direction = "emit"; } catch { /* 冻结对象拒绝赋值 */ }
  expect(reg.template("job").nodes.a!.ports.in!.direction).toBe("receive");
  expect(store.resolve("tpl@1").body).toEqual(tplWith("a"));
});
