/**
 * servo 的路径语言 —— 最小自定义子集，零依赖。
 *
 * 对应 FOUNDATION_V5.md §6.3 / §16：
 * 不引入 JMESPath / JSONPath，因为 S2 已把 filter 归给策略节点 —— **filter 就是控制流**。
 * 不需要 filter，就不需要整个路径语言。
 *
 * 文法：
 *   path    := "$" segment*
 *   segment := "." name | "[" index "]" | "[*]"
 *   name    := [A-Za-z_][A-Za-z0-9_]*
 *   index   := 0 | [1-9][0-9]*
 *
 * 明确不支持（都是控制流或会破坏"输出变量集编译期已知"）：
 *   递归下降 `..`、过滤 `[?(...)]`、切片 `[1:3]`、函数 `length(...)`、并集 `a,b`
 */

import { z } from "zod";

export const PATH_PATTERN =
  /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]*)\]|\[\*\])*$/;

export const Path = z
  .string()
  .regex(
    PATH_PATTERN,
    "路径只支持 `$`、`.name`、`[n]`、`[*]`；不支持过滤、切片、递归下降或函数",
  );

export type Path = z.infer<typeof Path>;

export type PathSegment =
  | { readonly kind: "key"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "each" };

/** 解析成段序列。调用方应先通过 `Path` 校验。 */
export function parsePath(path: string): readonly PathSegment[] {
  const parsed = Path.safeParse(path);
  if (!parsed.success) {
    throw new Error(`非法路径 ${JSON.stringify(path)}`);
  }
  const out: PathSegment[] = [];
  for (const m of path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[\*\]/g)) {
    if (m[1] !== undefined) out.push({ kind: "key", name: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "index", index: Number(m[2]) });
    else out.push({ kind: "each" });
  }
  return out;
}

/** 含 `[*]` 的路径产出列表；类型校验据此判断变量该不该是列表。 */
export function isProjection(path: string): boolean {
  return parsePath(path).some((s) => s.kind === "each");
}
