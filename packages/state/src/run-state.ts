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
import {
  type CommitEvent,
  ControlPlane,
  InstanceRegistry,
  ObjectStore,
  Runtime,
} from "@nodeflow/kernel";
import type { ExecutionBackend } from "@nodeflow/contracts";
import { type LoadedPermissions, loadPermissions } from "./permissions.js";
import { decodeHeadParts, readHead, writeHead } from "./head.js";
import { StateLock } from "./lock.js";
import { flushObjects, loadObjects } from "./objects.js";

export interface OpenOptions {
  /** 不拿目录锁。只给只读命令（`status` / `show`）用。 */
  readonly readOnly?: boolean;
  /**
   * agent 节点的执行面。不给就只能跑同步 handler 节点。
   *
   * 内核不自己造 backend：它是不可信边界（`checkBackendResult` 就为这个存在），
   * 由谁来跑、跑在哪种沙箱里，是调用方的决定，不是内核的默认值。
   */
  readonly backend?: ExecutionBackend;
  /**
   * 关掉 claim 的自动落盘。**只给测试用。**
   *
   * 生产里关掉它就等于放弃 §17.4：崩在 claim 与 apply 之间，恢复后内核
   * 不知道外面有个 agent 在跑，会再派一个。
   */
  readonly manualDurability?: boolean;
}

export class RunState {
  readonly dir: string;
  readonly store: ObjectStore;
  readonly registry: InstanceRegistry;
  readonly runtime: Runtime;
  /** 这次是从磁盘恢复的，还是新建的空状态。 */
  readonly recovered: boolean;
  /** 根权限表 + 它是从配置文件来的还是缺省的（§17.9）。 */
  readonly permissions: LoadedPermissions;

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
    permissions: LoadedPermissions,
  ) {
    this.dir = dir;
    this.store = store;
    this.registry = registry;
    this.runtime = runtime;
    this.recovered = recovered;
    this.permissions = permissions;
    this.#lock = lock;
    this.#cursor = cursor;
  }

  static open(dir: string, options: OpenOptions = {}): RunState {
    mkdirSync(dir, { recursive: true });

    const lock = options.readOnly === true ? null : new StateLock(dir);
    lock?.acquire();

    try {
      const permissions = loadPermissions(dir);
      const store = new ObjectStore();
      const registry = new InstanceRegistry(store);
      /**
       * 提交钩子按 §17.4 的判据分流：
       *
       *   claim  → **当场落盘**。它后面紧跟着花钱的外部副作用，
       *            重放代价不是零。钩子在事务内，所以写盘失败会回滚这次 claim ——
       *            落不了盘就不 claim，正是我们要的。
       *   其余   → 不落。handler 与路由重放无代价（内容寻址去重让它幂等），
       *            攒到静止点由调用方 `persist()`。
       *
       * 这个 self 引用绕一下：Runtime 要在构造时拿到钩子，而钩子要用到
       * 构造完的 RunState。用一个可变槽接住，比把持久化塞进内核干净。
       */
      let self: RunState | null = null;
      const onCommit =
        options.manualDurability === true
          ? undefined
          : (event: CommitEvent): void => {
              if (event.kind === "claim") self?.persist();
            };
      const runtime = new Runtime(store, registry, {
        ...(onCommit === undefined ? {} : { onCommit }),
        ...(options.backend === undefined ? {} : { backend: options.backend }),
      });
      const head = readHead(dir);

      if (head === null) {
        self = new RunState(dir, store, registry, runtime, false, lock, 0, permissions);
        return self;
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
      self = new RunState(dir, store, registry, runtime, true, lock, cursor, permissions);
      return self;
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

  /**
   * 带权限检查的入口 —— **对外的一切都该走它**，不是直接摸 `runtime`。
   *
   * `actor` 不在这里给，而是 `ControlPlane` 的**每个方法**都要求传 ——
   * 那样才不可能出现"建的时候是 A、用的时候当成 B"。它由调用方注入
   * （CLI 的 `--as`、将来的 MCP 会话），绝不从载荷里取（§11.3）。
   */
  get control(): ControlPlane {
    return new ControlPlane(this.runtime, this.registry, this.store, this.permissions.table);
  }

  close(): void {
    this.#lock?.release();
  }
}
