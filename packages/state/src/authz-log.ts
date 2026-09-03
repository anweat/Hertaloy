/**
 * 授权日志的落盘实现 —— **追加写的文件，不是可变头的一部分**（§17.6）。
 *
 * ## 为什么不放 head
 *
 * 可变头**每次提交全量重写**。日志放进去，累计写入就是条数的平方级 ——
 * 原来那个 `AUDIT_KEEP = 500` 是给这个病打的补丁，而补丁本身说明存错了地方。
 *
 * §17.6 早写清了：日志是观测，**追加写，不参与重放**。追加写没有那个平方级，
 * 也就不需要为了省写入而截断历史 —— 于是"事后答得出凭什么放行"这件事
 * 才真的成立：证据不会因为跑得久就被挤掉。
 *
 * ## 尾部读，不整读
 *
 * 开文件时要知道上一条的序号，`recent()` 要取最近几条。两件事都只读**尾部
 * 若干字节**，不整读全文 —— 否则日志一长，每次开 run 都要扫一遍。
 * 读到的第一行可能是半截（切在字节中间），丢掉它。
 *
 * ## 边界（如实列）
 *
 * - **不轮转、不回收。**文件只增不减。与对象库同例：`status` 该报出它多大，
 *   但自动删证据是另一回事，要单独想清楚再做。
 * - **不防并发写。**与整个状态目录同一条纪律：单写者，由 `head.lock` 保证
 *   （§17.8）。只读打开不写日志。
 */

import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "@nodeflow/contracts";
import type { AuthzLog } from "@nodeflow/kernel";

/** 每次往前读多少字节。读不够就再来一块，直到凑够或到文件头。 */
const CHUNK_BYTES = 64 * 1024;

export function authzLogPath(root: string): string {
  return join(root, "authz.jsonl");
}

/** 读文件尾部的完整行（丢掉可能被切半的第一行）。 */
function tailLines(path: string, want: number): readonly string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size === 0) return [];

  const fd = openSync(path, "r");
  try {
    let from = size;
    let text = "";
    let lines: string[] = [];
    while (from > 0) {
      const nextFrom = Math.max(0, from - CHUNK_BYTES);
      const length = from - nextFrom;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, nextFrom);
      text = buf.toString("utf8") + text;
      from = nextFrom;

      lines = text.split("\n").filter((l) => l.length > 0);
      // 没读到文件头时，第一行多半被切在字节中间 —— 它不算数
      const usable = from > 0 ? lines.length - 1 : lines.length;
      if (usable >= want) break;
    }
    return from > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

function parse(line: string): AuditEntry | null {
  try {
    return JSON.parse(line) as AuditEntry;
  } catch {
    // 半截行或手工改坏的行：跳过，别让一条坏记录挡住整份日志
    return null;
  }
}

export class FileAuthzLog implements AuthzLog {
  readonly #path: string;
  readonly #readOnly: boolean;
  #seq: number;

  /**
   * `readOnly` 时**只读不写**：只读命令（`status` / `show`）不拿目录锁，
   * 让它们追加日志就等于两个进程同时写一个文件（§17.8）。
   */
  constructor(root: string, readOnly = false) {
    this.#path = authzLogPath(root);
    this.#readOnly = readOnly;
    const last = tailLines(this.#path, 1)
      .map(parse)
      .filter((e): e is AuditEntry => e !== null)
      .at(-1);
    this.#seq = last?.seq ?? 0;
  }

  get path(): string {
    return this.#path;
  }

  record(entry: Omit<AuditEntry, "seq">): void {
    if (this.#readOnly) return;
    this.#seq += 1;
    const full: AuditEntry = { ...entry, seq: this.#seq };
    appendFileSync(this.#path, `${JSON.stringify(full)}\n`, "utf8");
  }

  recent(limit = 200): readonly AuditEntry[] {
    const parsed = tailLines(this.#path, limit)
      .map(parse)
      .filter((e): e is AuditEntry => e !== null);
    return parsed.slice(-limit);
  }
}
