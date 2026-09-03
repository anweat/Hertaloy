/**
 * 别名绑定的**物化** —— 实例化期。
 *
 * > **只许读：模板 + 父实例已经算好的表。**
 * > 读不到运行期的任何东西（消息、执行、实例存活状态），也不该读。
 *
 * 这条限制不是靠自觉：本文件只 import contracts 与 `facts.ts`，
 * 拿不到 `resolveAlias`，也拿不到队列或注册表。
 *
 * ## 为什么在这个时机算
 *
 * 与 §5.1 对定义层选 eager 物化是同一条论证：lazy 地每次读走继承链，会让
 * "实例终身 pin 创建时的定义"（C4）变成谎言 —— 祖先事后改绑定，在途实例的
 * 寻址就漂了。
 *
 * 物化还兑现了另一条：**单个实例自身就能维护所有情况，不依靠其他实例**。
 * 这是租户成立的前提 —— 租户将来未必在同一个进程里。
 */

import type { AliasBinding, ContainerTemplate, TraceId } from "@nodeflow/contracts";

export interface MaterializedBinding {
  readonly alias: string;
  readonly container: TraceId;
  readonly slot?: string;
  readonly external?: string;
  readonly node: string;
  readonly port: string;
  readonly inherit: boolean;
}

function materialize(
  bindings: readonly AliasBinding[],
  container: TraceId,
  inherit: boolean,
): readonly MaterializedBinding[] {
  return bindings.map((b) =>
    Object.freeze({
      alias: b.alias,
      container,
      node: b.node,
      port: b.port,
      inherit,
      ...(b.slot === undefined ? {} : { slot: b.slot }),
      ...(b.external === undefined ? {} : { external: b.external }),
    }),
  );
}

/** 根实例的绑定表：只有它自己模板里声明的。 */
export function rootBindings(
  trace: TraceId,
  template: ContainerTemplate,
): readonly MaterializedBinding[] {
  return Object.freeze([
    ...materialize(template.bindings, trace, true),
    ...materialize(template.selfBindings, trace, false),
  ]);
}

/**
 * 子实例的绑定表 —— **spawn 时算一次，此后不再变**。
 *
 * 四个来源，顺序即优先级无关（解析收集全部匹配项，不是最近优先 ——
 * PUBLISH 本来就是 0..N，"最近优先"会把扇出砍成 1）：
 *
 *   1. 父表里可继承的部分（父的 `selfBindings` 被 `inherit: false` 挡在外面）
 *   2. 父模板挂在**这个子槽**上的绑定（只有这一支看得见）
 *   3. 子自己模板的 `bindings`
 *   4. 子自己模板的 `selfBindings`（不再往下传）
 */
export function childBindings(
  childTrace: TraceId,
  childTemplate: ContainerTemplate,
  parentTrace: TraceId,
  parentBindings: readonly MaterializedBinding[],
  slotBindings: readonly AliasBinding[],
): readonly MaterializedBinding[] {
  return Object.freeze([
    ...parentBindings.filter((b) => b.inherit),
    ...materialize(slotBindings, parentTrace, true),
    ...materialize(childTemplate.bindings, childTrace, true),
    ...materialize(childTemplate.selfBindings, childTrace, false),
  ]);
}

