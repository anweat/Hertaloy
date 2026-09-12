# Hertaloy 一次读完设计文档（ONESHOT）

> 状态：**设计史（2026-09-04 对齐稿，已于 2026-09-12 降级）**。
> **单一概念基线是 [`MODEL.md`](./MODEL.md)，不是本文。**
>
> 本文仍然有效的部分：§4–§7（内核基底、执行面、包边界）事实正确，已收进 `MODEL.md`；
> §8 漂移表（尤其沙箱侧 A 类 12 条）仍在挂账，继续以本文为准。
> 本文**已被取代**的部分：§2 概念模型（节点/边那一套）、§6 不变量总表
> （有五条指向已不存在的代码）、§9 路线图（与 `MODEL.md` §12 冲突，以后者为准）。
>
> 以下是原文，保留不改：
>
> 与既有文档的关系：
> - `FOUNDATION_V5.md` → **降为设计史**。九次归约的完整论证在那里，本文只收结论。
> - `V5_WORKPLAN.md` / `DEVELOPING.md` / `OBSERVATION_V5.md` / `RENDERING.md` → 专项参考。
> - 凡本文与它们冲突，**以本文为准**；凡本文与代码冲突，**以代码为准并修订本文**。
>
> 防漂移纪律（沿用 §20 第三条，并作为本文的维护规则）：
> **每条声称成立的不变量，必须挂代码位置；每条声称的缺口，必须登记在 §8 漂移表。**
> 答不出代码位置的就是愿望，答不出登记处的就是漏账。

---

## 1. 一句话命题

> **把长任务切成多个短上下文的 agent 执行，用边编排它们、用版本化产物缝合它们，
> 从而避免单 agent 上下文膨胀与注意力涣散。**

推论（整个系统的存在理由，剧本帧 14）：**上下文预算从"运行时救火"变成"注册期拒绝"**。
一个 agent 能看到什么 = 它的端口与 `bind` 段声明的变量集合，注册期就是有限且已知的。

四个产品目标：

| # | 目标 | 状态（2026-09 实证） |
|---|---|---|
| G1 | AI 经 MCP 自动搭建工作流 | 🚧 注册期校验 + CLI + MCP 工具层已有；提案/审批流未做 |
| G2 | 自动进化（版本继承 + 标注检索 + 提案） | 📋 机制地基在（版本层/eager 继承），闭环未做 |
| G3 | 人有完整权限 | 🚧 强制截断 ✅；根 MCP 全权的授权表有了，审批链用 status+send 兜底 |
| G4 | 画布渲染 + 实时进度 | 🚧 scene 包有静态投影；`_layout` 独立版本与实时事件未做 |

---

## 2. 概念模型（词汇表）

全系统只有**一个一等公民**和**一套前缀机制**，其余全是派生。

### 2.1 唯一的一等公民：实例

```
实例  = 由某个模板创建、有生命周期、由 traceid 标识的运行对象
容器  = 实例的一个子类：它自己有内网（可含节点、边、其他容器）
```

容器 is-a 实例 ⇒ 嵌套是定义的直接推论，不是额外机制。
**根容器唯一**，不由任何模板创建（C1）——它是递归的终止条件，其 json 是启动配置
（`ObjectVersion(kind="root_config")`），编辑产生新版本、重启生效、不做热 reload。

### 2.2 traceid：一套前缀机制，复用九处

`job-1 / coder-2 / review-1` —— 实例路径，段边界前缀匹配（`job-1` 捞不到 `job-10`）。

| 复用处 | 包 |
|---|---|
| 实例身份与所有权 | kernel/instances |
| 别名绑定可见范围 | kernel/aliases |
| 观测投影子树查询 | kernel/runtime |
| 强制截断级联与反向清账 | kernel/runtime |
| 对象命名空间（行级安全） | kernel/store + instances |
| 权限 scope | kernel/control |
| 执行观测对象 `<traceid>/$exec` | kernel/runtime |
| 因果快照 `<traceid>/$run` | kernel/runtime |
| docker 内网名 | sandbox/network |

**要"按范围过滤"时先用它，不发明新索引。**
traceid 不表达因果：因果由 RunSnapshot 的 `consumed[] → produced[]` 承担，
消息信封因此不存 `causation_ids`（同一事实不存两份，存两份必然漂移）。

### 2.3 容器定义的八个部分

