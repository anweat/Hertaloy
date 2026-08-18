# V5 测试与实现工作计划

> 状态：准备阶段。当前唯一概念基线是 `FOUNDATION_V5.md`；归档代码只作证据，不作依赖。

## 1. 开工前设计门 —— **已关闭（2026-08-17）**

八项均已在 `FOUNDATION_V5.md` 收束。结论与落点：

| # | 门 | 结论 | 落点 |
|---|---|---|---|
| 1 | 锁的持有者边界 | **owner 唯一是容器**；节点实例不持锁；`origin_node` 仅供展示，不参与调度门控（等回复的节点本来就无 QUEUED 输入，天然不可调度）| §4.1 表、§9.3、L2 |
| 2 | 实例版本 pin | **终身 pin**，不做 idle 热迁移；要新版就创建新实例 | §5.5、C4 |
| 3 | traceid 与因果链 | **分离**。traceid = 所有权；因果由 **RunSnapshot** 承担（提交记录的输入集→输出集就是因果边）；消息只带 `in_reply_to`，**不存 `causation_ids`**（冗余）| §3.3、§14、C2 |
| 4 | 强制截断气密性 | 加**第 0 步：推进 generation**；`cancel` 降为 best effort；迟到 apply 因 generation 不匹配必然失败。不是新机制——V4 已有的 base version 检查抬到实例级 | §9.6、L3 |
| 5 | 注册期预算可判定性 | `long` / `ref` 声明**必须带 `max_tokens`**；注册期求和校验；**运行期超上界直接失败，不截断不降级**（V4 的优先级裁剪整个不要）| §7.2、§7.5、B1 |
| 6 | 自然终止在途状态 | 压成**三个谓词**：无非终态消息 ∧ 无活跃 execution ∧ 锁表空。不枚举状态名（实现细节不进不变量）| §9.4、L5 |
| 7 | 根容器版本权威 | 根配置也是 `ObjectVersion(kind=”root_config”)`，启动 pin 一个版本；编辑产生新版本，**重启生效，不做热 reload** | §3.2 |
| 8 | JSON 判别类型 | **`kind ∈ {handler, strategy}` 冻结**；agent 不是第三个 kind，由 `agent` 段的**存在性**判别，不引入 `runtime` 枚举 | §6.1、§6.5 |

同时收束了原 §16 的五个表达层开放项（路径语言用最小自定义子集 / 策略语句用 JSON 表达式树 / 不加 `stream` 类型 / `max_blocked_duration` 默认无超时 / 提前遍历深度固定 1），见 `FOUNDATION_V5.md` §16。

**复杂度基线**：本轮对每条结论都做了”是否过度设计”复查，砍掉了 6 处自加机制（锁 scope 的调度作用、`causation_ids`、状态全集枚举、reload 协议、per-kind 超时默认表、遍历深度可配）。实现阶段沿用同一把尺子：**新增机制必须先证明不能压进已有的某一层**。

### 语言与工具

- **实现语言：TypeScript**（Node ≥ 20、strict、ESM）。理由：本计划已放弃 parity，Python 的行为记忆优势不成立；执行面继承物（pi / openai-compat driver / tool executors）本就是 TS；zod 契约可前后端共享。
- **codex-cli 用于批量机械填充**，不用于需要判断的部分。分工见 §5。

## 2. 测试集分层

### Task 1：纯契约与身份模型

**目标：** 固定 ObjectVersion、定义版本、实例路径、端口、变量和消息信封的最小 JSON/TypeScript 契约。

**验收标准：**

- 每个 schema 同时有有效样例与拒绝样例；
- 精确版本引用、traceid 前缀边界和 Principal 注入有独立测试；
- 测试不 import `archive/`。

**验证：** 新测试命令可在没有数据库、网络和真实模型时运行。

### Task 2：根容器与实例树最小切片

**目标：** 从唯一根容器创建一个子容器和一个 handler 实例，并能按 traceid 查询子树。

**验收标准：**

- 根唯一且不可由模板重复创建；
- 实例 pin 精确的定义版本；
- 前缀查询不会把 `job-1` 与 `job-10` 混淆。

