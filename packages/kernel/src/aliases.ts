/**
 * 别名寻址 —— 隧道的替代（FOUNDATION §6.2 网关一节）。
 *
 * ## 为什么换掉隧道
 *
 * 隧道是**全局名字 + 全树扫描 + 逐订阅方求 scope**。三个后果：
 *
 *   1. **"这条 emit 去哪儿"从模板里答不出来** —— 必须模拟运行时才知道。
 *      G1（AI 搭工作流）因此验不了自己搭的图。
 *   2. **隧道名是唯一没有前缀归属的地址空间** —— 两个租户声明同名隧道会互相
 *      看见；更糟的是 REQUEST 要求"恰好 1 个订阅者"，新加一个租户订阅同名隧道
 *      会在**运行期**打断另一个租户，而不是注册期报错。
 *   3. 作用域是投递时逐 (订阅方, 发送方) 求值的一条规则，要单独维护。
 *
 * 别名把解析换成：**沿 traceid 向上查绑定**。第 3 条因此消失 ——
 * `$self_subtree`（"只收本子树发的"，剧本帧 11）不再是一条要检查的规则，
 * 而是查找方向的直接推论：子树外的发送方**根本解析不到这个别名**。
 *
 * ## 物化：实例自给自足
 *
 * 解析**不在运行期走祖先链**，而是在 spawn 时把可见绑定物化成实例自己的一张表。
 * 与 §5.1 对定义层选 eager 物化是同一条论证：lazy 地每次读走继承链，会让
 * "实例终身 pin 创建时的定义"（C4）变成谎言 —— 祖先事后改绑定，在途实例的
 * 寻址就漂了。
 *
 * 物化还兑现了另一条：**单个实例自身就能维护所有情况，不依靠其他实例**，
 * 关联只经协议。这是租户成立的前提 —— 租户将来未必在同一个进程里。
 *
 * ## 三种目标，三条边界
 *
 *   | 绑定形态 | 解析要读什么 | 边界 |
 *   |---|---|---|
 *   | 本容器节点 | 只读自己的表 | 实例内 |
 *   | 子槽       | 表 + `container` 的子实例存活状态 | **租户内** |
 *   | `external` | 只读自己的表 | **跨租户，只经协议** |
 *
 * 第三种是上面那条约束逼出来的：槽枚举要读别的实例的存活状态，在自己的子树里
 * 没问题（那些实例本就归它管），跨租户就成了"去问对面还活着没"。所以跨界一律
 * 投一条消息到一个地址，**扇出由对面自己决定**。
 *
 * 副产品：跨界的 REQUEST「恰好 1 个」是构造性成立的（一个地址就是一个）。
 */

import {
  type AliasBinding,
  type ContainerTemplate,
  type Endpoint,
  type TraceId,
  parentTrace as parentOf,
} from "@nodeflow/contracts";
import type { InstanceFact } from "./facts.js";

export type { InstanceFact } from "./facts.js";

/**
 * 已经属于某个实例自己的绑定。
 *
 * 与 `AliasBinding` 差两个字段：
 *   `container` —— 这条是哪个容器声明的。槽枚举要在**那个容器**名下进行。
 *   `inherit`   —— 子实例物化时要不要带上。`selfBindings` 来的那些是 false。
 */
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
      out.push({ traceid: b.external as TraceId, node: b.node, port: b.port });
      continue;
    }
    if (b.slot === undefined) {
      out.push({ traceid: b.container, node: b.node, port: b.port });
      continue;
    }
    for (const inst of instances) {
      if (inst.status !== "OPEN") continue;
      if (inst.slot !== b.slot) continue;
      if (parentOf(inst.traceid) !== b.container) continue;
      out.push({ traceid: inst.traceid, node: b.node, port: b.port });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 注册期校验
// ---------------------------------------------------------------------------

export interface AliasIssue {
  readonly where: string;
  readonly message: string;
}

/** 一份模板用到的别名（emit 端口声明的）。 */
export function aliasesUsed(template: ContainerTemplate): readonly string[] {
  const out = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    for (const port of Object.values(node.ports)) {
      if (port.direction === "emit" && port.alias !== undefined) out.add(port.alias);
    }
  }
  return [...out].sort();
}

/** 可作为投递目标的 receive 端点，形如 `node.port`。 */
export function receiveEndpoints(template: ContainerTemplate): readonly string[] {
  const out: string[] = [];
  for (const [nodeId, node] of Object.entries(template.nodes)) {
    for (const [portName, port] of Object.entries(node.ports)) {
      if (port.direction === "receive") out.push(`${nodeId}.${portName}`);
    }
  }
  return out.sort();
}

export interface AliasCheck {
  readonly issues: readonly AliasIssue[];
  /** 还欠更外层提供的别名。根上必须为空。 */
  readonly unresolved: readonly string[];
}