| # | 部分 | 落点 |
|---|---|---|
| 1 | 实例创建模板 | `children` 槽（含 `entry`/`exit` 端点声明） |
| 2 | 网关 | 别名绑定 / 请求回复（§4.2） |
| 3 | 容器工具 | `ctx.spawn(slot, segment, payload)` |
| 4 | 内网 | 静态边（纯转发，不物化） |
| 5 | 版本管理 | eager 物化继承（注册时物化，实例终身 pin，C4） |
| 6 | 权限管理 | 授权表数据（§4.5） |
| 7 | 生命周期 | 义务清空 → settle；强制截断六步（§4.4） |
| 8 | 观测投影 | 只读不裁决（scene 包 + 义务枚举） |

### 2.4 节点只有一类

`kind: "handler"` 单值判别式。带 `agent` 段 → 走执行面（沙箱命令行）；
不带 → 走内置受信 handler。**agent 不是节点种类，是节点的执行方式。**

- **端口 = 变量槽**，不是消息收发口。`direction=emit` 的端口集合 = `allowed_emit_ports`。
- **servo = 映射表不是程序**（S1/S2）：只在 receive 端口，纯提取，路径语言最小子集
  （`.name` / `[n]` / `[*]`，无 filter——filter 就是控制流）。
- **逻辑在受信 handler 里**（S2）：条件、分支、累加全是真代码；没有内核 DSL，没有节点内状态。
  循环靠内网回边；epoch 计数 = 对象版本号；汇聚 = `ctx.collect` 读版本历史。
  **消息降级成通知，内容在资产里** —— 于是"多消息原子消费"这面承重墙不需要建。

### 2.5 变量三种类型

| 类型 | 内容 | 计入预算 | 必须声明 `max_tokens` |
|---|---|---|---|
| `short` | string / number / bool | 否 | 否 |
| `long` | 大块文本 | 是 | 是 |
| `ref` | `object_id@version` | 解引用后按 long 计 | 是 |

**位置即绑定时机**（两个 schema 结构强制，无 `bind: compile|runtime` 字段）：
`bind` 段 = 编译期（card/literal，进稳定前缀）；端口 servo = 运行期（只有 `from` 路径）。

**B1**：注册期 Σ(long/ref 的 max_tokens) ≤ node.budget.tokens，超了拒绝注册；
运行期实际填充超上界 → 直接失败，不截断不降级不裁剪。

### 2.6 对象命名空间 = 文件系统

`ctx.put("results", …)` 实际写 `<本实例 traceid>/results`——**写不出自己的命名空间**，
`..`/前导 `/`/空段一律拒绝。这是对象存储上的行级安全，也是跨实例汇聚的抓手
（`ctx.collect(prefix, name)`）。内核保留 kind（`run`/`annotation`/`container_template`…）
受信 handler 与 backend 都不得伪造。

---

## 3. 设计基因：九次归约

每次都是把 N 套并存机制**证明成一套**。判据只有一条：**少一套并存机制。**

| # | 归约 | 消掉了什么 |
|---|---|---|
| 1 | 容器 is-a 实例 | slot / subscription / children / pool_cursor / overflow → 一棵实例树 |
| 2 | 资产即变量 | 卡片系统 + 四段上下文编译器 + 运行时预算裁剪 → 一套变量 |
| 3 | 等待即锁 | 五种等待 → 一张锁表（后被 #8 再归约掉） |
| 4 | 版本历史即状态 | 策略节点 / 表达式语言 / 节点内 persistent / 多消息原子消费 / 内核时钟 |
| 5 | agent 就是一条命令行 | 内核工具桥 / `kernel_tool` 线协议 / backend 矩阵 → 端口 + 变量 + 沙箱外 git |
| 8 | 锁账本即派生 | `LockLedger` 四处记账 → 一条「未了结的义务」枚举 |
| 9 | 隧道即别名 | 隧道标签 / 全树扫描 / 订阅 scope → 绑定表 + 沿 traceid 向上解析 |

新增机制的验收追问（任何提案先过这三句）：

1. 删掉它，剧本的哪一帧无法正确表达？
2. 它是在减少还是在增加并存的机制数量？
3. 文档写了"不变量 X"，它的强制方式在哪个代码位置、哪条测试？

---

## 4. 内核基底（要封装保留的部分）

这是用户点名的"内核基底"：网关、资源、地址索引、日志、状态控制。
**结论先行：这五样的设计位置全部正确，缺的是显式的 API 边界声明。**

### 4.1 传递：内网边 / 网关 / 别名

- **M1** 编排权威属于内网边——handler 返回值里没有目标字段（结构性）。
- **M2** 别名沿 traceid 向上解析——可见性由绑定的**放置位置**决定
  （`bindings` 子树可见 / `selfBindings` 仅自己 / `children[k].bindings` 仅该子槽），
  不靠字段。"只收本子树发的"是查找方向的推论，不是一条要检查的规则。