**依赖：** Task 1。

### Task 3：纯转发内网链路

**目标：** 完成 `handler emit → forward edge → handler receive` 的单提交路径，servo 只做声明式提取。

**验收标准：**

- 消息不能自选路由；
- servo 不能改 envelope、构造端口或执行控制流；
- contract 或变量提取失败时零部分提交。

**依赖：** Task 1–2。

### Checkpoint A —— **已通过（2026-08-17）**

```
packages/contracts   51 条    json · identity · path · object · variable · port · message · contract · template
packages/kernel      33 条    errors · store · instances · extract · runtime
合计                 84 条    typecheck 绿，离线，1.5s
```

- ✅ 全部测试离线、确定性通过（无 DB、无网络、无真实模型、不 import `archive/`）
- ✅ 无数据库 / MCP / 画布依赖。**有**一个单提交循环（`Runtime.step/drain`），这是 Task 3 要求的"单提交路径"；claim/execute/apply 三段式、并发、锁、持久化均未引入

#### 不变量覆盖对照

| 不变量 | 状态 | 证据 |
|---|---|---|
| **首要**（只能选不能构造） | 🟡 部分 | emit 端口白名单、children 槽白名单已钉；工具与锁待 Task 4+ |
| **C1** 根唯一，不由模板创建 | ✅ | `instances.test` 根容器唯一 ×2 |
| **C2** traceid 前缀匹配 | 🟡 部分 | 前缀语义已钉（`job-1` ≠ `job-10`，两处）；因果由 RunSnapshot 承担的那半未做 |
| **C3** 内网实例不自行终止 | ❌ | 终止属 Task 4+ |
| **C4** 实例终身 pin | ✅ | `instances.test` 终身 pin ×2（模板演进后在途实例不漂移） |
| **L1–L5** 锁与终止 | ❌ | Task 4 |
| **M1** 编排权威属于内网边 | ✅ | `runtime.test` ×2 + `message.test` 信封无路由字段 |
| **M2** 隧道 ∩ traceid 前缀 | 🟡 契约层 | `SubscriptionAddress` schema 已定；运行期投递 Task 4 |
| **M3** callback 落已声明端点 | ❌ | Task 4 |
| **S1** servo 纯提取，变量集编译期已知 | ✅ | `path.test` + `extract.test` + `port.test` |
| **S2** 控制流只在策略节点 | 🟡 部分 | 路径文法拒绝 filter/切片/递归下降已钉；策略节点本身未实现 |
| **X** 稳定前缀不漂移 | ✅ 结构 | bind 段与端口 servo 是两个 schema，"编译期变量从 payload 取"类型层不成立 |
| **B1** 预算注册期校验 | 🟡 契约层 | `max_tokens` 强制 + `declaredBudget` 已钉；模板级求和阈值待接 |
| **V1–V4** 版本 | ✅ | `store.test` ×7（单调、幂等、精确引用、旧版可解析、lineage）|
| 冲突域 = 实例 + 消息集合 | ❌ | Task 5 |
| 观测不裁决 | ❌ | 后续 |
| JSON 判别式 `kind ∈ {handler,strategy}` | ✅ | `template.ts` + "必须恰好一个执行体" |

#### 本阶段的三处有意留白（均已在代码注释写明理由）

1. **纯转发边不物化为实例对象** —— 它此刻没有任何状态、永不持锁、随容器生死（C3），物化一个空对象是纯开销。等运行时动态边出现（容器工具编辑内网）再物化，那时它才有生命周期。
2. **`MessageContract` 只有 5 个关键字**（type/properties/required/additionalProperties/items）—— 超出这 5 个目前无场景，有场景再加。
3. **策略节点只有 schema 分支，无语句表** —— 判别式按设计门 8 冻结即可，语句表等 Task 需要时再落。

#### 实现中对 `FOUNDATION_V5.md` 的两处回写

- §7.3：删掉原定的 `bind: compile|runtime` 字段 → **位置即绑定时机**，用两个 schema 结构强制
- §6.2：明确 **servo 只在 receive 端口**，由 `direction` 判别式联合强制

