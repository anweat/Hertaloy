/**
 * 别名的**注册期校验**。
 *
 * > **只许读：模板。**
 * > 读不到实例，也读不到运行期的任何东西 —— 那正是"注册期可判定"的含义。
 *
 * 这条限制由 import 图强制：本文件够不着 `resolve.ts`，也够不着注册表。
 * 哪天有人想在校验里"顺便看看现在有几个活实例"，会先撞上这堵墙。
 *
 * ## 判定式
 *
 *   unresolved(t) = t 自己用到但没绑的
 *                 ∪ ⋃ (unresolved(子) − 父在那个子槽上提供的绑定)
 *
 * 递归到根终止 —— 与 §3.1「根是递归的终止条件」是同一个终止点。
 * 这不是新机制：`validateChildEntries` 已经在父注册时跨模板校验子槽的 `entry`，
 * 走同一个时机、同一条路。
 *
 * ## 于是两件事分开了
 *
 *   **绑定存在性** —— 静态，注册期拒绝
 *   **实例数量**   —— 动态，运行期（那在 `resolve.ts`）
 *
 * 隧道时代这两件糊在一起：`REQUEST 恰好 1 个` 既可能因为没人订阅而失败，
 * 也可能因为多了个租户订阅同名隧道而失败，两者都要等到运行期才炸。
 */

import type { AliasBinding, ContainerTemplate } from "@nodeflow/contracts";

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