- **M3** callback 落回已声明端点（注册期校验）。
- **A1** 绑定在 spawn 时 eager 物化进实例，解析只读本地——实例自给自足，是租户跨进程的前提。
- **A2** 用到的别名必须绑上，根上一个不欠——注册期递归判定拒绝。
- **A3** 跨租户走不透明地址，只投一条消息到一个地址，不枚举对面——
  "恰好 1 个目标"因此是构造性成立。

emit 端口四种模式互斥：内网边（默认）/ 网关广播（`alias`，0..N）/
网关请求（`alias`+`callback`，恰好 1，记 request 义务）/ 网关回复（`reply: true`）。

### 4.2 锁与终止：义务派生

**L0 内核无时钟。L1 义务全部派生，没有记账点。L2 owner 唯一是容器。**

四种义务，事实来源全本来就有，`LockView` 每次现算、只读：

| 义务 | 权威来源 |
|---|---|
| `message` | `Message.state ∈ {QUEUED, CLAIMED}` |
| `execution` | `ExecutionRecord.status === "RUNNING"` |
| `request` | 待回复请求表（`#pending`） |
| `child` | `instance.status === "OPEN"` |

**L5**：可终止 ⟺ 名下义务为空。`terminationBlockers` 是义务枚举的投影。
**义务不承担正确性**——强制截断永远可用（§9.1），义务算错只导致"该自动回收的没回收"，
安全方向的失败。这是"等待策略可以外置"成立的前提。

**强制截断六步**（外层事务，级联子树）：
0 推进 generation（气密性唯一依据，L3）→ 1 best-effort cancel → 2 未消费消息丢弃留计数 →
3 自己发的请求销账 → 4 自己承接的请求**代服务方发了结通知**（请求必得一个了结）→
5 子实例级联 → 6 写终态。**L4：终态 ≠ 回收**，永远不为正确性删，只为存储删。

### 4.3 事务、并发与三段式

- **提交是一次事务**：消息状态、实例状态、pending 表、下游消息、产物版本、RunSnapshot
  一起原子落。能实现是因为可变容器里全是冻结对象，浅拷贝即快照。
- **三段式**：claim（同步临界区，当场落盘）→ execute（await 锁外）→ apply（同步临界区）。
  "锁外执行"由 JS 单线程结构保证。
- **冲突域 = generation + claim 集**（两半都查，§21.1 修过）：迟到的 apply 作废，不复活。
- **调度缝是唯一策略注入点**（`scheduling.ts`）：内核先筛候选、调度器只排序、
  挑完按引用复核——写坏的调度器造不出"跑一条不该跑的消息"。默认 FIFO（唯一天然无饥饿）。
- 状态不变量断言集中在 `invariants.ts` 纯函数，测试每次提交后跑。

### 4.4 地址索引与版本层

- `ObjectStore`：内容寻址、append-only、版本分配唯一权威（V1–V4）。
  定义层全部并入 store，没有平行注册表。**资产不需要锁**：append-only 结构上不可能丢失更新。
- 读法：`read(ref)` 精确版本 / `history(name)` 本命名空间 / `collect(prefix, name)` 跨实例汇聚。
- 已知边界（写进指南）：**聚合判定只能在同步 handler 里做**，agent 的 execute 期间读
  history 是快照，apply 时可能已变——节点级 fence 不管"两个不同节点写同一对象"。

### 4.5 权限与日志

- 操作分 DDL / DML / DQL；授权 = (principal, scope, 操作类)，**默认拒绝**；
  scope 复用段边界前缀（定义路径前缀 = 对象级 GRANT；traceid 前缀 = 行级安全）。
- **检查放在 ControlPlane，不穿进内核签名**：Principal 必须由可信边界注入，
  Runtime 保持纯引擎——它不知道谁在调它，也就不可能被骗。
- 三类日志分层（都不进编排状态）：
  | 日志 | 落点 | 性质 |
  |---|---|---|
  | 授权决策日志 | `authz.log` 追加写文件（state 层持有） | 证据，放行拒绝都记 |
  | 因果快照 | `<traceid>/$run` 版本对象 | RunSnapshot，seq 只由提交推进 |
  | 执行观测 | `<traceid>/$exec` 版本对象 | diagnostics（含沙箱位置、git 观察、journal） |

### 4.6 状态控制与持久化（state 包）

- 状态只有两个形态：**不可变对象库**（内容寻址，重放幂等）+ **可变头**（全量原子写，
  临时文件 + rename，不做 WAL）。