### Task 4：网关 REQUEST/REPLY 与锁账本

**目标：** 一次请求创建一把锁，唯一回复销账；重复与冲突回复有明确结果。

**验收标准：**

- 锁 owner 与提交点符合设计门结论；
- callback 只回到已声明端点；
- 强制截断能反向清账，迟到回复/迟到 apply 不复活实例。

**依赖：** Task 3 与设计门 1、3、4。

### Task 5：claim / execute / apply 与失败恢复

**目标：** 继承已验证的三段式执行，但以 V5 实例和消息模型重新表达。

**验收标准：**

- execute 始终在提交锁外；
- 冲突域和 generation fence 有并发反例测试；
- cancel、失败、无效输出和超预算不会混成同一终态。

**依赖：** Task 4。

### Task 6：变量上下文与注册期预算

**目标：** 从 bind 稳定前缀和 runtime 变量构造一次可审计调用上下文。

**验收标准：**

- 超上界模板在注册期拒绝，并指向具体变量；
- 运行期发现不改变稳定前缀；
- ref 解引用保留精确版本与 lineage。

**依赖：** Task 1、5 与设计门 5。

### Checkpoint B

- 最小主线场景可执行：创建子容器 → 传变量 → REQUEST/REPLY → 产出版本化对象 → 自然结束；
- 强制截断、迟到结果、重复回复和预算越界全部有失败路径测试；
- 此时再决定 Repository、MCP、服务端和画布包结构。

## 2.9 外部审核轮（2026-08-17）—— 结论：要求修改，已修

审核结论正确：**Task 4/5 不应认定完成，未达 Checkpoint B**。已按结论把两者标回进行中。

七条 P1 全部属实并已修复，每条都补了反例测试（`test/review-p1.test.ts`）：

| # | 问题 | 修法 |
|---|---|---|
| 1 | 非法 agent 输出抛异常 → 消息永停 `CLAIMED`、记录永停 `RUNNING`，三谓词永不满足 | **backend 是不可信边界**，端口越界是 `INVALID_OUTPUT` 不是编程错误；走失败通道让状态收口。受信 handler 路径仍然直接抛 |
| 2 | `Object.freeze` 只冻一层，`body` 仍是调用方引用 —— 改嵌套字段能让已存版本内容变化而 hash 不变 | 入库深克隆 + 深冻结；`content_hash` 改全量 sha256（截断 16 位只有 64 bit，太窄） |
| 3 | `ExecutionResult` 只是 TS interface，运行期零校验 | `checkBackendResult`：形状 + `executionId` 串号 + **禁止伪造内核保留 kind**；产物全部校验通过才提交，不留部分版本 |
| 4 | REQUEST 锁没记 `waitingOn`，而反向清账完全依赖它 | 记订阅者 traceid。**服务方**被截断时请求方的锁现在能销账 |
| 5 | 只有强制截断，没有自然终止提交点 → 完成的子容器不释放父的 `child` 锁 | 新增 `settle` / `settleAll`：三谓词满足 → 终态 + 销父 child 锁，自底向上收敛 |
| 6 | 两条假阳性测试（"重复回复"实际测的是普通消息；scope 测试根本没跑到 team-b） | 前者拆成"非 REQUEST 走 reply 被拒"的集成测试 + 重复回复的单元测试；后者改成按实例定位、不靠取活顺序 |
| 7 | 订阅 scope 只接受绝对 traceid，同模板换实例即失效，与剧本帧 11 矛盾 | 加相对作用域 `$self` / `$self_subtree`，匹配时按**订阅方实例**解析 |

顺带修掉后续清单第一条：`#claim` 入口校验失败曾返回 `null`，被 `drainAgents` 当空闲提前退出、后续合法消息滞留。现在返回 `StepFailure`。

**一处审核有误**：报告称 `store.ts` 嵌入真实 NUL 字符导致 Git 视为二进制。全仓扫描零 NUL，`git check-attr` 也未标记二进制，该项不成立。

