#!/usr/bin/env node
/**
 * 文档规制的机械检查 —— 取代人工维护的状态标记。
 *
 * 规制见 README「文档规制」。这个脚本存在的理由只有一条：
 * **一条文档纪律如果写不成检查，它迟早会漂。** 以前靠 ✅/🚧/📋 标记表达"实现到哪"，
 * 而标记没有强制点，于是同一件事在五处出现了五个数字。
 *
 * 四项检查：
 *   invariants  MODEL 不变量表里每个符号名必须在 src 中存在（今天会抓到写错位置的条目）
 *   enums       每个内核枚举值至少有一处分支读它（今天会抓到只写不读的值）
 *   drift       汇总全仓 `TODO(drift):`，输出当前缺口清单（取代会漂的漂移登记表）
 *   boundary    内核非注释代码里不出现执行面词汇（零知识边界）
 *
 * 用法：node scripts/docs-check.mjs [--check]
 *   不带 --check 只报告；带 --check 时任一硬性检查失败即退出 1。
 *   drift 永远只报告不失败 —— 它是清单，不是门禁。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const STRICT = process.argv.includes("--check");

/** 递归收集 src 下的 .ts（跳过 node_modules / test / archive）。 */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "archive" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sources(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".mts")) out.push(full);
  }
  return out;
}

const SRC = sources(join(ROOT, "packages")).filter((f) => f.includes("src"));
const BODY = new Map(SRC.map((f) => [f, readFileSync(f, "utf8")]));

/** 去掉注释，只留会被执行的代码 —— 边界与枚举检查都必须看这一份。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const problems = [];
const report = [];

// --- invariants：不变量表里的符号名必须存在 -------------------------------
{
  const model = join(ROOT, "MODEL.md");
  let text = "";
  try {
    text = readFileSync(model, "utf8");
  } catch {
    report.push("invariants: 没有 MODEL.md，跳过");
  }
  if (text) {
    // 不变量表的「位置」列里写的是符号名，形如 `Runtime.canTerminate` 或 `aliases/check.ts`
    const table = text.split("\n").filter((l) => l.startsWith("|") && l.includes("`"));
    const symbols = new Set();
    for (const line of table) {
      for (const m of line.matchAll(/`([A-Za-z_#$][A-Za-z0-9_.#$/-]*)`/g)) {
        const sym = m[1];
        // 只查看起来像符号的：含点或井号，或是 .ts 路径
        if (sym.includes(".ts") || sym.includes("#") || /^[A-Z][A-Za-z]+\.[a-zA-Z]/.test(sym)) {
          symbols.add(sym);
        }
      }
    }
    const missing = [];
    for (const sym of symbols) {
      const needle = sym.includes(".ts") ? sym.split("/").pop() : sym.split(".").pop();
      const hit = [...BODY.entries()].some(([f, b]) =>
        sym.includes(".ts") ? f.replace(/\\/g, "/").endsWith(needle) : b.includes(needle),
      );
      if (!hit) missing.push(sym);
    }
    if (missing.length) problems.push(`invariants: MODEL 里这些符号在 src 中不存在：${missing.join(", ")}`);
    report.push(`invariants: 核对 ${symbols.size} 个符号，缺 ${missing.length} 个`);
  }
}

// --- enums：每个枚举值至少有一处分支读 ------------------------------------
// 值的来源有三种写法：字面量联合类型、`as const` 数组、`z.enum([...])`。
// "被读" = 出现在比较 / case / includes 里，或者它所属的具名数组被别处引用
// （例如 `NON_RETRYABLE.includes(t)`、`z.enum(OP_CLASSES)`）。
// 只写不读的值是**删除候选** —— 状态机的重量应该由被读的值决定，不由声明的值决定。
{
  const declared = new Map(); // value -> {file, holder}
  for (const [file, body] of BODY) {
    if (!file.includes("kernel") && !file.includes("contracts")) continue;
    const code = stripComments(body);
    for (const m of code.matchAll(/export type (\w+)\s*=\s*((?:"[A-Z_]+"\s*\|\s*)+"[A-Z_]+")/g)) {
      for (const v of m[2].matchAll(/"([A-Z_]+)"/g)) declared.set(v[1], { file, holder: m[1], viaTable: false });
    }
    for (const m of code.matchAll(/(?:const (\w+)[^=]*=\s*)?\[([^\]]*)\]\s*as const/g)) {
      for (const v of m[2].matchAll(/"([A-Z_]{2,})"/g)) declared.set(v[1], { file, holder: m[1] ?? "(匿名)", viaTable: true });
    }
  }

  const holderRefs = (holder) =>
    holder && holder !== "(匿名)"
      ? [...BODY.values()].reduce((n, b) => n + (stripComments(b).split(holder).length - 1), 0)
      : 0;

  const unread = [];
  for (const [value, { file, holder, viaTable }] of declared) {
    let reads = 0;
    let writes = 0;
    for (const b of BODY.values()) {
      const code = stripComments(b);
      reads +=
        (code.split(`=== "${value}"`).length - 1) +
        (code.split(`!== "${value}"`).length - 1) +
        (code.split(`case "${value}"`).length - 1) +
        (code.split(`includes("${value}")`).length - 1);
      writes += code.split(`"${value}"`).length - 1;
    }
    // 豁免只给**具名数组**：成员资格本身就是读法（`NON_RETRYABLE.includes(t)`、`z.enum(OP_CLASSES)`）。
    // 联合类型不豁免 —— 类型名被引用不代表每个值都有人分支它。
    if (reads === 0 && viaTable && holderRefs(holder) > 1) continue;
    if (reads === 0) {
      unread.push(`${value}（${holder}，${relative(ROOT, file)}）${writes > 1 ? " 只写不读" : " 完全未使用"}`);
    }
  }
  if (unread.length) {
    report.push(
      `enums: ${unread.length}/${declared.size} 个值没有分支读 —— 删除候选：\n    ` +
        unread.join("\n    "),
    );
  } else report.push(`enums: ${declared.size} 个值全部有分支读`);
}

// --- drift：TODO(drift) 清单 ----------------------------------------------
{
  const items = [];
  for (const [file, body] of BODY) {
    body.split("\n").forEach((line, i) => {
      const m = line.match(/TODO\(drift\):\s*(.*)$/);
      if (m) items.push(`${relative(ROOT, file)}:${i + 1} ${m[1].trim()}`);
    });
  }
  report.push(items.length ? `drift: ${items.length} 条缺口\n    ${items.join("\n    ")}` : "drift: 无登记缺口");
}

// --- boundary：内核对执行面零知识 -----------------------------------------
{
  const words = ["argv", "workspace", "capabilities", "profile", "image", "isolates"];
  const hits = [];
  for (const [file, body] of BODY) {
    if (!file.replace(/\\/g, "/").includes("packages/kernel/src")) continue;
    const code = stripComments(body);
    for (const w of words) {
      if (new RegExp(`\\b${w}\\b`).test(code)) hits.push(`${relative(ROOT, file)} → ${w}`);
    }
  }
  if (hits.length) problems.push(`boundary: 内核非注释代码出现执行面词汇：${hits.join(", ")}`);
  report.push(`boundary: ${hits.length} 处命中（应为 0）`);
}

for (const line of report) console.log(line);
if (problems.length) {
  console.error("\n" + problems.map((p) => `✗ ${p}`).join("\n"));
  if (STRICT) process.exit(1);
}
