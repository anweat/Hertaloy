/**
 * 别名寻址 —— 按**时机**分成三块，各自只许读该时机能读的东西。
 *
 * | 文件 | 时机 | 只许读 |
 * |---|---|---|
 * | `check.ts` | 注册期 | 模板 |
 * | `materialize.ts` | 实例化期 | 模板 + 父实例的表 |
 * | `resolve.ts` | 运行期 | 实例自己的表 + 本租户实例存活 |
 *
 * ## 为什么按时机分，而不是按"函数多了就拆"
 *
 * 这三段本来在一个文件里，**没有**跨时机耦合 —— 拆开不是在修什么。
 * 拆的是**将来长歪的可能**：注册期校验哪天想调 `resolveAlias`，它就需要
 * 运行期事实，而同一个文件里没有任何东西拦着。分开之后连 import 都拿不到。
 *
 * 这与"半状态不可表达"是同一条路子：**结构性保证优于纪律**。而时间轴
 * （注册期 → 实例化 → 运行期）本来就是这个项目反复用的那根 ——
 * §7.3「位置即绑定时机」、§5.1 eager 物化、B1 注册期预算，都在这根轴上。
 *
 * 依赖方向：`resolve` → `materialize`（只取类型）。`check` 与另外两个
 * **互相够不着**。
 */

export type { MaterializedBinding } from "./materialize.js";
export { childBindings, rootBindings } from "./materialize.js";
export type { InstanceFact } from "./resolve.js";
export { resolveAlias } from "./resolve.js";
export type { AliasCheck, AliasIssue } from "./check.js";
export { aliasesUsed, checkAliases, checkRootAliases, receiveEndpoints } from "./check.js";
