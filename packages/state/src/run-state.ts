/**
 * 一个 run 的落盘状态 —— 把对象库、可变头、目录锁合成一件东西。
 *
 * 对应 FOUNDATION_V5.md §17。用法：
 *
 * ```ts
 * const state = RunState.open(dir);        // 新建或恢复
 * state.registry.createRoot(ref, "job-1");
 * state.runtime.drain();
 * state.persist();                          // 落盘
 * state.close();                            // 放锁
 * ```
 *
 * **落盘是显式的**，不是每次提交自动发生 —— §17.4 的判据是"重放会不会产生
 * 第二次副作用"，而那个判断在驱动方（CLI / 场景）手里，不在这一层。
 * 这一层只保证：`persist()` 返回后，磁盘上是一个自洽的状态。
 */

import { mkdirSync } from "node:fs";
import { InstanceRegistry, ObjectStore, Runtime } from "@nodeflow/kernel";
import { decodeHeadParts, readHead, writeHead } from "./head.js";
import { StateLock } from "./lock.js";
import { flushObjects, loadObjects } from "./objects.js";

export interface OpenOptions {
  /** 不拿目录锁。只给只读命令（`status` / `show`）用。 */
  readonly readOnly?: boolean;
}

export class RunState {
  readonly dir: string;
  readonly store: ObjectStore;
  readonly registry: InstanceRegistry;
  readonly runtime: Runtime;
  /** 这次是从磁盘恢复的，还是新建的空状态。 */
  readonly recovered: boolean;

  readonly #lock: StateLock | null;
  #cursor: number;

  private constructor(
    dir: string,
    store: ObjectStore,
    registry: InstanceRegistry,
    runtime: Runtime,
    recovered: boolean,
    lock: StateLock | null,
    cursor: number,
  ) {
    this.dir = dir;
    this.store = store;
    this.registry = registry;
    this.runtime = runtime;
    this.recovered = recovered;
    this.#lock = lock;
    this.#cursor = cursor;
  }

  static open(dir: string, options: OpenOptions = {}): RunState {
    mkdirSync(dir, { recursive: true });

    const lock = options.readOnly === true ? null : new StateLock(dir);
    lock?.acquire();

    try {
      const store = new ObjectStore();
      const registry = new InstanceRegistry(store);
      const runtime = new Runtime(store, registry);
      const head = readHead(dir);

      if (head === null) {
        return new RunState(dir, store, registry, runtime, false, lock, 0);
      }

      // 顺序要紧：对象先装，因为实例树里存的是指向对象的 Ref，
      // 恢复实例时会去解析模板
      const cursor = loadObjects(dir, store);
      const parts = decodeHeadParts(head);
      registry.restore(parts.registry);
      runtime.locks.restore(parts.ledger);
      runtime.restore(parts.runtime);

      if (cursor !== head.objectCursor) {
        throw new Error(
          `对象库与可变头对不上：磁盘上 ${cursor} 个版本，head 记的是 ${head.objectCursor} 个。` +
            "多半是崩在刷对象与写 head 之间，或者目录被手工动过。",
        );
      }
      return new RunState(dir, store, registry, runtime, true, lock, cursor);
    } catch (error) {
      lock?.release();
      throw error;
    }
  }

  /**
   * 落盘。**先对象后 head** —— 顺序不能反。
   *
   * head 里记着"已刷了多少个对象版本"。先写 head 再刷对象的话，中间崩溃会留下
   * 一个引用了不存在对象的 head，恢复时解析 Ref 直接失败。反过来则最坏是多刷了
   * 几个对象、head 还是旧的 —— 那些对象是写一次的，内容寻址，重跑会原样重写，
   * 无害。**多余的不可变数据无害，悬空的引用致命。**
   */
  persist(): void {
    this.#cursor = flushObjects(this.dir, this.store, this.#cursor);
    writeHead(this.dir, {
      root: this.registry.rootTrace,
      objectCursor: this.#cursor,
      registry: this.registry.snapshot(),
      ledger: this.runtime.locks.snapshot(),
      runtime: this.runtime.snapshot(),
    });
  }

  close(): void {
    this.#lock?.release();
  }
}
