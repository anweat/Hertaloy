/**
 * 可变头 —— 状态的另一半（§17.2）。
 *
 * 实例树 + 锁账本 + 消息队列 + 三个计数器，合起来一个 JSON 文件。
 * 它不随历史增长（在途消息数 × 常数），所以**全量原子写**就够，
 * 不上 WAL —— §17.11 那条"不做"的兑现。
 *
 * 原子性靠"写临时文件 + rename"：POSIX 与 Windows 上 rename 覆盖都是原子的，
 * 所以读到的 head 要么是上一版要么是新版，不存在半截。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "@nodeflow/contracts";
import { decode, encode } from "./codec.js";

/** 格式版本。改了结构就加一 —— 装载时对不上直接拒绝，不猜。 */
export const HEAD_FORMAT = 1;

export interface Head {
  readonly format: number;
  readonly root: string | null;
  /** 已刷盘的对象版本数 —— 装载后对象库的游标从这里起。 */
  readonly objectCursor: number;
  readonly registry: Json;
  readonly ledger: Json;
  readonly runtime: Json;
}

export function headPath(root: string): string {
  return join(root, "head.json");
}

export function writeHead(
  root: string,
  parts: {
    readonly root: string | null;
    readonly objectCursor: number;
    readonly registry: unknown;
    readonly ledger: unknown;
    readonly runtime: unknown;
  },
): void {
  const head: Head = {
    format: HEAD_FORMAT,
    root: parts.root,
    objectCursor: parts.objectCursor,
    registry: encode(parts.registry),
    ledger: encode(parts.ledger),
    runtime: encode(parts.runtime),
  };
  const target = headPath(root);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(head, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

export function readHead(root: string): Head | null {
  const target = headPath(root);
  if (!existsSync(target)) return null;
  const head = JSON.parse(readFileSync(target, "utf8")) as Head;
  if (head.format !== HEAD_FORMAT) {
    throw new Error(
      `head.json 是格式 ${String(head.format)}，本内核只认 ${HEAD_FORMAT}。` +
        "版本不符时拒绝装载 —— 猜着读会把状态读成似是而非的样子。",
    );
  }
  return head;
}

export function decodeHeadParts(head: Head): {
  readonly registry: unknown;
  readonly ledger: unknown;
  readonly runtime: unknown;
} {
  return {
    registry: decode(head.registry),
    ledger: decode(head.ledger),
    runtime: decode(head.runtime),
  };
}
