/**
 * 授权 —— **权限是数据，不是代码**（FOUNDATION_V5.md §11）。
 *
 * 三件事组成一条授权：`(principal, scope, 操作类)`。
 *
 * `scope` **复用前缀机制**（第六次复用：订阅作用域 / 子树查询 / 反向清账 /
 * 截断级联 / 对象命名空间 / 现在是授权）。每次要"按范围过滤"先问它够不够，
 * 不要发明新索引。
 */

import { z } from "zod";
import { type Principal, formatPrincipal, isDescendantOf } from "./identity.js";

/**
 * 借 DBMS 的 DDL / DML / DQL 分层 —— 它天然对应"改定义 / 改运行状态 / 只读"，
 * 而这三件事的权限要求本来就不同。
 */
export const OP_CLASSES = ["DDL", "DML", "DQL"] as const;
export type OpClass = (typeof OP_CLASSES)[number];
export const OpClass = z.enum(OP_CLASSES);

/** `human:alice` / `human:*` / `*` —— 后两者是模式。 */
export const PRINCIPAL_PATTERN =
  /^(?:\*|(?:human|agent|system|service):(?:\*|\S+))$/;

export const Grant = z
  .object({
    principal: z.string().regex(PRINCIPAL_PATTERN, "主体模式形如 `human:alice`、`human:*` 或 `*`"),
    /** traceid 前缀（行级安全）或定义路径前缀（对象级 GRANT）；`*` 表示不限。 */
    scope: z.string().min(1),
    ops: z.array(OpClass).nonempty(),
  })
  .strict();

export type Grant = z.infer<typeof Grant>;

export function principalMatches(pattern: string, actor: Principal): boolean {
  if (pattern === "*") return true;
  /**
   * 按**第一个**冒号切，不用 `split(":", 2)`。
   *
   * JS 的 limit 参数是"最多产出几段、多余的丢掉"，不是"剩下的合并进最后一段"
   * （与 Python 相反）。于是 `agent:a:b` 被截成 `["agent","a"]`，
   * 一条给 `agent:a:b` 的授权**永远匹配不上** id 为 `a:b` 的主体 ——
   * 而它失败的方式是静默拒绝，看起来像"没给权限"。
   */
  const sep = pattern.indexOf(":");
  if (sep === -1) return false;
  const kind = pattern.slice(0, sep);
  const id = pattern.slice(sep + 1);
  if (kind !== actor.kind) return false;
  return id === "*" || id === actor.id;
}

/**
 * 作用域是否覆盖目标。
 *
 * traceid 与定义路径都是 `/` 分隔的路径，所以**同一个段边界前缀判定**通吃：
 * `job-1` 覆盖 `job-1/coder-1` 但不覆盖 `job-10`。
 */
export function scopeCovers(scope: string, target: string): boolean {
  return scope === "*" || isDescendantOf(target, scope);
}

export interface AuthzDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * 授权表。**默认拒绝** —— 没有匹配的授权就是不允许。
 *
 * 内核本身不依赖它：检查发生在可信边界（控制面），Runtime 保持纯引擎。
 * 这样 `Principal` 只在边界出现一次，不必穿进每个内核方法的签名。
 */
export class PermissionTable {
  readonly #grants: Grant[] = [];

  grant(grant: Grant): this {
    this.#grants.push(Grant.parse(grant));
    return this;
  }

  grants(): readonly Grant[] {
    return [...this.#grants];
  }

  decide(actor: Principal, op: OpClass, target: string): AuthzDecision {
    for (const g of this.#grants) {
      if (!g.ops.includes(op)) continue;
      if (!principalMatches(g.principal, actor)) continue;
      if (!scopeCovers(g.scope, target)) continue;
      return { allowed: true, reason: `由授权 ${g.principal} · ${g.scope} · ${op} 允许` };
    }
    return {
      allowed: false,
      reason:
        `${formatPrincipal(actor)} 无权对 \`${target}\` 执行 ${op} 类操作。` +
        `当前授权：${
          this.#grants.map((g) => `${g.principal}·${g.scope}·${g.ops.join("/")}`).join("，") ||
          "（空表，默认拒绝）"
        }`,
    };
  }
}
