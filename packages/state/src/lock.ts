/**
 * 状态目录锁（§17.8）。
 *
 * 与内核的 L1/L2 锁**完全不是一回事**：内核锁是容器的阻塞态、是状态、进 head；
 * 这把锁是操作系统层面的进程排他、不是状态、就是文件本身。
 *
 * 防的是：两个 `hertaloy` 进程同时写一个 run。可变头是全量重写的，
 * 两个进程交替写就会互相把对方的提交整段抹掉 —— 而且不留痕迹。
 *
 * 用 `wx` 标志创建：文件已存在就失败。这是文件系统层面的原子操作，
 * 不是"先 exists 再 write"那种有竞态的写法。
 */

import { existsSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  readonly pid: number;
  readonly since: string;
}

export function lockPath(root: string): string {
  return join(root, "head.lock");
}

export class StateLock {
  readonly #path: string;
  #held = false;

  constructor(root: string, name: "head.lock" | "driver.lock" = "head.lock") {
    this.#path = join(root, name);
  }

  get held(): boolean {
    return this.#held;
  }

  /** 拿锁。已被别的进程持有就抛 —— 带上对方 pid，好让人能去查。 */
  acquire(): void {
    try {
      const fd = openSync(this.#path, "wx");
      const info: LockInfo = { pid: process.pid, since: new Date().toISOString() };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      this.#held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(
        `状态目录已被占用：${this.#path}（持有者 ${describe(this.#path)}）。` +
          "该锁保护的操作不可并发。确认持有进程已经结束且没有后继持有者，再清理这个锁文件。",
      );
    }
  }

  release(): void {
    if (!this.#held) return;
    rmSync(this.#path, { force: true });
    this.#held = false;
  }
}

function describe(path: string): string {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return `pid ${String(info.pid)}，自 ${info.since}`;
  } catch {
    return "内容不可读";
  }
}

export function isLocked(root: string): boolean {
  return existsSync(lockPath(root));
}