修复后：**120 条测试绿**（contracts 51 / kernel 69），typecheck 绿。

### 仍未做（承认，不含糊）

- **RunSnapshot 不存在** —— `FOUNDATION_V5.md §3.3` 声称"因果由 RunSnapshot 承担"，代码没有。ExecutionRecord 只记输入消息，不记输出集合，当前担不起因果权威。**这是文档先于实现的欠账，必须在 Checkpoint B 前补。**
- Task 6 全部：`bind` 段未进 `ExecutionRequest.vars`；`limits` 固定空对象；无模板总预算阈值；无运行期越界拒绝
- 策略节点只有 schema，无执行器
- `approval` / `timer` / `manual` 三类锁只有类型，无真实路径
- 持久化、崩溃恢复、claim 接管
- 容器工具、自修改、提案审批、权限
- MCP、服务端、实时事件、画布、真实 backend

## 2.10 RunSnapshot + Task 6 + Checkpoint B（2026-08-17）

**128 条测试绿**（contracts 51 / kernel 77），typecheck 绿。

### RunSnapshot —— 欠账已还

每次提交写 `ObjectVersion(kind="run", object_id="run/<traceid>")`，
body 含 `{seq, node, consumed[], produced[], artifacts?, termination?, usage?}`。

- **`consumed → produced` 就是因果边** —— 这正是 traceid 表达不了的那一半
  （扇出后子消息 traceid 相同却各有前因；汇聚时一条输出有多个前因）
- `causesOf(messageId)` 从 `produced` 反查 `consumed`
- `seq` **只由提交推进**，claim 单独写 ExecutionRecord ⇒ 快照序列无空洞（有测试断言）

至此 `FOUNDATION_V5.md §3.3`"因果由 RunSnapshot 承担、信封不存 causation_ids"这句成立。

### Task 6 —— B1 两半都落地

| 半 | 落点 |
|---|---|
| 注册期 | `Σ(long/ref 声明的 max_tokens) ≤ node.budget.tokens`，超了拒绝注册；**声明了 long/ref 却不给 budget 也拒绝**（否则 B1 不可执行）|
| 运行期 | 单个变量实际填充超过它声明的上界 → **直接失败**。不截断、不降级、不按优先级裁剪 |

- `bind` 段进 `ExecutionRequest.vars`：卡片按精确版本解析正文，与端口 servo 变量合并
- 变量名冲突（bind × 端口、端口 × 端口）在注册期拒绝 —— 同节点共用一张变量表
- `limits.tokenBudget` 由节点声明填入，不再是空对象
- token 估算沿用 V4 校准系数（拉丁 2.2 / CJK 0.9 字符每 token）

### 写场景暴露的真 bug

`HandlerContext` 原来不带入站端口，handler 分不清"新任务来了"和"我要的回复到了"。
REQUEST 的回复落回同一节点 → handler 再发一次请求 → **无限循环**，`drain` 撞上限。
现在 ctx 带 `port` 与 `requestId`。这条不是测试问题，是端到端场景才照出来的设计缺口。

### Checkpoint B —— 通过

`test/checkpoint-b.test.ts` 主线一条走通：
**建子容器 → 传变量 → REQUEST/REPLY → agent 三段式 → 产出版本化对象 → 自然结束**。
失败路径全覆盖：注册期预算越界 / 缺预算 / 变量名冲突、运行期上界越界、
强制截断 + 反向清账、终态拒新工作。

### 仍未做

- 策略节点只有 schema，无执行器（汇聚、循环、批量消息因此都还没有）
- `approval` / `timer` / `manual` 三类锁只有类型，无真实路径
- 持久化、崩溃恢复、claim 接管
- 容器工具、自修改、提案审批、权限
- MCP、服务端、实时事件、画布、真实 backend（pi / OpenAI / tool executors）

## 2.11 第四次归约与范围重定（2026-08-17，待开工）

上一轮打算做策略节点 + 表达式语言，讨论中被证伪。`FOUNDATION_V5.md` 已同步，
本节是**开工前的范围确认单**。

### 被删掉的（约 900 行不用写）

