# 观察面 —— 钩子与快照

> 状态：**设计稿（2026-08-22）**，未实现。前置于 [FRONTEND_V5.md](./FRONTEND_V5.md)。
>
> 这一层的职责只有一句：**把「状态变了」和「状态是什么」这两件事，
> 以不打扰内核的方式送出去。**
>
> **独立性判据（可证伪）**：本层的第一个消费者必须是 **CLI**，不是浏览器。
> 如果 `hertaloy status --watch` 和 `hertaloy snapshot` 用不上它，
> 说明它被前端的需求污染了，回头改。

---

## 0. 从代码里读出来的三条约束

设计不是从愿望出发的，先把已经存在的事实摆出来。

### 0.1 内核**已经有**提交钩子，但它属于耐久性，不属于观察

`runtime.ts` 里：

```ts
export interface CommitEvent {
  readonly kind: "commit" | "claim" | "apply" | "settle" | "truncate";
  readonly traceid: TraceId;
  readonly executionId?: string;
}
/** 提交钩子 —— **在事务内**调用。抛异常即回滚整次提交。 */
export type CommitHook = (event: CommitEvent) => void;
```

`RunState` 已经占用了它：`claim` 事件当场 `persist()`，写盘失败就回滚这次 claim。
**这是正确的语义，不能共享。**

> ⚠️ **观察面绝不挂 `CommitHook`。** 它在 `transact` 里，一个慢的或者会抛的监听器
> 能让一次内核提交回滚。观察永远不该有能力影响被观察者。
> 把「通知前端」挂进事务，等于让浏览器断线变成内核事务失败。

### 0.2 状态目录是单写者，但**只读打开不持锁**

`StateLock` 用 `open(..., "wx")` 做进程排他；`RunState.open(dir, {readOnly: true})` 不拿锁。
所以观察者可以一直读，永远不挡写者。

> **不变量 O1：观察者永不持有目录锁。** 一旦持锁，看一眼图就会把 CLI 挡在门外。

### 0.3 变更来自三个进程，进程内钩子必然漏

| 变更来源 | 进程 | 进程内钩子看得见吗 |
|---|---|---|
| 服务端自己驱动 | 同进程 | ✅ |
| `hertaloy send` / `drain` / `truncate` | 另一个进程 | ❌ |
| MCP 工具（11 个） | 另一个进程 | ❌ |
| 手工改 `permissions.json` | 无进程 | ❌ |

三个来源的**唯一交汇点是状态目录**。

---

## 1. 结论：钩子的落点是状态目录，不是内核

> **O2 —— 观察面只认磁盘。它不 import Runtime，不注册任何内核回调。**

代价是延迟（去抖窗口，~100ms 量级），收获是三条：

1. **对所有写者一视同仁** —— 谁改的都一样能看见，服务端不给自己开后门（§5.2）
2. **内核零改动** —— 观察面可以整个删掉而内核不受影响，这是「独立」的可检验定义
3. **观察者可以是独立进程** —— 崩了、卡了、被 kill 了，run 照跑

---

## 2. 游标 —— 观察面唯一的标量

```ts
export interface Cursor {
  /** head.runtime.seq —— 消息序号。内核唯一的单调时间刻度（L0）。 */
  readonly seq: number;
  /** head.objectCursor —— 已刷盘的对象版本数。 */
  readonly objects: number;
  /** permissions.json + resources.json 的内容哈希。 */
  readonly config: string;
}
```

**为什么必须是三元组**，每一项都是被具体机制逼出来的：

| 分量 | 少了它会漏掉什么 |
|---|---|
| `seq` | 消息流转（大部分变化都在这儿） |
| `objects` | 内容寻址**会去重**：两次内容相同的产出不产生新版本，但 seq 会动；反过来，装载对象与写 head 是两步，只看 seq 会漏掉对象侧的推进 |
| `config` | 改授权表 / 资源别名**不碰 head** —— 但界面上所有按钮的可用性都随它变 |

**比较规则**：逐分量比。任一分量不同即「变了」，重取快照。
`seq` / `objects` 单调不减（截断也不回退 seq），`config` 只判等。

