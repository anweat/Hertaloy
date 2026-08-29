/**
 * 沙箱内的工具集 —— agent 在跑的过程中把动作**记下来**。
 *
 * ## 为什么要它
 *
 * 此前是**一次性交付**：agent 最后写一个 `emit.json`，沙箱跑完读一次。
 * 于是内核对过程一无所知 —— 只有最终结果，没有"它试过什么、按什么顺序"。
 * 而语义进度（"我在跑第 3 组测试"）内核**原则上**推不出来：
 * 有环的流程没有分母。那一半只能上报。
 *
 * ## 为什么零内核改动
 *
 * 内核只见到 `ExecutionResult`，而**沙箱拥有契约目录**。所以：
 *
 *   agent  →  写 journal/NNNN.json
 *   沙箱   →  读 journal → 合成 emissions + 整条 journal 进 diagnostics
 *   内核   →  照旧收一个 ExecutionResult
 *
 * **零部分提交天然保住**：合成发生在沙箱侧，结果仍是一次性交回内核，
 * 三段式那段不持锁的执行期一点没碰。工具调用是**记录 + 意图**，
 * 不是即时提交 —— 这条错了的话，agent 中途挂掉会留下已发的消息，
 * 而下游收到半截结果是没人会发现的那种坏。
 *
 * ## 为什么没有 `publish`
 *
 * 走内网还是走网关**由端口声明决定，不由 handler 选**（不变量 M1）。
 * 给 agent 一个 `publish` 就等于让它挑传输方式 —— M1 当场从结构性保证
 * 降级成口头约定。往带 `tunnel` 的端口 `emit`，它自然就走网关。
 *
 * ## 为什么没有 `put`
 *
 * `artifacts/` 目录已经是能用的落资产路径。再加一个 `put` 就是
 * "两个入口、一个少做一件事"——这个项目被这个形状咬过七次。
 * 真要 `put` 进日志，得先想清楚它和 `artifacts/` 谁是权威。
 *
 * ## 老路径不删
 *
 * `emit.json` 保留。镜像里没有 node、或 agent 不认识工具时，
 * 它仍然能交付。工具是**增量**，不是替换。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxPaths } from "./layout.js";

/** 一条工具调用。`seq` 由文件名给，不进正文 —— 免得两处对不上。 */
export interface JournalEntry {
  readonly seq: number;
  readonly op: string;
  readonly [key: string]: unknown;
}

const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 64 * 1024;

/**
 * 工具本体。**自包含的 node 脚本**，不依赖任何包。
 *
 * 不做 sh 包装也不改 PATH：`node <路径>` 到处都能跑，而包装脚本在
 * Windows 本地运行器上会当场失效。确切的调用串写进 `request.json` ——
 * 告诉 agent 的话必须是对的，说错了比不说更糟（`emitPath` 那条教训）。
 *
 * 元目录靠**脚本自己的位置**推出来，不靠环境变量：agent 可能换 cwd，
 * 而脚本位置不会变。
 */
const TOOL_SOURCE = String.raw`#!/usr/bin/env node
// Hertaloy 沙箱工具 —— 由 backend 写入，不要手改。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const META = dirname(dirname(fileURLToPath(import.meta.url)));
const JOURNAL = join(META, "journal");

function request() {
  try {
    return JSON.parse(readFileSync(join(META, "request.json"), "utf8"));
  } catch {
    return {};
  }
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

/**
 * 序号靠文件名，不靠内存计数 —— 每次调用都是一个新进程。
 * 用 wx 独占创建，撞了就 +1 重试：并发调用不会互相覆盖。
 */
function append(entry) {
  let n = 0;
  try {
    for (const f of readdirSync(JOURNAL)) {
      const m = /^(\d+)\./.exec(f);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    die("找不到日志目录：" + JOURNAL);
  }
  for (let i = 0; i < 200; i += 1) {
    n += 1;
    const name = String(n).padStart(4, "0") + "." + entry.op + ".json";
    try {
      writeFileSync(join(JOURNAL, name), JSON.stringify(entry) + "\n", { flag: "wx" });
      return n;
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      die("写日志失败：" + String(e));
    }
  }
  die("日志序号冲突太多次");
}

const [op, ...rest] = process.argv.slice(2);

if (op === "emit") {
  const [port, raw] = rest;
  const allowed = request().allowedEmitPorts ?? [];
  if (port === undefined) die("用法：emit <端口> <JSON>");
  // ★ 当场拒绝并列出可用的 —— 不必等跑完才拿一个 INVALID_OUTPUT
  if (!allowed.includes(port)) {
    die("端口 " + port + " 不在允许列表里。可用：" + (allowed.join(" ") || "（无）"));
  }
  let payload;
  try {
    payload = JSON.parse(raw ?? "{}");
  } catch (e) {
    die("载荷不是合法 JSON：" + String(e));
  }
  const seq = append({ op: "emit", port, payload });
  process.stdout.write("已记录 emit " + port + "（#" + seq + "）\n");
} else if (op === "progress") {
  const [done, total, ...note] = rest;
  const d = Number(done);
  const t = Number(total);
  if (!Number.isFinite(d) || !Number.isFinite(t) || t <= 0) {
    die("用法：progress <已完成> <总数> [说明]");
  }
  const seq = append({ op: "progress", done: d, total: t, note: note.join(" ") });
  process.stdout.write("已记录 progress " + d + "/" + t + "（#" + seq + "）\n");
} else {
  die("未知操作：" + String(op) + "。可用：emit progress");
}
`;

/** 把工具写进沙箱。 */
export function installToolkit(paths: SandboxPaths): void {
  writeFileSync(join(paths.bin, "hertaloy.mjs"), TOOL_SOURCE, "utf8");
}

/**
 * 读日志，按序号排。
 *
 * 坏行**跳过而不是整份放弃**：agent 写坏一条不该让整次执行的记录都丢掉，
 * 而丢掉的恰恰是排查现场。
 */
export function readJournal(paths: SandboxPaths): readonly JournalEntry[] {
  let names: string[];
  try {
    names = readdirSync(paths.journal);
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const name of names.sort()) {
    const m = /^(\d+)\./.exec(name);
    if (m === null) continue;
    try {
      const raw = readFileSync(join(paths.journal, name), "utf8");
      if (raw.length > MAX_ENTRY_BYTES) continue;
      const body = JSON.parse(raw) as Record<string, unknown>;
      out.push({ ...body, seq: Number(m[1]), op: String(body.op ?? "?") });
    } catch {
      continue;
    }
  }
  return out.slice(-MAX_ENTRIES);
}

/**
 * 日志里的 emit 合成 emissions —— **同一端口后写的赢**。
 *
 * 这是"记录 + 意图"落地成结果的地方：调用当时只写日志，
 * 直到这里才变成要交给内核的 emissions，而交付仍是一次性的。
 */
export function emissionsFromJournal(
  entries: readonly JournalEntry[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const e of entries) {
    if (e.op !== "emit" || typeof e.port !== "string") continue;
    out[e.port] = e.payload ?? {};
    any = true;
  }
  return any ? out : null;
}

/** 最后一条 progress —— 语义进度，内核推不出来的那一半。 */
export function progressFromJournal(
  entries: readonly JournalEntry[],
): { readonly done: number; readonly total: number; readonly note?: string } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as JournalEntry;
    if (e.op !== "progress") continue;
    if (typeof e.done !== "number" || typeof e.total !== "number") continue;
    const note = typeof e.note === "string" && e.note !== "" ? e.note : undefined;
    return { done: e.done, total: e.total, ...(note === undefined ? {} : { note }) };
  }
  return null;
}