| 删 | 因为 |
|---|---|
| 策略节点 kind | 逐条走完它要干的活，全部能用 handler + 版本历史做（FOUNDATION §6.1） |
| 表达式语言（词法/语法/求值/静态检查） | ~450 行，为了造一个比 JS 差的语言，而受信 handler 本来就是真代码 |
| **批量 claim / 多消息原子消费** | ~200 行，**本来的内核承重墙**。消息降级成"通知"、内容进资产后不需要 |
| 节点内 `persistent` 状态 | 版本历史即累加器/计数器 |
| `PROGRAM_ERROR` / `dryRun` | 没有用户程序，就没有程序错误与试算 |
| 锁 `approval` / `timer` / `manual` | 审批就是 `request` 锁；无内核时钟；暂停不承担正确性 |
| `tick(now)` 时钟注入 | 内核不读时钟（新不变量 L0） |

### 确认的取舍

- **Eager 物化继承**：实例化时把继承链解析成完整定义并 pin。改模板 → 新版本 → 新实例。**热更新彻底没有。**
- **不做暂停**：要停就截断（永远可用），要继续就用旧引用重新实例化。"不做热恢复，做重建"。
- **自由度换向**：AI 从"写 DSL 程序"变成"选配已注册 handler + 配图"。这更贴合第一不变量。
  代价两条，写进开发指南：① 确定性不再由类型保证 ② 画布看不见节点内部逻辑。

### 待开工范围

| 批 | 内容 | 估 | 依赖 |
|---|---|---|---|
| **0** | 事务化提交（changeset + 回滚）+ 状态不变量断言函数 | ~150 | 无，**必须最先** |
| **A** | 资产节点 + handler ctx 的 `read`/`history`/`put` | ~120 | 0 |
| **B** | 容器版本管理：eager 物化继承 + 路径覆盖解析 | ~180 | 0 |
| **C** | 权限：DDL/DML/DQL 分层 + 前缀 scope 授权 | ~200 | B |
| **D** | 开发指南：汇聚 / 循环 / 择优三种标准写法，**各配可运行例子 + 测试** | 文档+测试 | A |
| **E** | 并行驱动器（冲突域已就绪，纯加法） | ~80 | 0 |
| | 合计 | **~730 + 测试** | |

批 0 必须最先：后面每批都会往提交里加变更项，事务不先立起来，每加一批就多一处半状态风险。

### 仍未做（明确挂起）

- 容器工具（自修改、提案审批的运行期入口）—— 帧 8 的扇出建子容器依赖它
- 持久化、崩溃恢复、claim 接管
- MCP、服务端、实时事件、画布
- 真实 backend（pi / OpenAI / tool executors）与文件范围控制

## 3. 后续阶段

持久化、策略语言、队列订阅、审批/定时器、观测投影、MCP、服务端和画布依次建立在 Checkpoint B 之上。每一阶段只增加一个可端到端验证的垂直切片；真实模型测试使用独立 profile，不阻塞常规 CI。

## 4. codex-cli 分工

`codex-cli 0.146.0` 已确认可用。分工原则：**codex 只做已有样板的平行展开，不做需要理解不变量的判断。**

| 谁 | 做什么 |
|---|---|
| **主线（有完整上下文）** | 契约 schema 设计；每个 Task 的**首条 exemplar 测试 + 接口签名**；判断密集的内核——锁账本、三谓词终止判定、generation fence、servo 符号推导、注册期预算求和 |
| **codex（冷启动）** | schema 的有效/拒绝样例矩阵；平行 case 的测试展开；类型样板；后期 CRUD 路由与迁移脚本 |

调用形态固定为：**1 个样板 + 一份清单 → codex 填 N 个平行项 → 主线 review**。不给 codex 开放式任务，不让它跨 Task 推进。

## 5. 暂不做

- 不从旧 TS 原型继续补测试直至变绿；它实现的是被推翻的编排模型。
- 不维持 Python↔新 V5 的长期 parity；只提取 V5 明确继承的局部行为。
- 不在设计门关闭前冻结新目录、数据库表或完整 REST API。
- 不修改归档证据来迁就新实现。



