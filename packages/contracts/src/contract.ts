/**
 * MessageContract —— 端口上的载荷契约。
 *
 * JSON Schema 的一个**受限子集**：只有 5 个关键字。
 * 不做全量 JSON Schema：契约的消费者是端口校验与 LLM 提示词生成，
 * 超出这 5 个的表达力目前没有场景（有场景时再加，不预先铺）。
 */

import { z } from "zod";
import type { Json } from "./json.js";

export const CONTRACT_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];

export interface MessageContract {
  readonly type?: ContractType;
  readonly properties?: { readonly [key: string]: MessageContract };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: MessageContract;
}

export const MessageContract: z.ZodType<MessageContract> = z.lazy(() =>
  z
    .object({
      type: z.enum(CONTRACT_TYPES).optional(),
      properties: z.record(MessageContract).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
      items: MessageContract.optional(),
    })
    .strict(),
) as z.ZodType<MessageContract>;

export interface ContractIssue {
  /** JSON 路径，如 `$.tasks[0].specRef`。 */
  readonly path: string;
  readonly message: string;
}

function typeOf(value: Json): ContractType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return Number.isInteger(value) ? "integer" : "number";
}

function typeMatches(expected: ContractType, actual: ContractType): boolean {
  if (expected === actual) return true;
  // integer 是 number 的子集：声明 number 时接受整数
  return expected === "number" && actual === "integer";
}

/** 校验取值。只接受或拒绝，**不暗中补字段**。 */
export function validateContract(
  schema: MessageContract,
  value: Json,
  path = "$",
): readonly ContractIssue[] {
  const issues: ContractIssue[] = [];
  const actual = typeOf(value);

  if (schema.type !== undefined && !typeMatches(schema.type, actual)) {
    issues.push({ path, message: `期望类型 ${schema.type}，实际是 ${actual}` });
    return issues;
  }

  if (actual === "object") {
    const obj = value as { readonly [k: string]: Json };
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        issues.push({ path, message: `缺少必需字段 \`${key}\`` });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      const child = obj[key];
      if (child !== undefined) {
        issues.push(...validateContract(sub, child, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
          issues.push({
            path,
            message:
              `不允许的字段 \`${key}\`。已声明字段：` +
              `${[...known].sort().join(", ") || "（无）"}`,
          });
        }
      }
    }
  }

  if (actual === "array" && schema.items !== undefined) {
    (value as readonly Json[]).forEach((item, i) => {
      issues.push(...validateContract(schema.items as MessageContract, item, `${path}[${i}]`));
    });
  }

  return issues;
}

export function formatContractIssues(issues: readonly ContractIssue[]): string {
  return issues.map((i) => `${i.path}：${i.message}`).join("；");
}