> **一次复用，不是一个新概念**：`seq` 就是渲染横轴用的那个数，也是
> `msg-N` 的 N。事件游标、快照版本、图的横坐标 **是同一个量** ——
> 不要为通知另造一个 `revision`。

---

## 3. 钩子 —— `packages/state/src/watch.ts`

放进 `state` 而不是 `server`：它讲的是「怎么观察一个状态目录」，
和 `head.ts` / `lock.ts` 是同一层的事。放进去之后 CLI 立刻能用（§8）。

```ts
export interface WatchOptions {
  /** 尾沿去抖窗口，默认 100ms。 */
  readonly debounceMs?: number;
  /** 轮询兜底间隔，默认 1000ms。 */
  readonly pollMs?: number;
  /** 心跳间隔，默认 15s。让下游能分辨「没变」和「断了」。 */
  readonly heartbeatMs?: number;
}

/** 返回停止函数。回调**永不抛**：内部 catch 并计数。 */
export function watchRun(
  dir: string,
  onChange: (cursor: Cursor) => void,
  options?: WatchOptions,
): () => void;
```

### 3.1 五条实现纪律，每条都对应一个会咬人的地方

1. **watch 目录，不 watch `head.json`。**
   head 是「写临时文件 + rename」落盘的。按路径盯单个文件的 watcher 在第一次
   原子替换之后就**盯着一个已经没人引用的 inode**，此后永远不响 ——
   而它失败的方式是安静的：界面看着正常，只是永远停在第一帧。

2. **必须有轮询兜底。** `fs.watch` 在 WSL 挂载、网络盘、某些编辑器的写法下
   会漏事件。兜底做的事很小：`stat(head.json)` 比 `mtimeMs + size`，
   变了才去读全文。1 秒一次的 stat 便宜到可以忽略。

3. **尾沿去抖，且最后一个不能丢。** `drain()` 期间每次 claim 都 `persist()` 一次，
   而 head 是**全量重写**（实测 2000 条已消费消息 → 1.1MB）。
   一次驱动可能在几百毫秒里写几十次。
   合并成一个事件、只保留最新游标是**正确**的 —— 因为事件不带数据（§3.2），
   丢掉中间态没有任何信息损失。但尾沿那一次必须补发，否则会停在倒数第二帧。

4. **事件只带游标，不带数据。**
   于是事件通道与快照**在原理上不可能漂移**。
   而且这不只是洁癖：观察者本来就读不到 (head, objects) 的原子快照（§4.1），
   任何附在事件上的数据都是猜的。

5. **自愈**：目录还不存在（`init` 之前）、被删、被移走 —— 一律退回轮询并重建 watch，
   不抛。观察面挂掉不该让服务端挂掉。

### 3.2 事件的性质（下游可以依赖的）

- **可合并**：连续 N 个事件等价于最后一个
- **可丢**：丢了中间的没有信息损失
- **最后一个不可丢**：这是唯一的活性要求
- **不保证不重复**：游标没变也可能响一次（比如别的文件被碰了），下游按游标去重

---

## 4. 读路径 —— 观察者不做一致性断言

### 4.1 有一个真实存在的读写竞态，必须正面处理

`RunState.open` 的恢复顺序是：读 head → `loadObjects` → **比对个数，不符就抛**：

```
对象库与可变头对不上：磁盘上 N 个版本，head 记的是 M 个。
```

而 `persist()` 是**先刷对象、后写 head**（顺序不能反，反了会留下悬空引用）。
于是存在一个窗口：对象已经在盘上，head 还是旧的。

- 对**写者**：这个窗口只在崩溃后出现，罕见 —— README 已把它列为已知边界
  （「对象已写、head 未换的崩溃窗口会让 run 拒载」）。
- 对**观察者**：它**每一次轮询都可能落进这个窗口**。罕见事件变成常规事件。

