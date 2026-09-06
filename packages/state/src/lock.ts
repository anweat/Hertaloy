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

/** 目录里可能出现的锁。两把寿命完全不同 —— 见 `StateLock` 的说明。 */
const LOCK_NAMES = ["head.lock", "driver.lock"] as const;
export type LockName = (typeof LOCK_NAMES)[number];

export interface HeldLock {
  readonly name: LockName;
  /** 锁文件内容坏掉时为 null —— 报"有锁但读不出是谁"，好过假装没有。 */
  readonly pid: number | null;
  readonly since: string | null;
}

/**
 * **本进程**当前持有的锁。
 *
 * 只给一件事用：进程被信号打断时把它们放掉（见 `releaseHeldLocks`）。
 * 这不是第二本账 —— `held` 是每个 `StateLock` 自己的字段，这里只是它们的索引，
 * `acquire` / `release` 是唯一的增删点。
 */
const heldHere = new Set<StateLock>();

/**
 * 放掉本进程持有的全部锁。
 *
 * `finally` 挡得住异常与正常返回，**挡不住信号** —— Node 收到没有监听器的
 * SIGINT 会直接终止，`finally` 不跑。而 `driver.lock` 现在跨越整个 agent 执行
 * （分钟级），Ctrl-C 恰好最可能发生在那段时间里：留下的锁会让之后每次 drain
 * 都失败，而且没有内建的清理出路。
 *
 * 这个函数只负责"放掉"；**要不要退出、退出码是多少，由进程的主人决定** ——
 * 库不替应用定进程策略。
 */
export function releaseHeldLocks(): void {
  for (const lock of [...heldHere]) lock.release();
}

/**
 * 目录里现在有哪几把锁，各自是谁。
 *
 * 给 `status` 用：一把残留的 `driver.lock` 会让整个 run 推不动，而在此之前
 * 它在任何输出里都看不见 —— 只能靠人想起来去 ls 目录。
 */
export function lockHolders(root: string): readonly HeldLock[] {
  const out: HeldLock[] = [];
  for (const name of LOCK_NAMES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    } catch {
      info = null;
    }
    out.push({ name, pid: info?.pid ?? null, since: info?.since ?? null });
  }
  return out;
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
      heldHere.add(this);
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
    heldHere.delete(this);
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
