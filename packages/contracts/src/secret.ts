/**
 * 凭据的识别与引用 —— 一套模式，两处用。
 *
 * 起因是一条实证缺陷：`AgentSpec.env` 的注释写着"**不得写入密钥值**"，
 * 而**没有任何东西强制它**。写进去的后果不是"泄漏一次"，是永久：
 * 模板是对象，对象不可变、内容寻址、按前缀可读（§17.7），
 * 一份 `sk-…` 落进 `<id>@1` 的正文就再也拿不出来 —— 只能换密钥。
 *
 * 更糟的是 DEVELOPING.md 曾断言这些值"进对象库之前已脱敏"。那句话是错的，
 * 而且是我写的：`redact` 只处理 **stdout/stderr**，模板正文根本不经过它。
 *
 * 这里给出两件东西：
 *
 *   `looksLikeSecret`  注册期**拒绝**明显是凭据的字面量
 *   `envRefName`       `$NAME` 形式的引用 —— 模板只存**取值方式**
 *
 * 第一条是黑名单，必然漏得掉，所以它不是保证，只是把最常见的错法挡在门外；
 * 真正的保证是第二条给出的**正确路径**：值留在编排进程的环境里，
 * 模板里只有名字。没有正确路径的禁止只会被绕过。
 *
 * 同一组模式也供沙箱层遮蔽 stdout/stderr 用 —— 一处定义，一处维护。
 */

/**
 * 常见凭据格式。**尽力而为**：密钥命名千奇百怪，黑名单永远漏得掉。
 *
 * 注意 `g` 标志 —— `RegExp.lastIndex` 在 `test()` 之间会残留，
 * 所以判定用的 `looksLikeSecret` 每次都重置它。
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/** 遮蔽后的占位符。出现在 diagnostics 里，让人知道"这里本来有东西"。 */
export const MASK = "«已遮蔽»";

/** 值里是否含有一眼可辨的凭据。 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(value);
  });
}

/** `$NAME` 引用形式 —— 名字按 POSIX 环境变量的字符集。 */
export const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * 取出 `$NAME` 引用的变量名；不是引用形式就返回 `null`（那是个字面量）。
 */
export function envRefName(value: string): string | null {
  const m = ENV_REF_PATTERN.exec(value);
  return m === null ? null : (m[1] as string);
}

/**
 * 把模板里的 env 声明解析成真正要注入的值。
 *
 * `$NAME` 从宿主环境取；取不到就**报错而不是注入空串** ——
 * 空的凭据会让 agent 跑出一个含混的失败，而"这台机器没配 X"是个明确的事实，
 * 早说比晚说好。字面量原样通过（注册期已挡掉像凭据的那些）。
 */
export function resolveEnv(
  declared: Readonly<Record<string, string>> | undefined,
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(declared ?? {})) {
    const ref = envRefName(value);
    if (ref === null) {
      out[key] = value;
      continue;
    }
    const found = host[ref];
    if (found === undefined) {
      missing.push(`${key}=$${ref}`);
      continue;
    }
    out[key] = found;
  }
  if (missing.length > 0) {
    throw new Error(
      `env 引用在宿主环境里不存在：${missing.join("、")}。` +
        "模板只存取值方式，值要由跑它的那台机器提供",
    );
  }
  return out;
}
