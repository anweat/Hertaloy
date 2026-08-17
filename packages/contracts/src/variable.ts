/**
 * 变量契约 —— 命题的落点。
 *
 * 对应 FOUNDATION_V5.md §7：资产即变量；三种类型；`long`/`ref` 必须声明 `max_tokens`（不变量 B1）。
 *
 * **位置即绑定时机**，因此不设 `bind: compile|runtime` 字段：
 *   - `bind` 段的变量 → 编译期绑定 → 进 prompt 稳定前缀（不变量 X）→ 来源只能是 `card` / `literal`
 *   - 端口 servo 的变量 → 运行期填充 → 落在缓存断点之后 → 来源只能是路径 `from`
 * 两者用不同的 schema 表达，让"绑定时机"由结构强制，而不是靠一个可以写错的字段。
 */

import { z } from "zod";
import { Json } from "./json.js";
import { Ref } from "./identity.js";
import { Path } from "./path.js";

export const VAR_TYPES = ["short", "long", "ref"] as const;
export type VarType = (typeof VAR_TYPES)[number];

export const VarType = z.enum(VAR_TYPES);

export const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const VarName = z
  .string()
  .regex(VAR_NAME_PATTERN, "变量名必须是标识符：字母或下划线起头，后接字母数字下划线");

export const MaxTokens = z.number().int().positive();

/** `long` / `ref` 必须有上界，`short` 不得有 —— B1 的可判定性全靠这条。 */
function checkBudgetDeclaration(
  v: { readonly type: VarType; readonly max_tokens?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  const needsBound = v.type === "long" || v.type === "ref";
  if (needsBound && v.max_tokens === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_tokens"],
      message:
        `\`${v.type}\` 变量必须声明 max_tokens 上界：` +
        `运行期内容无静态上界，不声明则注册期预算无法求和（不变量 B1）`,
    });
  }
  if (!needsBound && v.max_tokens !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_tokens"],
      message: "`short` 变量不计入预算，不应声明 max_tokens",
    });
  }
}

// ---------------------------------------------------------------------------
// 编译期绑定变量（`bind` 段）
// ---------------------------------------------------------------------------

const BindVarShape = z
  .object({
    type: VarType,
    max_tokens: MaxTokens.optional(),
    /** 卡片正文：rules / prompt / skill / mcp，按精确版本引用。 */
    card: Ref.optional(),
    /** 字面量：工作区根、编辑范围等。 */
    literal: Json.optional(),
  })
  .strict();

export const BindVar = BindVarShape.superRefine((v, ctx) => {
  const declared = [v.card !== undefined, v.literal !== undefined].filter(Boolean).length;
  if (declared !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bind 变量必须恰好声明一个来源：`card` 或 `literal`",
    });
  }
  checkBudgetDeclaration(v, ctx);
});

export type BindVar = z.infer<typeof BindVar>;

export const BindBlock = z.record(VarName, BindVar);
export type BindBlock = z.infer<typeof BindBlock>;

// ---------------------------------------------------------------------------
// 运行期填充变量（端口 servo）
// ---------------------------------------------------------------------------

const PortVarShape = z
  .object({
    type: VarType,
    max_tokens: MaxTokens.optional(),
    /** 从本次消息 payload 提取。servo 是纯提取，无控制流（不变量 S1/S2）。 */
    from: Path,
  })
  .strict();

export const PortVar = PortVarShape.superRefine(checkBudgetDeclaration);

export type PortVar = z.infer<typeof PortVar>;

// ---------------------------------------------------------------------------
// 预算求和（不变量 B1 的注册期落点）
// ---------------------------------------------------------------------------

/** 声明上界之和。`short` 不计入。 */
export function declaredBudget(
  vars: Iterable<{ readonly type: VarType; readonly max_tokens?: number | undefined }>,
): number {
  let total = 0;
  for (const v of vars) total += v.max_tokens ?? 0;
  return total;
}
