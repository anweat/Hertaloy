/**
 * 别名三块的**时机边界** —— 把注释里的纪律变成红灯。
 *
 * `aliases/` 按时机分成 check / materialize / resolve，各自只许读该时机能读的
 * 东西。这条限制的执行者是 **import 图**，不是自觉：
 *
 *   check.ts       注册期   只许读模板         → 够不着 resolve / materialize
 *   materialize.ts 实例化期 模板 + 父实例的表   → 够不着 check / resolve
 *   resolve.ts     运行期   自己的表 + 实例存活 → 只许单向取 materialize 的类型
 *
 * 没有这个文件，那条纪律就只是三段注释 —— 而注释拦不住"顺便 import 一下"。
 * 这与"半状态不可表达"是同一条路子：**结构性保证优于纪律**，但结构性保证
 * 本身也得有人钉。
 *
 * ## 为什么值得单独写一个文件来验
 *
 * 拆开的时候它们**本来就没有**跨时机耦合 —— 拆不是在修什么，买的是"将来
 * 长不歪"。而"将来"这种东西，只有留下一个会响的东西才拦得住。
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALIASES = join(HERE, "..", "src", "aliases");

/**
 * 一段源码 import / re-export 了哪些模块（只看说明符，不解析）。
 *
 * 判据只有这一份 —— 下面的反例用例也喂它，免得"什么都没抓到"被当成"没有违规"。
 */
function importSpecifiers(src: string): readonly string[] {
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
}

function importsOf(file: string): readonly string[] {
  return importSpecifiers(readFileSync(join(ALIASES, file), "utf8"));
}

/** kernel 里那些**运行期**部件 —— 注册期与实例化期一个都不该碰。 */
const RUNTIME_MODULES = ["queue", "executions", "runtime", "instances", "store", "obligations"];

function touchesRuntime(specs: readonly string[]): readonly string[] {
  return specs.filter((s) => RUNTIME_MODULES.some((m) => s.includes(`/${m}.js`)));
}

describe("三块只按时机彼此够得着", () => {
  it("目录里就这四个文件 —— 多一个就该想清楚它属于哪个时机", () => {
    expect(readdirSync(ALIASES).sort()).toEqual([
      "check.ts",
      "index.ts",
      "materialize.ts",
      "resolve.ts",
    ]);
  });

  it("★ 注册期够不着运行期：check.ts 不 import 另外两块", () => {
    const specs = importsOf("check.ts");
    expect(specs.filter((s) => s.includes("resolve"))).toEqual([]);
    expect(specs.filter((s) => s.includes("materialize"))).toEqual([]);
  });

  it("★ 实例化期够不着运行期：materialize.ts 不 import 另外两块", () => {
    const specs = importsOf("materialize.ts");
    expect(specs.filter((s) => s.includes("resolve"))).toEqual([]);
    expect(specs.filter((s) => s.includes("check"))).toEqual([]);
  });

  it("运行期只单向取实例化期的类型，够不着注册期", () => {
    const specs = importsOf("resolve.ts");
    expect(specs.filter((s) => s.includes("check"))).toEqual([]);
    expect(specs.some((s) => s.includes("materialize"))).toBe(true);
  });

  it("★ 三块都够不着内核的运行期部件（队列 / 执行记录 / 注册表 / 对象库）", () => {
    for (const file of ["check.ts", "materialize.ts", "resolve.ts"]) {
      expect(touchesRuntime(importsOf(file))).toEqual([]);
    }
  });

  it("只有 index.ts 汇总，而且只汇总这三块", () => {
    // 用集合，不钉精确多重集 —— 后者会因为多导出一个符号就红，那是噪声
    expect([...new Set(importsOf("index.ts"))].sort()).toEqual([
      "./check.js",
      "./materialize.js",
      "./resolve.js",
    ]);
  });

  it("★ 守卫真的会响 —— 喂它一段越界源码，判据当场抓住", () => {
    /**
     * 没这条的话，上面几条全绿也可能只是因为正则一个都没匹配上 ——
     * "什么都没抓到"和"没有违规"长得一模一样。这正是这个项目一路在防的形状，
     * 所以守卫自己也要有反例。
     */
    const offending = [
      'import { resolveAlias } from "./resolve.js";',
      'import { MessageQueue } from "../queue.js";',
      'export { checkAliases } from "./check.js";',
    ].join("\n");

    const specs = importSpecifiers(offending);
    expect(specs).toEqual(["./resolve.js", "../queue.js", "./check.js"]);
    // 跨时机的两条都抓得住
    expect(specs.filter((x) => x.includes("resolve"))).toEqual(["./resolve.js"]);
    expect(specs.filter((x) => x.includes("check"))).toEqual(["./check.js"]);
    // 碰运行期部件的那条也抓得住
    expect(touchesRuntime(specs)).toEqual(["../queue.js"]);
  });
});