> **O3 —— 一致性断言属于写者，不属于观察者。**
>
> 断言存在的理由是「我接下来要在这个状态上写」。观察者不写，
> 所以它的正确行为是：**照读，并把偏差报出来**。
> 一个因为差了一个对象就整张图不画的观察面，比画出来差一个对象糟得多。

落点：给只读打开一个 `tolerateSkew` 选项，把差值放进快照：

```ts
readonly skew?: { readonly disk: number; readonly head: number };
```

界面上是一条横幅。**它顺带把那个已知 bug 变成可见的** ——
如果这条横幅长期不消，说明真的崩在窗口里了，而不是等下一次 `init` 才发现。

### 4.2 观察者的开销与它的边界

只读打开会把整个 `objects/` 装进内存。对象**只增不减**（回收无设计路径），
所以这个开销随 run 的历史线性增长，而且每次游标变化都重来一遍。

判断：**v1 接受**。人的操作频率是每秒个位数，去抖之后重装也是每秒个位数次。
写下触发重做的条件，别提前优化：

> 装载耗时超过去抖窗口（100ms）时，才上 README 已经想好的那个修法 ——
> 对象文件里写入 append 序号，装载按 cursor 截断。
> 那个修法同时解决 §4.1 的窗口，两个问题一次修完。

### 4.3 快照必须过控制面 —— 这是个安全口子

现有的 `exportSnapshot(state, scope)` **不接受 actor、不做任何授权检查**，
而它现在没有任何调用方（只有定义）。一旦服务端直接调它：

> DQL 授权在快照这条路上被整个绕过 —— `agent:coder-1` 拿到的是全树。

`ControlPlane` 的每个查询方法都 `#authorize(actor, "query", trace)`，
快照不能是例外。

> **O4 —— 快照的签名是 `exportSnapshot(state, actor, scope?)`，
> 每个实例、每个对象都按前缀过一次 `decide`。**
> 越权的部分**不是静默过滤**，而是记一条 `denied: string[]` ——
> 界面要能说「这里有东西你看不到」，不能假装它不存在（§FRONTEND_V5 §3.2）。

---

## 5. 快照分三级

规则先说：**L1 的大小与「活着的东西」成正比，与历史长度无关。**

| 级 | 内容 | 走哪条路 | 大小 |
|---|---|---|---|
| **L0 游标** | `{seq, objects, config}` | SSE 事件 | 几十字节 |
| **L1 清单** | 每样东西**一行**，无正文 | `GET /snapshot?scope=` | 与在途规模成正比 |
| **L2 正文** | 单个对象 body / 消息 payload / `$run` 正文 / 因果查询 | 按需，单独授权 | 不限 |

### 5.1 L1 里什么进什么不进

进：实例树、锁账本、消息头（不含 payload）、执行记录、对象清单、`can{}`、游标、skew。
不进：任何 body。**`$run` 的 `consumed/produced` 也不进** —— 因果视图是 L2 的按需查询。

### 5.2 唯一违反规则的那一项，以及怎么办

逐项检查「与历史长度无关」：

| L1 成分 | 有没有上界 |
|---|---|
| 实例 / 锁 / 在途消息 | ✅ 与在途规模成正比 |
| 已消费消息 | ✅ head 的 `keepConsumedMessages` 封顶 200 |
| 执行记录 | 🚧 随执行次数增长（记录留在 head 里） |
| **对象清单** | ❌ **只增不减**，回收无设计路径 |

⇒ 对象清单**默认按 scope 前缀过滤 + 只送最近 N 条**，全量翻页走 L2。
这不是性能调优，是把上面那条规则真的守住。

### 5.3 快照带自己的游标

```ts
readonly cursor: Cursor;
```

前端的一切一致性判断都靠它，包括读己所写（§6）。
**诚实说明**：快照对 head 是纯函数，对 `objects/` 只是「读的那一刻的清单」——
两者的偏差就是 §4.1 的 `skew`。不假装它是原子的。

---

## 6. 写路径与「读己所写」

### 6.1 服务端是短写长读

- **读**：常驻一个只读视图，按游标刷新，**不持锁**
- **写**：每次操作 `open(可写) → control.xxx(actor,…) → persist() → close()`，
  形状和 CLI 完全一样

