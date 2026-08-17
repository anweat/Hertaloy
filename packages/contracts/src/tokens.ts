/**
 * token 估算 —— 只用于预算求和与上界校验，不参与任何裁决。
 *
 * 系数沿用 V4 用真实 `usage.in_tokens` 校准的结果（`HARNESS_EVALUATION`）：
 * 拉丁约 2.2 字符/token，CJK 约 0.9 字符/token，实测比值 1.05 / 1.08。
 * 这是**保守估算**：宁可高估导致注册期拒绝，也不要低估到运行期才爆。
 */

const LATIN_CHARS_PER_TOKEN = 2.2;
const CJK_CHARS_PER_TOKEN = 0.9;

/** CJK 统一表意文字 + 假名 + 谚文的粗略范围。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
  }
  const latin = text.length - cjk;
  return Math.ceil(latin / LATIN_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN);
}

/** 非字符串值按其规范 JSON 文本估算。 */
export function estimateValueTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value ?? null));
}