- 目录锁单写者；`persist()` 显式调用——"重放会不会产生第二次副作用"的判断在驱动方。
- **claim 必须当场落盘**（§17.4）：崩在 claim 与 apply 之间，恢复后要知道外面有个 agent 在跑。
- 崩溃恢复 = **孤儿认领**（`reconcile`）：拿到锁时看到的 RUNNING 必然是孤儿，
  复用既有的失败路径计数重试，不新增状态机。已知欠账：执行租约未做（§21.2/§21.4）。
- GC 三处需要两处不需要：已消费消息保留 N 条（头平方增长已修）/ 沙箱 `reclaim` 按版本序 /
  产物字节上界；对象版本不按新旧回收、一个目录一个根所以整目录 `rm` 即可。
- **密钥绝不进对象库**（§17.7）：只经 env 注入，注册期递归扫所有字符串拒绝凭据字面量。

---

## 5. 执行面：沙箱 + 命令行

**agent 就是一条命令行。** `claude` / `codex` / `hertaloy agent` 三者平权，
内核不认识它们各自的工具。做法是**注入 + 自由 + 记录**。

### 5.1 唯一契约：ExecutionBackend 窄接口

```ts
interface ExecutionBackend {
  run(request: ExecutionRequest): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;  // best effort，气密靠 generation fence
}
```

`agentSpec: JsonObject` 不透明穿过内核；backend 是**不可信边界**，返回值运行期三查：
形状校验、executionId 防串号、禁伪造内核保留 kind；产物地址由内核命名空间强制，不是
agent 报什么写什么。五种终止按"重试会不会有不同结果"分类：
DONE（应用）/ CANCELLED、BUDGET（意图，不重试）/ INVALID_OUTPUT、FAILED（重试）。

### 5.2 沙箱目录契约

```
<root>/
  box/                  ← 唯一交给 agent 的一层（runner 只挂这个）
    workspace/          ← git work-tree，唯一被观察
    .hertaloy/
      context/          ← 注入（按 profile 渲染）
      request.json      ← 端口白名单、预算、traceid、环境实情
      journal/          ← 工具调用日志（emit/progress，序号文件名）
      bin/hertaloy.mjs  ← 沙箱内工具本体（自包含 node 脚本）
      emit.json         → agent 写这里表达输出（老路径，保留）
      artifacts/        → 这里的文件被收成版本化资产
  record.git/           ← 观察记录仓，不挂，agent 够不着
```

**挂载边界与观察边界分开**（只在 docker 上完全成立；local/wsl 的 `isolates` 如实报告）。

### 5.3 Runner：同一形状，三种强度

| | local | wsl | docker |
|---|---|---|---|
| 文件系统隔离 | ❌ 目录限定 | ✅ | ✅ |
| 强制出网 | ❌ | ❌ 与宿主机同网 | ✅ `--network` |
| 用途 | 本机开发/离线测试 | Windows 上拿真 Linux 语义 | 真安全边界 |

- `isolates` / `enforcesNetwork` 两个**必填**字段——两堵墙分开认，不许合成"安全吗"。
- 出网三档：`none` / `internal`（同 run 内网互通，`--internal` 网络级强制）/ `open`。
  **明确不做按域名放行**（假装支持不强制的东西比没有更危险）。
- 运行器只报事实（退出码/超时/被杀），语义分类（五态）归 backend。
- 杀的是进程树/容器，不是客户端（taskkill /T、docker kill、pkill）。

### 5.4 profile：适配 = 渲染，不是特例代码

`claude-code` 认 `workspace/CLAUDE.md` + `.claude/skills/`；`codex` 认 `workspace/AGENTS.md`；
`hertaloy-agent` 原生懂 `.hertaloy/context/`。**资源别名当宏**：同一个 `skill:review`，
放哪由 profile 的 `place()` 决定，模板只写名字。让外部 agent 学会输出契约靠注入本身
（"把结果写到 emit.json，端口只能是这些"），不改 agent。

### 5.5 观察：沙箱外的 git

`git --git-dir=<record.git> --work-tree=<workspace>`。物化与渲染**先于**基线，
于是 diff 里只剩 agent 干的事。快照用 `commit-tree` + `update-ref` 落
`refs/hertaloy/snapshots/<executionId>` 隐藏命名空间——挡误入不挡审计，
不污染分支列表、不被默认 clone 带走。git 经 `runner.exec` 与 agent 同环境跑
（WSL 沙箱由 WSL 里的 git 观察，换行/权限位/大小写才对得上）。

### 5.6 资源别名与工作区继承

