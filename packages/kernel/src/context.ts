/**
 * 调用上下文编译 —— 命题的落点（Task 6）。
 *
 * 对应 FOUNDATION_V5.md §7：
 *   资产即变量；`bind` 段是编译期绑定（进 prompt 稳定前缀，不变量 X），
 *   端口 servo 是运行期填充（落在缓存断点之后）。
 *
 * **B1 的两半**：
 *   注册期  Σ(声明的 max_tokens) ≤ 节点预算   ← 在 `validateContainerTemplate` 里
 *   运行期  单个变量实际填充 > 它声明的上界 → **直接失败，不截断不降级**  ← 在这里
 *
 * 不做优先级裁剪：V4 那套 `transient → tail → messages` 是"预算算不准"的补丁，
 * 声明上界之后预算是准的。超上界说明声明写错了或图切错了，那是要人改的。
 */

import {
  type BindVar,
  type Json,
  type NodeDefinition,
  type PortVar,
  estimateValueTokens,
} from "@nodeflow/contracts";
import type { VarBag } from "./extract.js";
import type { ObjectStore } from "./store.js";

export interface ContextFailure {
  readonly variable: string;
  readonly message: string;
}

export type ContextOutcome =
  | { readonly ok: true; readonly vars: VarBag; readonly tokens: number }
  | { readonly ok: false; readonly failures: readonly ContextFailure[] };

/** 卡片正文：约定取 `body.text`，没有就用整个 body 的规范 JSON。 */
function cardText(body: unknown): Json {
  if (body !== null && typeof body === "object" && "text" in (body as Record<string, unknown>)) {
    return (body as Record<string, Json>).text as Json;
  }
  return body as Json;
}

function checkBound(
  name: string,
  decl: { readonly max_tokens?: number | undefined },
  value: Json,
  failures: ContextFailure[],
): number {
  if (decl.max_tokens === undefined) return 0;
  const actual = estimateValueTokens(value);
  if (actual > decl.max_tokens) {
    failures.push({
      variable: name,
      message:
        `实际约 ${actual} tokens，超出声明上界 ${decl.max_tokens}。` +
        `不截断也不降级 —— 这说明声明写错了或图切得太粗`,
    });
  }
  return actual;
}

/**
 * 编译一次调用的完整变量袋 = `bind` 段 + 端口 servo 已提取的变量。
 *
 * 命名冲突在注册期就拒了（`validateContainerTemplate`），这里不再兜底。
 */
export function compileContext(
  store: ObjectStore,
  node: NodeDefinition,
  runtimeVars: VarBag,
): ContextOutcome {
  if (node.kind !== "handler") {
    return { ok: true, vars: runtimeVars, tokens: 0 };
  }

  const vars: Record<string, Json> = {};
  const failures: ContextFailure[] = [];
  let tokens = 0;

  // 编译期绑定 —— 稳定前缀（不变量 X）
  for (const [name, decl] of Object.entries(node.bind ?? {}) as [string, BindVar][]) {
    let value: Json;
    if (decl.card !== undefined) {
      try {
        value = cardText(store.resolve(decl.card).body);
      } catch (error) {
        failures.push({ variable: name, message: `卡片 ${decl.card} 解析失败：${String(error)}` });
        continue;
      }
    } else {
      value = decl.literal as Json;
    }
    tokens += checkBound(name, decl, value, failures);
    vars[name] = value;
  }

  // 运行期填充 —— 缓存断点之后
  const portVars = new Map<string, PortVar>();
  for (const port of Object.values(node.ports)) {
    if (port.direction !== "receive" || port.servo === undefined) continue;
    for (const [name, decl] of Object.entries(port.servo.vars)) {
      portVars.set(name, decl as PortVar);
    }
  }
  for (const [name, value] of Object.entries(runtimeVars)) {
    const decl = portVars.get(name);
    if (decl !== undefined) tokens += checkBound(name, decl, value, failures);
    vars[name] = value;
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, vars: Object.freeze(vars), tokens };
}

export function formatContextFailures(failures: readonly ContextFailure[]): string {
  return failures.map((f) => `变量 \`${f.variable}\`：${f.message}`).join("；");
}
