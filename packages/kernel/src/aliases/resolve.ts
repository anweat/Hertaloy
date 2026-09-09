/**
 * 别名**解析** —— 运行期。
 *
 * > **只许读：实例自己的绑定表 + 本租户的实例存活状态。**
 * > 不看祖先的定义，不看兄弟的表。
 *
 * 单向依赖 `materialize.ts`（只取类型）：运行期读的是实例化期产出的东西，
 * 反过来不成立。注册期（`check.ts`）与这里**互相够不着** —— 那正是按时机
 * 分文件要的结构性保证。
 *
 * ## 三种目标，三条边界
 *
 *   | 绑定形态 | 解析要读什么 | 边界 |
 *   |---|---|---|
 *   | 本容器节点 | 只读自己的表 | 实例内 |
 *   | 子槽       | 表 + `container` 的子实例存活状态 | **租户内** |
 *   | `external` | 只读自己的表 | **跨租户，只经协议** |
 *
 * 第三种是"单个实例自身要能维护所有情况"逼出来的：槽枚举要读别的实例的存活
 * 状态，在自己的子树里没问题（那些实例本就归它管），跨租户就成了"去问对面
 * 还活着没"。所以跨界一律投一条消息到一个地址，**扇出由对面自己决定**。
 *
 * 副产品：跨界的 REQUEST「恰好 1 个」是构造性成立的（一个地址就是一个）。
 */

import {
  type Endpoint,
  type TraceId,
  endpointAt,
  parentTrace as parentOf,
} from "@nodeflow/contracts";
import type { InstanceFact } from "../facts.js";
import type { MaterializedBinding } from "./materialize.js";

export type { InstanceFact } from "../facts.js";

/**
 * 用实例自己的表解析一个别名。**不看祖先，不看兄弟。**
 *
 * 返回 0 个 = 没人接。PUBLISH 时是 dangling（观测，不是错误），
 * REQUEST 时是错误。"REQUEST 恰好 1 个"仍是运行期判定，但判据从
 * "全树扫描的结果"收成了"这个子槽里有几个活实例" —— 有界、本地、可归责。
 */
export function resolveAlias(
  bindings: readonly MaterializedBinding[],
  instances: readonly InstanceFact[],
  alias: string,
): readonly Endpoint[] {
  const out: Endpoint[] = [];
  for (const b of bindings) {
    if (b.alias !== alias) continue;
    if (b.external !== undefined) {
      // 不透明地址：不枚举对面，投一条就完
      out.push(endpointAt(b.external as TraceId, b.node, b.port));
      continue;
    }
    if (b.slot === undefined) {
      out.push(endpointAt(b.container, b.node, b.port));
      continue;
    }
    for (const inst of instances) {
      if (inst.status !== "OPEN") continue;
      if (inst.slot !== b.slot) continue;
      if (parentOf(inst.traceid) !== b.container) continue;
      out.push(endpointAt(inst.traceid, b.node, b.port));
    }
  }
  return out;
}

