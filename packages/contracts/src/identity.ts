/**
 * 身份契约：精确版本引用、实例路径、控制面主体。
 *
 * 对应 FOUNDATION_V5.md：不变量 V4（引用永远精确）、C2（traceid 是实例路径）、§11（Principal）。
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Ref —— 精确版本引用（不变量 V4）
// ---------------------------------------------------------------------------

/**
 * `<object_id>@<version>`。
 *
 * - `object_id` 可含 `/`（`rules/py-strict`、`graph_template/export-flow`），不得含 `@`。
 * - `version` 是正整数，无前导零。
 * - 不接受 `latest` / `head` / `0` / 负数 —— 运行消息里永远是精确版本。
 */
export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*@[1-9][0-9]*$/;

export const Ref = z
  .string()
  .regex(REF_PATTERN, "引用必须精确到版本，形如 `object_id@N`（N ≥ 1，无前导零）");

export type Ref = z.infer<typeof Ref>;

export interface ParsedRef {
  readonly objectId: string;
  readonly version: number;
}

export function parseRef(ref: string): ParsedRef {
  const parsed = Ref.safeParse(ref);
  if (!parsed.success) {
    throw new Error(`非法引用 ${JSON.stringify(ref)}：必须形如 \`object_id@N\``);
  }
  const at = ref.lastIndexOf("@");
  return { objectId: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

export function formatRef(objectId: string, version: number): Ref {
  return Ref.parse(`${objectId}@${version}`);
}

// ---------------------------------------------------------------------------
// TraceId —— 实例路径（不变量 C2）
// ---------------------------------------------------------------------------

/** 单段：小写字母数字起止，中间可含连字符。 */
export const TRACE_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** 完整路径：段以 `/` 连接，如 `job-1/coder-2/review-1`。根实例是单段。 */
export const TRACE_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export const TraceId = z
  .string()
  .regex(
    TRACE_ID_PATTERN,
    "traceid 必须是 `/` 分隔的小写路径，每段以字母数字起止，如 `job-1/coder-2`",
  );

export type TraceId = z.infer<typeof TraceId>;

export function traceSegments(id: TraceId): readonly string[] {
  return id.split("/");
}

/** 根实例只有顶级索引名（不变量 C1）。 */
export function isRootTrace(id: TraceId): boolean {
  return !id.includes("/");
}

export function parentTrace(id: TraceId): TraceId | null {
  const cut = id.lastIndexOf("/");
  return cut < 0 ? null : id.slice(0, cut);
}

export function childTrace(parent: TraceId, segment: string): TraceId {
  if (!TRACE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`非法 traceid 段 ${JSON.stringify(segment)}`);
  }
  return `${parent}/${segment}`;
}

/**
 * 前缀匹配**必须落在段边界上**。
 *
 * 这是队列订阅作用域过滤（不变量 M2）的判据，也是最容易写错的地方：
 * 朴素的 `startsWith` 会把 `job-10` 误判为 `job-1` 的子树。
 */
export function isDescendantOf(candidate: TraceId, ancestor: TraceId): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

// ---------------------------------------------------------------------------
// Principal —— 控制面主体（§11）
// ---------------------------------------------------------------------------

export const PRINCIPAL_KINDS = ["human", "agent", "system", "service"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const Principal = z.object({
  kind: z.enum(PRINCIPAL_KINDS),
  id: z.string().min(1).refine((v) => !/\s/.test(v), "principal id 不得含空白"),
});

export type Principal = z.infer<typeof Principal>;

/**
 * 从 `kind:id` 解析。**只应在可信边界调用** —— `arguments` 里自称的 actor 永不可信。
 *
 * 按第一个 `:` 切分，所以 id 自身可以含 `:`（如 URN 形式的服务账户）。
 */
export function parsePrincipal(value: string): Principal {
  const cut = value.indexOf(":");
  if (cut < 0) {
    throw new Error(
      `principal 必须形如 kind:id，kind ∈ ${PRINCIPAL_KINDS.join("|")}，得到 ${JSON.stringify(value)}`,
    );
  }
  const parsed = Principal.safeParse({
    kind: value.slice(0, cut),
    id: value.slice(cut + 1),
  });
  if (!parsed.success) {
    throw new Error(
      `principal 必须形如 kind:id，kind ∈ ${PRINCIPAL_KINDS.join("|")}，得到 ${JSON.stringify(value)}`,
    );
  }
  return parsed.data;
}

export function formatPrincipal(p: Principal): string {
  return `${p.kind}:${p.id}`;
}
