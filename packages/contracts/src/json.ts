/** 通用 JSON 值。payload、literal、body 共用。 */

import { z } from "zod";

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(Json),
    z.record(Json),
  ]),
) as z.ZodType<Json>;

export const JsonObject = z.record(Json);
export type JsonObject = z.infer<typeof JsonObject>;

export interface JsonViolation {
  /** 出问题的位置，如 `out.tasks[0].when`。 */
  readonly path: string;
  readonly message: string;
}

/**
 * 运行期 JSON 校验 —— 挡住**静默损坏**与**挂死**。
 *
 * TypeScript 说返回 `Json` 不代表运行期真是 Json。不校验的话，这些值会一路
 * 流进消息 payload → 契约校验 → 资产 body → 内容哈希，而失败方式全是最难查的那种：
 *
 * | 值 | 不校验的后果 |
 * |---|---|
 * | `undefined` / 函数 / Symbol | **键被静默丢弃** |
 * | `NaN` / `±Infinity` | **静默变 `null`** |
 * | `Date` / `Map` / `Set` / 类实例 | **静默变 `{}`**（无自有可枚举键） |
 * | 循环引用 | **规范化序列化无限递归 → 挂死** |
 *
 * 不可信的 backend 早有 `checkBackendResult`；受信的 handler 反而没有。
 * 信任级别不同可以解释"检查强度不同"，解释不了"静默损坏"。
 */
export function jsonViolations(value: unknown, path = "$"): readonly JsonViolation[] {
  const out: JsonViolation[] = [];
  walkJson(value, path, new Set(), out);
  return out;
}

function walkJson(
  value: unknown,
  path: string,
  seen: Set<object>,
  out: JsonViolation[],
): void {
  if (value === null) return;
  const t = typeof value;

  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      out.push({ path, message: `${String(value)} 不是合法 JSON 数字（会被静默写成 null）` });
    }
    return;
  }
  if (t === "undefined") {
    out.push({ path, message: "undefined 不是 JSON 值（这个键会被静默丢弃）" });
    return;
  }
  if (t === "function" || t === "symbol") {
    out.push({ path, message: `${t} 不是 JSON 值（会被静默丢弃）` });
    return;
  }
  if (t === "bigint") {
    out.push({ path, message: "bigint 不能序列化成 JSON" });
    return;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    out.push({ path, message: "循环引用（规范化序列化会无限递归）" });
    return;
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walkJson(item, `${path}[${i}]`, seen, out));
  } else {
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      out.push({
        path,
        message:
          `${obj.constructor?.name ?? "非普通对象"} 不是 JSON 值` +
          `（没有自有可枚举键的会被静默写成 {}）`,
      });
      seen.delete(obj);
      return;
    }
    for (const [k, v] of Object.entries(obj)) walkJson(v, `${path}.${k}`, seen, out);
  }
  seen.delete(obj);
}

export function formatJsonViolations(violations: readonly JsonViolation[]): string {
  return violations.map((v) => `${v.path}：${v.message}`).join("；");
}