- 模板只写**名字**（`workspace: { source: "primary" }`），真实位置由 backend 配置的
  注册表给——与密钥同构：模板放取值方式不放值。没配置的名字在注册期/物化期就拒绝。
- 物化选「预先复制」不选「只读挂载」：沙箱一次性，多一个挂载面多一个攻击面。
- `workspace.from` 接过**本容器内**上游节点的工作区（拷贝不是共享）——子流程的关键；
  命名空间限定是天然的（键含自己的 traceid）。

### 5.7 脱敏

进不可变对象库之前的最后一道：精确遮蔽全部已注入 env 值（≥8 字符）+ 常见密钥模式
（尽力而为）。真正的保证来自"密钥只经 env 注入、不落任何配置文件"。

---

## 6. 不变量总表（实证版）

强制状态以**代码为准**（2026-09-04 通读核实），不再照抄文档标记。

| 编号 | 内容 | 实证 | 位置 |
|---|---|---|---|
| 首要 | Agent 只能选不能构造 | ✅（端口/子槽/别名/产物命名空间）🚧（agent 侧内核工具只有 emit/progress，无 read_artifact） | runtime.ts / routing.ts / toolkit.ts |
| C1 | 根唯一，不由模板创建 | ✅ | kernel/instances.ts |
| C2 | traceid 段边界前缀 | ✅ | contracts/identity.ts |
| C3 | 内网实例不自行判定终止 | ✅ 结构（无该 API） | — |
| C4 | 实例终身 pin；注册时 eager 物化 | ✅ 含反例测试 | kernel/instances.ts |
| C5 | 版本历史即状态 | ✅ 结构 | kernel/store.ts |
| L0 | 内核无时钟 | ✅（时间在 runner，Date.now 只在 sandbox） | kernel/* |
| L1/L2 | 义务全部派生；owner 唯一是容器 | ✅ 结构（LockView 只读） | kernel/obligations.ts, locks.ts |
| L3 | generation fence；请求两侧各自了结 | ✅ 含反例测试（§21.1 修过两半都查） | kernel/runtime.ts:682 |
| L4 | 终态 ≠ 回收 | ✅ 结构 | — |
| L5 | 可终止 ⟺ 义务为空 | ✅ | kernel/runtime.ts:922 |
| M1 | 编排权威属于边 | ✅ 结构 | — |
| M2 | 别名向上解析 | ✅ | kernel/aliases/ |
| M3 | callback 落已声明端点 | ✅ 注册期 | kernel/routing.ts |
| A1/A2/A3 | 绑定物化 / 注册期可判 / 跨租户不枚举 | ✅ | kernel/aliases/, instances.ts |
| S1/S2 | servo 纯提取无控制流 | ✅ 结构 | contracts/port.ts, kernel/extract.ts |
| X | 稳定前缀不漂移 | ✅ 结构（两个 schema） | contracts/template.ts |
| B1 | 预算注册期校验、运行期直接失败 | ✅ 变量侧（含 ref 解引用后量上界）；⚠️ **agent token 消耗无测量**（见 D-4） | kernel/context.ts, sandbox/backend.ts |
| V1–V4 | 版本分配/独立/幂等/精确引用 | ✅ | kernel/store.ts |
| — | 提交是事务 | ✅ | kernel/tx.ts |
| — | 冲突域 = generation + claim 集 | ✅ | kernel/runtime.ts:682-710 |
| — | 观测不裁决 | ✅ 结构 | — |
| — | 对象写入受命名空间约束 | ✅ 含 `..` 反例 | kernel/instances.ts:namespacedId |
| — | 授权默认拒绝 | ✅ | kernel/control.ts |
| — | 半状态不可表达 | ✅ 结构 | — |
| — | 请求必得一个了结 | ✅ | kernel/runtime.ts:1091 |
| — | backend 不可信边界三查 | ✅ | contracts/execution.ts:142 |
| — | 密钥不进对象库 | ✅ 注册期递归扫描 | contracts/template.ts |

---

## 7. 包边界

```
contracts   纯结构层：schema/类型/校验。零运行时依赖（除 zod）。画布与 LLM 共用。
kernel      编排引擎：Runtime / ControlPlane / InstanceRegistry / ObjectStore。
            对执行面零知识（grep argv|workspace|profile = 0 命中）。
state       持久化组合：RunState = 对象库 + 可变头 + 目录锁 + 权限表 + 资源表 + 授权日志。
sandbox     执行面：ExecutionBackend 实现。AgentSpec 住这里（执行面语义归执行面）。
cli         控制面命令 + hertaloy agent（同一二进制两种角色，平权的自证）。
mcp         控制面开放层：每个工具过 ControlPlane，actor 由服务端注入。
scene       观测投影（画布数据源，只读）。
```

依赖方向严格向下：contracts ← kernel ← state ← {cli, mcp}；sandbox 只依赖 contracts；
cli 把 sandbox 的 `checkAgentSpec` 接进 kernel 的 `validateExecutionSpec` 校验缝——
**state 不依赖 sandbox**，这条方向不能反。

---

## 8. 漂移登记表（状态不对等的全部账目）

分三类：**A 类 = 改代码**（声明了没走通）；**B 类 = 改文档**（代码对了文档旧了）；
**C 类 = 欠账**（设计上就还没做，如实挂着）。每条处置后从表中划掉。

### A 类：声明 ↔ 事实漂移（改代码，先于 API 冻结）

| # | 漂移 | 位置 | 修法 |
|---|---|---|---|
| A-1 | `capabilities.retain` 不生效且两处判定矛盾：diagnostics 用 `caps?.retain ?? #retain`，finally 里真正删除只用 `#retain`。声明 "always" 会被删 → 下游 `workspace.from` 当场炸，而 `$exec` 还指着已删路径 | sandbox/backend.ts:388 vs :425 | finally 改为同一条 `caps?.retain ?? this.#retain` |
| A-2 | docker `internal` 网络双线断裂：(a) 设计说内网名按根 traceid，实现 CLI 从不传 `networkName`，全部 run 共享 `hertaloy-default`，跨 run 隔离不成立；(b) 节点 `capabilities.network:"internal"` 覆盖而 runner 缺省 "none" 时从不 `ensureInternalNetwork`，docker run 直接失败 | cli/main.ts:251, sandbox/docker.ts:97,107 | backend 按根 traceid 传名；run() 遇 internal 时 ensure |
| A-3 | WSL 超时/取消 `pkill -9 -f <argv>` 全发行版模式匹配：并行同命令沙箱互相误杀；argv 未正则转义 | sandbox/wsl.ts:128 | 记录子进程 PGID 按组杀，或写 PID 文件 |
| A-4 | usage 恒零：`inTokens/outTokens/costUsd/toolCalls` 硬编码 0。token 预算对 agent 路径无测量，B1 的运行期一半对 agent 真空；成本失控在观测上隐形 | sandbox/backend.ts:412 | 至少自家 agent 从 OpenAI 响应捞 usage；外部 CLI 解析其输出或如实标"不可得" |
| A-5 | 无默认墙钟上限 + cancel best effort：编排进程崩溃后容器照跑，未声明 wallClock 的执行永久烧钱 | sandbox/backend.ts:348 | backend 构造参数给默认上限；节点声明可覆盖 |
| A-6 | 配置错误落可重试档：别名配错/agentSpec 非法是确定错，却只能落 FAILED/INVALID_OUTPUT（都按 maxAttempts 重试）。§14.6 第三类"不重试·确定错"在枚举里没落点 | sandbox/backend.ts:240 | Termination 加 `CONFIG`（NON_RETRYABLE），或注册期更严 |
| A-7 | 产物名去扩展名边角：`.gitignore`→空名整次 INVALID_OUTPUT；`a.txt`/`a.md` 撞名静默合并版本 | sandbox/backend.ts:371 | 空名当场拒并说明；保留扩展名或撞名报警 |
| A-8 | `safeId` 把非 `[A-Za-z0-9_.-]` 全压成 `-`：`a/b` 与 `a-b` 撞名，确定性路径互相顶掉 | sandbox/runner.ts:113 | 编码改成可逆转义（如 `_x2F_`） |
| A-9 | 同步 `execFileSync`（git 基线/diff/docker CLI）阻塞单进程事件循环：大仓基线冻结全部在途 agent 的超时定时器 | sandbox/runner.ts:236, docker.ts:254, observe.ts | 改 execFile async，或文档明示单进程边界 |
| A-10 | Windows 上 local runner 起不了外部 CLI：`spawn(cmd,{shell:false})` 不能执行 `.cmd` shim（Node ≥20.12 限制），claude/codex 在 Windows 正是 .cmd | sandbox/runner.ts:249 | Windows 下 local 对 `.cmd` 走 `cmd /c` 或 doctor 明示用 wsl |
| A-11 | emit.json 与 journal 混用时 emit.json 整体被忽略，丢端口不报警 | sandbox/backend.ts:369 | 两源并集 + 冲突报警，或文档明示互斥 |
| A-12 | `vars.json` 被 writeContext 与 profile render 写两遍（后者覆盖前者） | sandbox/backend.ts:267, profile.ts | 收归 profile 一处产出 |

### B 类：文档 ↔ 代码漂移（改文档，以代码为准）

| # | 漂移 | 位置 |
|---|---|---|
| B-1 | §14.1–14.4 标 📋（未实现），实际 sandbox 包已全部完成并有测试 | FOUNDATION_V5.md §14 |
| B-2 | §12「观察」标 📋，`observe.ts` 已实现 | FOUNDATION_V5.md §12 |
| B-3 | §17.16 reclaim 标"需要"，`state-commands.ts:520` 已实现 | FOUNDATION_V5.md §17.16 |
| B-4 | 剧本帧 9 标"agent 侧待沙箱"，沙箱已落地 | FOUNDATION_V5.md §2 |
| B-5 | §16 表"首要不变量：内核工具未做"，toolkit 已有 emit/progress（仍缺 read_artifact 类，如实改标 🚧） | FOUNDATION_V5.md §16 |
| B-6 | §14.5 docker 行标 ✅，但 internal 网络实际断裂（A-2）——✅ 标记本身失真 | FOUNDATION_V5.md §14.5 |
| B-7 | `hertaloy agent` 默认 docker 镜像 `alpine/git` 无 node：toolkit 与自家 agent 在默认镜像下全死，文档未声明镜像要求 | sandbox/docker.ts:54 |

### C 类：欠账（设计已认，未做）

| # | 项 | 出处 | 建议归宿 |
|---|---|---|---|
| C-1 | 执行租约（孤儿判定窗口只是关小未关闭；跨进程驱动与工作区继承的内存记账矛盾） | §21.2/§21.4 | 阶段 2（见 §9） |
| C-2 | 帧 14 有测量无强制 | §21.6 | 等真实膨胀案例 |
| C-3 | `run`/`settleAll` 的 scope 只授权不限范围 | §21.4 | 阶段 1 |
| C-4 | `#pickWork` 队头阻塞（busy 节点不跳过） | §21.4 | 阶段 2 |
| C-5 | `runtime.ts` 1497 行超 800 约定 | §21.4 | 阶段 1（封装时拆） |
| C-6 | 真 kill -9 的耐久验证 | §18 | 阶段 2 验收 |
| C-7 | executionId 每 Runtime 从 exec-1 起（非全局唯一，靠 traceid 拼接补救） | sandbox/runner.ts:126 注释 | 阶段 2 改 ULID/UUID |
| C-8 | ExecutionLimits.wallClockSeconds 与 capabilities.wallClockSeconds 双旋钮语义重叠 | contracts/execution.ts, sandbox/agent-spec.ts | 阶段 2 归并 |
| C-9 | 单镜像 backend：一个 run 内异构节点环境无法共存；AgentSpec 无 image 字段 | sandbox/docker.ts:95 | 外展期按需 |
| C-10 | agent 侧内核工具只有 emit/progress（read_artifact 等未做） | sandbox/toolkit.ts | 外展期 |

---

## 9. 路线：对齐 → 封装内核 → 收编执行面 → 外展

**不推倒重建。** 架构决策（九次归约的成果）全部经受住测试与两轮外部审核；
漂移是局部断裂，每条几行到几十行。重建丢掉的是"为什么"——那正是本文要收住的。

### 阶段 0：对齐（1 个冲刺）

1. 本文落库，宣布为单一概念基线；FOUNDATION_V5.md 头部加"设计史"标记。
2. §8 漂移表逐条处置：A 类改代码（A-1/A-2/A-3/A-6/A-7/A-8 均为一行到几十行），
   B 类改文档，C 类确认挂着。
3. 每条 A 类修复配一条反例测试——这个项目的历史证明：没有测试钉住的修复会再断。

**出口标准**：漂移表 A/B 类清零；`pnpm test && pnpm typecheck && pnpm reachability` 全绿。

### 阶段 1：内核封装（冻结 API surface）

内核基底的设计位置已经全部正确（§4），封装 = 把事实上的边界变成声明的边界：

1. **收窄导出**。kernel 包的公共面只有：
   - `Runtime`（纯引擎：step/drain/claimAgent/applyAgentResult/failAgentResult/truncate/settle/reconcile）
   - `ControlPlane`（唯一带授权的门，DDL/DML/DQL）
   - `InstanceRegistry` / `ObjectStore` / `RunState`（state 层组合）
   - 三条缝：`Scheduler`、`ExecutionSpecValidator`、`AuthzLog`
   - 内部组件（queue/executions/obligations/facts/aliases/routing/context/extract）
     不再导出——它们是组件不是缝（scheduling.ts 开头的判据）。
2. **拆 `runtime.ts`**（C-5）：三段式、截断、观测记录各成文件，导出面不变。
3. **API 语义冻结**：此后改内核公开签名需要走"新增 → 双轨 → 删旧"三步，
   与 §5.1"不做热更新"同一哲学。
4. C-3（run/settleAll scope 限范围）在此完成——它是 ControlPlane 的语义，冻结前最后一改。

**出口标准**：kernel 的 `index.ts` 导出清单 = 上表；外部包不 import 任何内部组件路径；
不变量-测试对照（§6 的位置列）在 CI 可查。

### 阶段 2：执行面收编

1. A-4/A-5（usage 测量与默认墙钟）——成本安全是外展（服务端、多租户）的前置条件。
2. C-1 执行租约：executionId 全局唯一（C-7）+ 租约标识，关掉孤儿判定窗口；
   顺带解决工作区继承的内存记账与跨进程驱动的矛盾（租约表落盘即答案）。
3. C-4 队头阻塞、C-6 kill -9 验证、C-8 旋钮归并。
4. runner 能力矩阵进 `doctor`（含 A-10 的 Windows/.cmd 检查）。

**出口标准**：一次真实 kill -9 后恢复不重派、不漏杀；usage 非零进 `$exec`；
两个并行同命令 WSL 沙箱互不误杀（A-3 反例测试）。

### 阶段 3：外展（按依赖序）

| 序 | 项 | 依赖 |
|---|---|---|
| 1 | MCP 工具层补全（八部分全开放，G1 闭环：propose→validate→approve） | 阶段 1 |
| 2 | 服务端常驻 + 实时事件（审批、进度推送） | 阶段 1 + 2（租约） |
| 3 | 画布：`_layout` 独立版本、内网形态投影、义务/进度渲染（G4） | 阶段 1 |
| 4 | G2 进化闭环：标注检索 → propose 改进版 | 1 |
| 5 | C-9（per-node 镜像）、C-10（agent 侧内核工具）、`workspace/` mount（§7.7 最后一行） | 按需 |

外展纪律不变：**新增机制先过 §3 的三句追问**；任何"声明了"的能力必须当天走通
（A 类漂移全部是"声明先于走通"造成的）。

---

## 10. 风险与边界（写进使用文档最显眼处）

1. **`local` runner 不是安全边界**——只做了目录限定，agent 能读整个宿主机、任意出网。
   真隔离只有 docker（出网强制）与 wsl（文件系统）。
2. **聚合判定只能在同步 handler 里做**——agent 的 execute 期间读版本历史是快照（§4.4）。
3. **单进程单写者模型**：一个状态目录一把锁；并行驱动器能力已有（`#busy` + OCC），
   但跨进程驱动的租约未做（C-1）——在那之前，多进程写同一 run 是未定义行为。
4. **沙箱 retain 默认 always + 回收靠手工 `reclaim`**：磁盘会一直涨，`status` 报保留数。
5. **默认 docker 镜像不含 node**：toolkit 与 `hertaloy agent` 需要自带 node 的镜像（B-7）。
6. **密钥纪律**：只经 env 注入；短于 8 字符的注入值不参与精确遮蔽——别用短密钥。

---

## 附：主线剧本覆盖状态（实证）

| 帧 | 内容 | 状态 |
|---|---|---|
| 0 根容器提需求 | 根唯一 ✅ / MCP 出口 ✅（批 K） | ✅ |
| 1 AI propose + 注册期校验 | 校验 ✅ / 提案流程 📋 | 🚧 |
| 2 画布改坐标不产生新版本 | `_layout` 独立版本 📋 | 📋 |
| 3 批准 → 实例化 | 实例化 ✅ / 审批用 status+send 兜底 | 🚧 |
| 4–5 bind 编译 + 实例 pin | | ✅ |
| 6–7 审批 REQUEST/REPLY | 义务 + 了结 ✅ | ✅ |
| 8 容器工具扇出建子容器 | `ctx.spawn` + entry ✅ | ✅ |
| 9 别名 REQUEST 到服务 | handler ✅ / agent 侧 emit 即 REQUEST ✅ | ✅ |
| 10–11 资产即变量 / 别名向上解析 | | ✅ |
| 12 三路汇聚 `collect` | 跨实例已钉住 | ✅ |
| 13 回边返工，epoch=版本号 | | ✅ |
| 14 epoch 2 只含失败切片 | 有测量无强制（C-2） | 🚧 |
| 15 强制截断级联 + 反向清账 | | ✅ |
| 16 标注检索 → propose | | 📋 |
