/**
 * 版本层契约。
 *
 * 对应 FOUNDATION_V5.md §4.2 与不变量 V1–V4：
 * ObjectStore 是版本分配的唯一权威；ObjectVersion 独立于实例；内容寻址幂等；引用永远精确。
 */

import { z } from "zod";
import { Json, JsonObject } from "./json.js";
import { Ref, TraceId } from "./identity.js";

/**
 * 内核保留 kind —— backend / handler 提交的产物不得伪造这些。
 * 其余 kind（plan / spec / test_report …）由用户注册。
 */
export const KERNEL_KINDS = [
  "run",
  "annotation",
  "root_config",
  "container_template",
  "proposal",
  "layout",
] as const;

export type KernelKind = (typeof KERNEL_KINDS)[number];

export const KIND_PATTERN = /^[a-z][a-z0-9_]*$/;

export const ObjectKind = z
  .string()
  .regex(KIND_PATTERN, "kind 必须是小写下划线标识符");

export function isKernelKind(kind: string): kind is KernelKind {
  return (KERNEL_KINDS as readonly string[]).includes(kind);
}

/** trace 追踪：谁在哪次执行里产出、派生自哪些版本。 */
export const Provenance = z
  .object({
    traceid: TraceId.optional(),
    node_id: z.string().min(1).optional(),
    execution_id: z.string().min(1).optional(),
    at_seq: z.number().int().nonnegative().default(0),
    derived_from: z.array(Ref).default([]),
  })
  .strict();

export type Provenance = z.infer<typeof Provenance>;

export const CONTENT_HASH_PATTERN = /^[0-9a-f]{16}$/;

export const ObjectVersion = z
  .object({
    object_id: z.string().min(1).refine((v) => !v.includes("@"), "object_id 不得含 `@`"),
    /** 版本号只由 store 分配（不变量 V1），从 1 起单调。 */
    version: z.number().int().positive(),
    kind: ObjectKind,
    /** 内容寻址（不变量 V3）：同内容重复提交返回同一版本。 */
    content_hash: z.string().regex(CONTENT_HASH_PATTERN, "content_hash 是 16 位小写十六进制"),
    body: JsonObject,
    provenance: Provenance,
  })
  .strict();

export type ObjectVersion = z.infer<typeof ObjectVersion>;

/** backend 只提交内容，版本由 store 分配（不变量 V1）。 */
export const ArtifactSubmission = z
  .object({
    object_id: z.string().min(1).refine((v) => !v.includes("@"), "object_id 不得含 `@`"),
    kind: ObjectKind,
    body: JsonObject,
    derived_from: z.array(Ref).default([]),
  })
  .strict();

export type ArtifactSubmission = z.infer<typeof ArtifactSubmission>;

export type { Json };
