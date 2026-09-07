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
  type StepFailure,
  InstanceRegistry,
  ObjectStore,
  Runtime,
  type Scheduler,
  type ExecutionSpecValidator,
} from "@nodeflow/kernel";
import type { ExecutionBackend } from "@nodeflow/contracts";
import { type LoadedPermissions, loadPermissions } from "./permissions.js";
import { type LoadedResources, loadResources } from "./resources.js";
import { decodeHeadParts, readHead, writeHead } from "./head.js";
import { StateLock } from "./lock.js";
import { FileAuthzLog } from "./authz-log.js";
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
  /**
   * 先跑哪条。不给就是内核默认的 FIFO。
   *
   * 接出来是因为**缝不通到调用得着的地方就等于没有**：`instances.ts` 里那条
   * 注释记着"K5、E1 是同一类：实现在，路不通"，这个项目被这个形状咬过四次。
   */
  readonly scheduler?: Scheduler;
  /**
   * 执行面声明（`agent` 段）的注册期校验。
   *
   * `state` **不依赖 sandbox**，所以这个只能由调用方给（CLI 接的是
   * sandbox 的 `checkAgentSpec`）。不给就只剩契约层那条凭据扫描 ——
   * 于是 `workspace` 写错要等到运行期才发现，与 §1 相悖。
   */
  readonly validateExecutionSpec?: ExecutionSpecValidator;
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
  /** 资源别名注册表 —— 动态上载的落点，见 resources.ts。 */
  readonly resources: LoadedResources;
  /** 本次打开认领了哪些孤儿执行。空数组 = 上次是干净退出的。 */
  reconciled: readonly StepFailure[] = [];
  /**
   * 授权决策日志 —— **追加写的文件**，不进可变头（§17.6 / `authz-log.ts`）。
   *
   * 由 `RunState` 持有而不是 `ControlPlane`：后者是每次访问现构造的，拿不住
   * 任何东西 —— 那也正是这份日志当初错落在 `Runtime` 上的原因。
   */
  readonly authzLog: FileAuthzLog;

  readonly #lock: StateLock | null;
  #validateExecutionSpec: ExecutionSpecValidator | undefined;
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
    resources: LoadedResources,
  ) {
    this.dir = dir;
    this.store = store;
    this.registry = registry;
    this.runtime = runtime;
    this.recovered = recovered;
    this.permissions = permissions;
    this.resources = resources;
    this.#lock = lock;
    this.#cursor = cursor;
    // 只读打开不写日志：那些命令不拿目录锁，写就成了两个进程同时写一个文件（§17.8）
    this.authzLog = new FileAuthzLog(dir, lock === null);
  }

  static open(dir: string, options: OpenOptions = {}): RunState {
    mkdirSync(dir, { recursive: true });

    const lock = options.readOnly === true ? null : new StateLock(dir);
    lock?.acquire();

    try {
      const permissions = loadPermissions(dir);
      const resources = loadResources(dir);
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
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      });
      const head = readHead(dir);

      if (head === null) {
        self = new RunState(dir, store, registry, runtime, false, lock, 0, permissions, resources);
        self.#validateExecutionSpec = options.validateExecutionSpec;
        return self;
      }

      // 顺序要紧：对象先装，因为实例树里存的是指向对象的 Ref，
      // 恢复实例时会去解析模板
      let cursor: number;
      try {
        cursor = loadObjects(dir, store, head.format === 1 ? undefined : head.objectHeads);
        if (cursor !== head.objectCursor) {
          throw new Error(
            `对象库与可变头对不上：磁盘上 ${cursor} 个版本，head 记的是 ${head.objectCursor} 个。` +
              "旧目录可能崩在刷对象与写 head 之间，或者目录被手工动过。",
          );
        }
      } catch (error) {
        // 只读者可能在拿到旧 head 后遇到另一个写者升级；新格式有明确清单，
        // 丢弃本次不完整装载，重新打开。格式 2 失败不重试，也不忽略缺失文件。
        if (head.format === 1 && readHead(dir)?.format === 2) {
          lock?.release();
          return RunState.open(dir, options);
        }
        throw error;
      }
      const parts = decodeHeadParts(head);
      registry.restore(parts.registry);
      /**
       * `parts.ledger` **故意不装**。锁不再是状态 —— 它是义务枚举
       * （`kernel/obligations.ts`）算出来的，装回来就等于把已经删掉的
       * 第二份拷贝从磁盘里请回来。字段本身保留，老 run 装得进来。
       */
      runtime.restore(parts.runtime);

      self = new RunState(dir, store, registry, runtime, true, lock, cursor, permissions, resources);
        self.#validateExecutionSpec = options.validateExecutionSpec;

      /**
       * **认领不再在 open 时自动发生。**
       *
       * 原来的推理是"拿到目录锁 ⇒ 没有别的写进程 ⇒ RUNNING 必然是孤儿"。
       * 那句话本身没错，错在**前提被我们自己破坏了**：为了让 agent 挂死时
       * `truncate` 进得来，`drain` 改成了"每步开关状态目录、跑 agent 时不持锁"。
       * 于是 agent 在外面跑的那段时间里，任何一条写命令拿到锁一看 ——
       * RUNNING！认领！消息退回队列 → 第二个 agent 被派出去。
       *
       * **不需要崩溃，正常路径上就会发生。**单进程 drain 里更是每步都会
       * 认领自己刚落盘的 claim，attempts 白涨。
       *
       * 所以改成**显式调用**：由驱动方在开始推进**之前**认领一次
       * （那时它确实是唯一在跑的）。真正的修法是给执行加租约标识，
       * 让"孤儿"与"别人正持有的在途执行"分得开 —— 那是下一批。
       */
      return self;
    } catch (error) {
      lock?.release();
      throw error;
    }
  }

  /**
   * 落盘。**先对象后 head** —— 顺序不能反。
   *
   * head 的对象版本清单决定可见性；刷盘成功而 head 未提交时，旧清单之外的
   * 文件保持不可见。重放允许替换未提交文件，但不重写已提交版本。
   */
  persist(): void {
    if (this.#lock?.held !== true) throw new Error("persist 需要当前实例持有写锁；只读或已关闭的状态不能保存");
    // 旧格式没有逐对象边界：先为旧状态发布清单，再开始可能中断的新增写入。
    const previous = readHead(this.dir);
    if (previous?.format === 1) {
      const parts = decodeHeadParts(previous);
      writeHead(this.dir, {
        ...parts,
        root: previous.root,
        objectCursor: previous.objectCursor,
        objectHeads: headsAt(this.store, this.#cursor),
      });
    }
    const cursor = flushObjects(this.dir, this.store, this.#cursor);
    writeHead(this.dir, {
      root: this.registry.rootTrace,
      objectCursor: cursor,
      objectHeads: headsAt(this.store, cursor),
      registry: this.registry.snapshot(),
      // 锁已归约成派生投影，这里只为格式兼容留个空位（见装载侧的说明）
      ledger: {},
      runtime: this.runtime.snapshot(),
    });
    this.#cursor = cursor;
  }

  /**
   * 带权限检查的入口 —— **对外的一切都该走它**，不是直接摸 `runtime`。
   *
   * `actor` 不在这里给，而是 `ControlPlane` 的**每个方法**都要求传 ——
   * 那样才不可能出现"建的时候是 A、用的时候当成 B"。它由调用方注入
   * （CLI 的 `--as`、将来的 MCP 会话），绝不从载荷里取（§11.3）。
   */
  get control(): ControlPlane {
    return new ControlPlane(
      this.runtime,
      this.registry,
      this.store,
      this.permissions.table,
      {
        log: this.authzLog,
        ...(this.#validateExecutionSpec === undefined
          ? {}
          : { validateExecutionSpec: this.#validateExecutionSpec }),
      },
    );
  }

  /**
   * 认领孤儿执行并落盘。**宿主取得独占驱动权后，在开始推进之前调一次。**
   *
   * 不在 `open` 里自动做 —— 见构造处的说明：跑 agent 时不持锁，
   * head.lock 只能证明此刻没人写状态，不能证明其他进程没有在执行。
   */
  reconcile(): readonly StepFailure[] {
    if (this.#lock === null) return []; // 只读打开没有"我是唯一写者"的前提
    const out = this.runtime.reconcile();
    if (out.length > 0) this.persist();
    this.reconciled = out;
    return out;
  }

  close(): void {
    this.#lock?.release();
  }
}

/** Object.fromEntries 保留特殊对象名为自有键；同一对象最后一版覆盖前面的计数。 */
function headsAt(store: ObjectStore, cursor: number): Readonly<Record<string, number>> {
  return Object.fromEntries(store.appended(0).slice(0, cursor).map((v) => [v.object_id, v.version]));
}