必须这样，因为长期持有可写 `RunState` 会把 CLI 整个挡在门外
（`hertaloy status` 只读还行，`send` / `truncate` 直接失败）。
反过来，CLI 持锁时服务端的写会失败 —— 那条错误消息里已经带了对方 pid，
**原样透给界面**，不要包装成「操作失败」。

### 6.2 写操作返回游标

```
POST /api/truncate → { ..., cursor: {seq, objects, config} }
```

前端拿到之后**等**一份 `cursor >= 返回值` 的快照再更新画面，
中间显示「应用中」。于是：

- 不需要乐观更新（乐观更新 = 前端自己攒了一份状态 = 第二个真相源）
- 不需要给自驱动开一条特殊通知路径（§1 那条「不给自己开后门」）
- 「我点的那一下到底生效没有」有确定答案，而不是靠等

---

## 7. 能拿到的信息全表

下一轮设计前端就是对着这张表挑。**全部来自现有代码，不需要内核改动。**

### A. `head.registry` —— 实例树

`traceid` · `templateRef`（精确到版本）· `status` · `generation`（截断栅栏）·
`seq`（提交序号）· `slot`（来自父容器哪个子槽）· `nodes`（节点 id 集）
派生：父子 / 深度 / 子树 —— 全部从 traceid 前缀免费得到

### B. `head.ledger` —— 锁账本（阻塞的全部依据）

`id` · `kind`（只有 `request` / `child` 两种）· `holder` · `waitingOn` ·
`originNode`（仅供展示）· `key` · `since`（逻辑时钟，不是墙钟）
派生：`deadlocks()` 环 · 每个实例的 `terminationBlockers()`

### C. `head.runtime` —— 消息与执行

- **消息**：`id`（`msg-N`）· `target{traceid,node,port}` · `state`（QUEUED /
  CLAIMED / CONSUMED / FAILED / DISCARDED）· `source{traceid,node?,port?}`（**省略 =
  外部注入**）· `tunnel` · `requestId` · `inReplyTo` · `attempts` · `failure` ·
  `payload`（**L2**）
- **执行记录**：`executionId` · `traceid` · `nodeId` · `status`（RUNNING / SETTLED /
  VOIDED）· `termination`（DONE / CANCELLED / BUDGET / INVALID_OUTPUT / FAILED，
  **五种不能混成一种**）· `claimed[]` · `generation` ·
  `usage{inTokens,outTokens,costUsd,wallClockSeconds,toolCalls,compactions}`
- **计数器**：`seq` · `requestSeq` · `executionSeq`

### D. `objects/` —— 版本层

每个版本：`object_id` · `version` · `kind` · `content_hash` ·
`provenance{traceid,node_id,execution_id,at_seq,derived_from[]}` · `body`（**L2**）

| 内核对象 | body 里有什么 | 值钱在哪 |
|---|---|---|
| `<traceid>/$run` | `{seq, node, consumed[], produced[]}` | **因果边**。全量，不被 200 条窗口裁剪 |
| `<traceid>/$exec` | `{execution_id, node, termination, usage?, diagnostics{sandbox{path,retained}, observation{changes[]}}}` | 执行观测、沙箱路径、改了哪些文件 |
| `materialized` | 实例 pin 的**完整定义** | 端口 / 边 / 子槽 / bind / 预算 —— 画结构靠它 |
| `container_template` `root_config` | 定义与覆盖层 | 定义面 |
| `layout` `proposal` `annotation` | — | kind 占着位，**目前没有任何生产者**（前端就是第一个） |
| 用户 kind（`plan` / `spec` / …） | agent 的产出 | 汇聚 / 计数 / 择优全在版本历史里 |

### E. `permissions.json` / `resources.json`

`decide(actor, opclass, target) → {allowed, reason}` —— **reason 连拒绝理由一起给**，
所以禁用按钮的解释文案不用前端编。资源别名表同理。

### F. 文件系统本身（观察层独有，内核没有）