---

## 3. 问题点清单（持久化落地后的一次全面盘点）

按"是不是内核能力"分组。内核那组要先补齐 —— 它们不补，上面盖什么都是虚的。

### 3.1 内核（先补这组）

| # | 问题 | 性质 | 状态 |
|---|---|---|---|
| **K1** | **claim 没有事务，也没有提交钩子** | **正确性洞** | ✅ 已补 |
| **K2** | `ControlPlane` 完全没接线 —— 权限层是不可达代码 | 高 | ✅ 已补 |
| **K3** | `truncate` 有实现没出口 | 中 | ✅ 已补 |
| **K4** | RunSnapshot 的前缀与 GC 前缀不一致 | 埋雷 | ✅ 已补 |
| **K5** | **`AgentSpec` 停在归约前，模板声明不出沙箱 agent** | **执行面不可达** | ✅ 已补 |

#### K5 —— 契约与实现各自演进，没人对过账

`SandboxBackend` 要的是 `{ argv, profile, context, env }`（第五次归约：agent 就是
命令行），而 contracts 里的 `AgentSpec` 还是归约之前的 `{ model: string }`，且
`.strict()`。于是**任何声明了沙箱 agent 的模板都注册不进去** —— 整个执行面从编排面
够不着。

它一直没被发现，是因为内核测试用 `{ model }` 造模板、从不跑真 backend，
沙箱测试直接构造 `ExecutionRequest`、绕过模板注册。两边各自都绿。

修法是让 `SandboxAgentSpec` 从 contracts 的 `AgentSpec` 派生（`.extend()` 只补默认值），
字段再变编译期就会撞上。

#### K1 —— 两个问题，同一个修法

**其一，`#claim()` 不在事务里。**它连改四处状态（`#busy`、`#executionSeq`、
消息状态转 `CLAIMED`、`#records`），然后**手工回滚**：

```ts
this.#busy.delete(key);
this.#records.delete(executionId);
this.#setState(input.id, "QUEUED");
```

只覆盖了 `compileContext` 返回 `!ok` 这一条它预料到的路径。任何别的抛出都会留下
half state —— 而这正是 `tx.ts` 那段注释里写的、`transact` 被造出来要消灭的东西。
内核里唯独 claim 这条路径漏掉了。

**其二，claim 与 execute 之间没有钩子。**`stepAgent()` 的形状是：

```ts
const claimed = this.#claim();          // 同步
raw = await backend.run(request);       // ← 这里之前必须落盘
return transact(…, () => this.#apply(…));
```

§17.4 写着"claim 必须当场落盘 + fsync"，但持久化层**结构上够不着这个位置** ——
`#claim` 是私有的，`stepAgent` 是一个整体。所以那条设计目前不是"要靠调用方自觉"，
是**根本做不到**。

后果正是 §17.4 自己点名的那条：崩在 claim 与 apply 之间，恢复后内核不知道外面
有个 agent 在跑，于是再派一个 —— 两个 agent 同时改同一份东西。

**修法**：把 claim 包进 `transact`，并在事务内调提交钩子。于是
**落盘失败 = 提交失败 = 回滚**，这才是耐久性该有的语义；顺带把手工回滚删掉。

#### K2 —— 权限层是不可达代码

`ControlPlane` 有完整的一套：`define` / `send` / `spawn` / `run` / `truncate` /
`settle` / `subtree` / `locks` / `blockers` / `messages` / `records`，每条都过
`#authorize`。**但没有任何地方构造它。**CLI 直连 `Runtime`。

所以"人有完整权限"目前成立的原因是**根本没有权限检查**，不是因为授权对了。
批 C（DDL/DML/DQL 分层 + 前缀 scope 授权）标着 ✅，但它是一段没人调用的代码 ——
标记与事实之间的缝，正是上次外部审核 7 条 P1 全部出没的地方。

这条挡着 G1：MCP 工具层必须走 `ControlPlane`，否则开放出去的是无检查的内核。

#### K3 —— 卡住的 run 杀不掉