/**
 * 校验一份模板的别名绑定，并算出它还欠外层什么。
 *
 * 判定式：
 *
 *   unresolved(t) = t 自己用到但没绑的
 *                 ∪ ⋃ (unresolved(子) − 父在那个子槽上提供的绑定)
 *
 * 递归到根终止 —— 与 §3.1「根是递归的终止条件」是同一个终止点。
 * 这不是新机制：`validateChildEntries` 已经在父注册时跨模板校验子槽的 `entry`。
 *
 * **于是两件事分开了**：绑定存在性是静态的（注册期拒绝），实例数量是动态的
 * （运行期）。隧道时代这两件糊在一起，都要等运行期才炸。
 */
export function checkAliases(
  templateId: string,
  template: ContainerTemplate,
  lookup: (ref: string) => ContainerTemplate | undefined,
  seen: readonly string[] = [],
): AliasCheck {
  const issues: AliasIssue[] = [];
  if (seen.includes(templateId)) {
    return {
      issues: [
        { where: templateId, message: `模板引用成环：${[...seen, templateId].join(" → ")}` },
      ],
      unresolved: [],
    };
  }
  const trail = [...seen, templateId];
  const endpoints = receiveEndpoints(template);

  const checkTarget = (b: AliasBinding, where: string): void => {
    if (b.external !== undefined) return; // 跨租户地址不在本图里，校验不了也不该校验
    const target = `${b.node}.${b.port}`;
    if (b.slot === undefined) {
      if (!endpoints.includes(target)) {
        issues.push({
          where,
          message: `本容器没有 receive 端点 ${target}。可用：${endpoints.join("、") || "（无）"}`,
        });
      }
      return;
    }
    const declared = template.children[b.slot];
    if (declared === undefined) {
      issues.push({
        where,
        message:
          `子槽 \`${b.slot}\` 没有声明。可用子槽：` +
          `${Object.keys(template.children).sort().join("、") || "（无）"}`,
      });
      return;
    }
    const child = lookup(declared.template);
    if (child === undefined) {
      issues.push({ where, message: `子槽 \`${b.slot}\` 的模板 ${declared.template} 找不到` });
      return;
    }
    const childEndpoints = receiveEndpoints(child);
    if (!childEndpoints.includes(target)) {
      issues.push({
        where,
        message:
          `子模板 ${declared.template} 没有 receive 端点 ${target}。` +
          `可用：${childEndpoints.join("、") || "（无）"}`,
      });
    }
  };

  for (const b of template.bindings) checkTarget(b, `bindings.${b.alias}`);
  for (const b of template.selfBindings) checkTarget(b, `selfBindings.${b.alias}`);
  for (const [slot, declared] of Object.entries(template.children)) {
    for (const b of declared.bindings ?? []) checkTarget(b, `children.${slot}.bindings.${b.alias}`);
  }

  const visibleToSelf = new Set([
    ...template.bindings.map((b) => b.alias),
    ...template.selfBindings.map((b) => b.alias),
  ]);
  const unresolved = new Set(aliasesUsed(template).filter((a) => !visibleToSelf.has(a)));

  const visibleToSubtree = new Set(template.bindings.map((b) => b.alias));
  for (const [slot, declared] of Object.entries(template.children)) {
    const child = lookup(declared.template);
    if (child === undefined) continue; // 已由 validateChildEntries 报过
    const childResult = checkAliases(declared.template, child, lookup, trail);
    issues.push(...childResult.issues);
    const providedHere = new Set([
      ...visibleToSubtree,
      ...(declared.bindings ?? []).map((b) => b.alias),
    ]);
    for (const alias of childResult.unresolved) {
      if (!providedHere.has(alias)) unresolved.add(alias);
    }
  }

  return { issues, unresolved: [...unresolved].sort() };
}

/**
 * 根配置的判定：**一个别名都不能欠**。
 *
 * 这就是"发出去没人接"从运行期搬到注册期的落点。代价要认：隧道时代
 * "我故意排除了这一支"与"我忘了给这一支接线"长得一模一样（都表现为
 * 运行期 dangling），现在前者必须显式写出来。这与 §1「注册期拒绝，
 * 不做运行期救火」一致。
 */
export function checkRootAliases(
  templateId: string,
  template: ContainerTemplate,
  lookup: (ref: string) => ContainerTemplate | undefined,
): readonly AliasIssue[] {
  const result = checkAliases(templateId, template, lookup);
  return [
    ...result.issues,
    ...result.unresolved.map((alias) => ({
      where: `${templateId} 的别名 \`${alias}\``,
      message: "没有任何绑定 —— 用到它的节点发出去没人接",
    })),
  ];
}