对象文件 `mtime` —— **唯一的墙钟来源**。可以用来说「3 分钟前」，
但**绝不能进图的坐标轴**（编排面没有时钟，L0）。
`head.lock` 在不在、持有者 pid —— 「现在有人在写」。

---

## 8. 拿不到的东西（诚实清单）

设计前端时不要指望这些，也不要用假数据糊过去。

| 拿不到 | 为什么 | 有没有近似 |
|---|---|---|
| 实例的**出生 / 终止序号** | `ContainerInstance` 只有 status，没记这两个数 | 有：取碰到这个 traceid 的最早 / 最晚消息。**窗口外会被截在左沿** |
| 编排面的墙钟 | L0：内核没有时钟 | 只有 F 的文件 mtime 与 `usage.wallClockSeconds` |
| 200 条之外的**老消息** | head 只留最近 200 条 CONSUMED | `$run` 全在 ⇒ **因果不丢，流量染色丢** |
| agent 在沙箱里干了什么 | 内核不中介它的工具调用（第五次归约） | `$exec` 的 diagnostics；沙箱外的 git 观察仍是 📋 |
| **没有 diagnostics 的那次执行** | `#recordExecution` 在 `diagnostics === undefined` 时提前 return | 无。执行记录还在 head 里，但版本层没有那一条 |
| 运行时的**内网形态** | 边目前只存在于模板里，动态边未做 | 无。所以第一版不做拖拽连边 |
| 隧道**将来**会连到谁 | `scope: "$self_subtree"` 要匹配的实例还没被创建 —— **原理上不可判定** | 只能靠命中累积（certainty） |
| 进度百分比 / 剩余时间 | 系统里没有这个量，也推不出来 | **无。不要造。** |

---

## 9. 改动预算

「独立」不是形容词，是这张表。

| 层 | 改什么 | 量 |
|---|---|---|
| **`packages/kernel`** | **不改** | **0** |
| `packages/contracts` | 无（`Cursor` 可放这儿，纯类型） | ~10 行 |
| `packages/state` | ① 新增 `watch.ts` ② `exportSnapshot` 加 actor + 补字段（§4.3 / FRONTEND §4）③ 只读打开加 `tolerateSkew` | ~250 行 |
| `packages/cli` | `status --watch` · `snapshot <dir> [--scope]` 两条命令 | ~60 行 |
| `packages/scene` | `snapshot.ts` 的 zod schema 跟着补 —— **边界上 parse，形状漂了要响** | ~40 行 |
| `packages/server` | 之后再做；本层不依赖它 | — |

---

## 10. 验收

1. **`hertaloy snapshot <dir> --json` 与 `hertaloy status --json` 逐项对得上。**
   同一份数据两个出口能对账 —— 这个项目被「两端各自都绿」咬过六次。
2. **`hertaloy status --watch` 能看见另一个终端里 `hertaloy send` 造成的变化。**
   这一条直接验证 §1：钩子认的是磁盘，不是进程。
3. **一次 `drain` 期间的几十次 head 写入，只产生个位数事件，且最后一个不丢。**
4. **只读观察进程持续轮询时，写者的 `send` / `truncate` 全部成功。**
   验证 O1（观察者不持锁）。
5. **越权主体拿到的快照里没有越权那部分，且 `denied` 非空。**
   验证 O4。这条要有测试，不能靠自觉。
6. **杀掉观察进程，run 照常跑完。**

前三条不需要写一行前端代码就能验。这是本层独立性的实证。

---

## 11. 明确不做

- **不挂 `CommitHook`**（观察不该有能力回滚内核事务）
- **不做增量事件协议**（事件只带游标）
- **不在观察面缓存图**（缓存 = 第二个真相源；缓存的只是「上次的游标」）
- **不给服务端自驱动开专用通知路径**（自驱和他驱走同一条路，差异只会在并发时暴露）
- **不做乐观更新**（写操作返回游标，等快照追上）
- **不让观察者持有目录锁**
- **不把 `RunState.open` 的一致性断言塞给观察者**（也不把观察者的宽容塞回写者）