`Runtime.truncate` 与 `ControlPlane.truncate` 都在，但外面没有出口。一个卡住的
run 目前只能靠删状态目录处理 —— 而那会连不可变的对象历史一起删掉。

#### K4 —— 两个前缀对不上

RunSnapshot 的 object_id 是 `run/<traceid>`，资产是 `<traceid>/<name>`。
按 `job-1/` 前缀回收会漏掉 `run/job-1/…`。前缀机制被复用了八处，唯独这里
自己跟自己不一致。现在改是改一行，等第一次 GC 才发现就是改数据。

### 3.2 执行面 / 运维面（内核补完再说）

| # | 问题 | 性质 | 状态 |
|---|---|---|---|
| **E1** | 脚本 handler 未实现 → 落盘的 run 只有内置 handler 推得动 | 高 |
| **E2** | `LocalRunner` 把整个 `process.env` 摊进沙箱 | **安全** | ✅ 已补（白名单） |
| **E3** | 日志未实现（§17.6） | 中 | 📋 |
| **E4** | 日志 / observation 脱敏未实现（§17.7） | 安全 | 📋 |
| **E5** | 记录仓保留（`runs/<root>/record/`）未实现 | 低 | 📋 |

#### K2 的落定 —— 根权限表是外部配置文件

自举问题（权限表若是对象，改它要过 ControlPlane，而 ControlPlane 要读权限表）
按 §17.9 分层解开：**根表来自 `<state-root>/permissions.json`，不进对象库**。
它不是 run 的状态，是"这台机器上谁能碰这个 run"的配置；跟着对象库走会连带获得
"不可变、内容寻址、按前缀可读"，那三条对权限表和密钥一样有害 —— 撤不回来。

**缺省授权是「人类全权，agent 无权」**，两半各有理由：人类全权因为 G 目标写的
就是"人也有完整权限"，且默认拒绝会让本机工具开箱即败；agent 无权因为第一不变量 ——
agent 的每一份权限都必须显式给出，默认给了就等于没有这条不变量。
缺省是有代价的选择，所以 `status` 会报出现在跑的是缺省表还是配置表。

顺带补上 `ControlPlane` 的**对象侧 DQL**（`read` / `head` / `history`）：此前 DQL
只覆盖实例侧，而 C5 之后"东西经历了什么"全在版本历史里，不给读法等于把主要的
可观测面关在门外。

#### E1 的落定 —— 不造第三种执行面

E1 原本写的是"脚本 handler 未实现"。做的时候发现问法就不对：按第五次归约
（agent 就是命令行），脚本 handler 与 agent **没有结构差别** —— 都是"在沙箱里
跑一条命令行"。再造一套脚本执行面就是第三种执行面，正是前几次归约在删的东西。

真正缺的是别的：**`RunState` 建 Runtime 时根本没给 backend**，`drain` 只走同步
handler。于是整个执行面（沙箱、命令行、git 观察）**从没被落盘的 run 驱动过**，
只在单元测试里被直接构造 `ExecutionRequest` 调用过。契约两端各自都绿，
中间那截没人走 —— 与 K5 同一类漏法。

补法：`RunState` 收 backend，`ControlPlane` 加 `runAgents`（与同步的 `run`
分成两条，因为里面有 `await`、会跑外部进程、会花钱，合成一条会掩盖这件事），
CLI 的 `drain` 变异步、**同步 handler 与 agent 交替推进到静止**
（handler 的输出喂给 agent，agent 的输出又喂回 handler，各跑一遍不够）。

**不给 `--runner` 就没有执行面**，agent 节点原地不动且明说。跑 agent 意味着
起进程、可能出网、可能花钱 —— 这不该是某个 flag 忘了写就悄悄发生的默认值。

#### E2 的落定 —— 白名单而不是黑名单

黑名单要求穷举所有敏感变量名，而密钥命名千奇百怪（`FOO_TOKEN`、`MY_SECRET`），
漏一个就等于没有。白名单漏一个只会让某个 agent 跑不起来 ——
**一个吵闹的失败胜过一次静默的泄漏。**

