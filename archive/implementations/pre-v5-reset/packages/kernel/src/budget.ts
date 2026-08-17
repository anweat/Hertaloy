/**
 * Nodeflow V5 —— 上下文预算（对 Python nodeflow_budget.py 的 TS 移植）
 *
 * 估算与降级：head 永不裁剪；transient → tail → messages（至少留一条）。
 * 裁剪与压缩同级告警 —— 都是"这个节点承担的任务过大"的信号。
 */
import { InvariantError } from "./core.js";
import type { InvocationContext, RuntimeLike } from "./runtime-like.js";

export function estimateTextTokens(rt: RuntimeLike, text: string): number {
  // CJK 与拉丁字符的 token 密度差好几倍，分开算。
  // 系数由 test_context_budget 的校准用例对着真实 usage 量出来。
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  return Math.floor(cjk / rt.cjkCharsPerToken + (text.length - cjk) / rt.charsPerToken);
}

export function estimateTokens(rt: RuntimeLike, ctx: InvocationContext): number {
  const blob = [...ctx.head, ...ctx.messages, ...ctx.tail, ...ctx.transient].map(String).join("");
  return estimateTextTokens(rt, blob);
}

export function estimateSpecTokens(rt: RuntimeLike, spec: Record<string, unknown>): number {
  // system prompt 与工具 schema 也占输入预算 —— 漏算它们会系统性低估。
  let blob = String(spec.systemPrompt ?? "");
  blob += JSON.stringify(spec.tools ?? []);
  return estimateTextTokens(rt, blob);
}

export interface FitResult {
  ctx: InvocationContext;
  trims: Array<Record<string, unknown>>;
}

/** 把上下文裁到预算内。head 永不裁剪 —— 它自己超预算直接失败。 */
export function fitContext(rt: RuntimeLike, ctx: InvocationContext, budget: number | null | undefined, opts: { gid: string; nodeId: string; overhead?: number }): FitResult {
  const { gid, nodeId, overhead = 0 } = opts;
  if (budget == null) return { ctx, trims: [] };
  const headOnly: InvocationContext = { ...ctx, head: ctx.head, messages: [], tail: [], transient: [] };
  const headTokens = estimateTokens(rt, headOnly) + overhead;
  if (headTokens > budget) {
    throw new InvariantError(
      `${gid}/${nodeId}：head + spec 开销 ${headTokens} tokens 已超预算 ${budget}；head 不可裁剪（图切分过粗，应拆分节点）`
    );
  }
  const trims: Array<Record<string, unknown>> = [];
  let cur = ctx;
  for (const section of rt.truncationOrder) {
    const keep = rt.minKeep[section] ?? 0;
    while (estimateTokens(rt, cur) + overhead > budget) {
      const items = cur[section];
      if (items.length <= keep) break;
      trims.push({
        section,
        dropped_index: trims.length,
        approx_tokens: estimateTextTokens(rt, String(items[0])),
      });
      cur = { ...cur, [section]: items.slice(1) }; // 砍最旧
    }
    if (estimateTokens(rt, cur) + overhead <= budget) break;
  }
  if (estimateTokens(rt, cur) + overhead > budget) {
    throw new InvariantError(
      `${gid}/${nodeId}：裁到无可再裁仍超预算（${estimateTokens(rt, cur) + overhead} > ${budget}，其中 spec 开销 ${overhead}）`
    );
  }
  return { ctx: cur, trims };
}
