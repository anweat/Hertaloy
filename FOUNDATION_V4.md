# Nodeflow V4 基础设计

> 状态：**基础思路重建稿**。取代 V3 两份文档作为概念入口。
> V3 (`CONTAINER_MODEL_V3.md` / `PROTOCOL_WORKBENCH_V3.md`) 降级为参考资料，其中的不变量按第 6 节取舍表处理。
> V2 (`runtime_v2.py` + 37 条测试) 保留为行为基线，按第 6 节演进。

---

## 1. 命题

整个系统只做一件事：

> **把长任务切成多个短上下文的 agent 执行，用边编排它们、用版本化产物缝合它们，从而避免单 agent 上下文膨胀与注意力涣散。**

推论，全部是设计约束：

1. **上下文压缩不是特性，是失败信号。** 某个节点触发压缩，说明图切错了。压缩次数必须是一等可观测指标。
2. **编排面存在的理由是精确构造每一次 agent 调用的上下文。** 不是"能跑图"，是"能控上下文"。
3. **产物必须版本化。** 返工循环里没有版本锚点，就无法比较、回滚、复现。
4. **模型不做编排决策。** 编排由人（或外部 AI）在画布上排布好，由策略节点按配置执行。模型只在预先声明的选项中选择。

主线场景两个，共享同一形状（长周期、产物型、上下文稀缺、有评审返工）：

- **大型项目编码与 review**
- **学术调研与写作**

---

## 2. 主线剧本

所有对象必须能指回下面某一帧。指不回的，删。

**场景：给现有项目加一个「导出」功能。**

| # | 发生什么 | 逼出什么 |
|---|---|---|
| 0 | 人在顶层助手处提需求，助手创建一个 Job（主流程实例） | 主流程单实例；控制面入口 |
| 1 | Plan Agent 由 3 张卡组装：`rules/py-strict@3` + `skill/repo-survey@1` + `mcp/git@2`，编译成 AgentSpec 并 **pin 卡片版本** | AssetCard；AgentSpec 编译；版本 pin |
| 2 | 有人在库里把 `rules/py-strict` 改成 `@4`；**在途的 Plan Agent 仍用 `@3`** | 在途实例能力集不漂移 |
| 3 | Plan Agent 读需求 + 仓库摘要，产出 `plan@1`（含 3 个子任务） | Agent 节点；产物版本 |
| 4 | Plan 进人工审批节点，人改了一处，产出 `plan@2` | 审批节点；产物可被外部修改后重新索引 |
| 5 | Strategy 按 `plan@2` 展开 **3 个并行 coder 容器实例** | 容器 = 并行实例边界；Strategy output policy |
| 6 | coder#2 缺一个 skill，**向发现服务队列发 REQUEST + callback**。发现服务是一个**长期 OPEN 的独立实例**，订阅该主题，与 coder 之间**没有任何静态边** | **服务式子流程复用**；队列独立索引 |
| 7 | 发现服务异步返回 skill 卡 → 追加到 coder#2 的 `context.tail`；coder#1/#3 不受影响 | 卡片运行时发现；实例级隔离 |
| 8 | coder#1 改 5 个文件，其中 1 个越出编辑范围 → **git 临时存档 + 标记**，不阻断 | 文件软边界；Workspace 快照 |
| 9 | 三个 coder 各自调用**同一个 review 子流程模板**（`instantiationPolicy=PER_CALL`），得到 3 个互相隔离的实例 | **调用式子流程复用**；实例隔离 |
| 10 | coder#1 与同图内的 `metrics` 节点**不连边**，通过队列上报进度 | **消息非跨图专用**（M2） |
| 11 | 三路汇聚（ALL_REQUIRED），合并 → 跑测试 → 1 个用例失败 | Strategy input policy；跨实例汇聚 |
| 12 | 循环策略节点在提交时写下一条**标注**，引用 `{plan@2, spec@1, manifest@7, testReport@1}`；同时本轮链路的**全量 JSON 存成一个版本** | 标注 = 策略节点的普通输出；RunSnapshot |
| 13 | Strategy 判定需返工，沿循环边回到 coder（epoch 2），**新上下文只含失败用例 + 相关文件切片，不带 epoch 1 完整历史** | **循环 + 上下文裁剪 —— 命题的核心** |
| 14 | 人中途改需求，顶层助手发 CONTROL 暂停；在途执行被取消，已提交的记录保留 | 取消；执行与提交分离 |
| 15 | 用 epoch 1 那条标注里的 objectRefs 作为初始化参数，实例化一个新图继续 | fork = 用旧引用重新实例化，无需专门机制 |

**并行剧本 B（调研写作）** 复用同一批机制，只验证跨场景通用性：

| # | 发生什么 | 逼出什么 |
|---|---|---|
| B1 | 一个与剧本 A **完全无关**的调研 Job，向**同一个发现服务**发请求 | 服务式实例被多个不相关流程共用 |
| B2 | 检索子流程以 `instantiationPolicy=POOL(2)` 承接 5 次调用 | 实例池复用 |
| B3 | 同一张 `skill/citation-format@1` 卡被剧本 A 与 B 同时引用 | 卡片多处引用无耦合 |

第 13 帧是整个系统存在的理由。设计取舍冲突时，优先保它。

---

## 3. 四个面

```
┌──────────────────────────────────────────────────────────┐
│ 装配面 Authoring         设计期 / 无运行状态               │
│ character · skill · mcp · rules · prompt 模板 · 发现服务   │
│ 产出：AgentSpec（编译产物）                                │
└──────────────────────────────────────────────────────────┘
                          ↓ 编译
┌──────────────────────────────────────────────────────────┐
│ 编排面 Orchestration     毫秒级 / 确定性 / 可回滚           │
│ 边 · 策略节点 · Servo · 提交 · 容器实例化 · 跨图消息        │
└──────────────────────────────────────────────────────────┘
        ↓ ExecutionRequest        ↑ ExecutionResult
┌──────────────────────────────────────────────────────────┐
│ 执行面 Execution         分钟级 / 非确定 / 有副作用 / 不可回滚│
│ harness 适配 · session · 工具调用 · 审批 · 流式 · 取消 · 预算│
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ 控制面 Control           助手 AI · 监控 · 暂停 · 定时        │
│ 把上面三层封装成 MCP，然后把助手也当用户                    │
└──────────────────────────────────────────────────────────┘
```

**分面的收益**：取消、超时、流式、审批、上下文压缩、token 计量全部落在执行面，**不污染消息协议**；agent 执行不占用提交事务，并发冲突问题消失。

### 3.1 编排面的两套传递机制（不统一）

判据是 **静态直连 vs 独立索引订阅**，**不是** 图内 / 跨图。

| | **边 Edge** | **消息 Message / Queue** |
|---|---|---|
| 寻址 | 静态声明的端点对，实例化时解析 | **独立索引空间**：`topicId` / `queueInstanceId`，与图拓扑正交 |
| 关系 | 设计期固定连接 | 运行期订阅，收发双方无需任何静态关系 |
| 作用域 | 图内 | **不限**——同图、跨图、跨容器一视同仁，只要有队列接收 |
| 地位 | **编排主干** | 松耦合通道 |
| 用途 | 数据流、策略判断、循环 | 异步任务、钩子、服务式子流程、发现服务、跨流程协作 |
| 语义 | 传 payload，经 Servo 变换 | `PUBLISH`（发后不管，可多订阅）/ `REQUEST` + callback（异步任务，单次回复） |
| 契约 | Edge 两端 contract | 主题 contract |
| 对拓扑的影响 | 它就是拓扑 | 不产生图内边；订阅关系可增删 |

**不变量 M1 —— 编排权威属于边。** 消息只负责把 payload 送达一个**已声明的订阅端点**。送达之后，图内路由完全由边接管。消息不选边、不创建边、不参与图内路由决策。

**不变量 M2 —— 队列是独立索引空间。** 地址与图/容器层级正交。任何持有发送能力的节点均可发；任何声明了订阅的端点均可收。同图内两个不连边的节点通过队列通信是**合法且预期的用法**。

**不变量 M3 —— callback 落回已声明端点。** 回复投递到发起方的一个已声明端点，从该端点起由边接管。callback 不重选边、不构造地址。

由 M1–M3 直接消解的 V3 开放项：REPLY 是否重选 Edge、跨容器 fan-out 原子性、全局动态 Edge、queued CALL 的 callback 归属、control/observe 是否复用同一 envelope。

### 3.2 子流程的两种复用形态

两者共用同一套对象，区别只在**谁持有实例、靠什么触发**。

| | **调用式复用 Call-style** | **服务式复用 Service-style** |
|---|---|---|
| 形态 | 引用节点（subflow node 引用一个 GraphTemplate） | 长期 OPEN 的 GraphInstance，订阅一个主题 |
| 触发 | 上游边送到该节点 | 队列投递 |
| 实例 | 按 `instantiationPolicy` 决定：`PER_CALL` / `WARM_POOL(n)` / `SINGLETON` | 一份（或实例池），生命周期独立于调用方 |
| 隔离 | 每次调用的实例互不共享状态 | 实例状态跨调用累积（受策略约束） |

**`WARM_POOL(n)` 只复用执行资源，不复用状态。** 每次承接调用时 `persistentState` 一律清空。

> 判据是**是否产生暗示性**。上一轮残留的节点状态会隐性引导下一轮——那正是本项目要消除的注意力涣散的结构版本。真正需要跨轮保留的环境记录与项目相关尝试，走**产物层**（ObjectVersion），不藏在节点状态里。
| 调用方与被调方关系 | 静态：父图声明了 slot | **无静态关系**：任何流程都能发 |
| 典型 | review 子流程被 3 个 coder 各调一次 | 发现服务、索引服务、公共评审队列 |

服务式复用**必须**依赖 M2（独立索引），因为发送方和服务之间不存在静态边——这是队列存在的第一位理由。

**Subflow 不是第三种传递机制。** 引用节点在父图里就是普通节点，有普通端点、连普通边；它的内部行为（实例化/绑定/投递/等待）属于**节点实现**。V2 已验证此路径。

### 3.3 卡片式资产

`skill` / `mcp` / `rules` / `prompt` 统一建模为 **AssetCard**：稳定 ID、版本、标签、正文。

**读写不对称，这是全部设计：**

| | 规则 |
|---|---|
| **读（载入上下文）** | **只读引用**，与现有 harness 一致。不复制正文，不允许就地改 |
| **写** | 通过 tool 完成。修改与再分发的职责交给 **skill / mcp 服务**，不是内核 |
| **生效时机** | **实例休眠时更新**。活跃执行期间能力集不变 |
| **引用** | 同一张卡可被任意多处引用，引用不产生耦合 |

由此得到的不变量，比"永久 pin"更弱也更实用：

> **活跃期不漂移，休眠时才更新。** 一次执行进行中，其可见卡片集合固定；实例回到 idle 后才拉取新版本。

运行期发现的卡（剧本第 7 帧）追加到该实例的 `context.tail`，不回写模板、不影响其他实例。

---

## 4. 执行面适配层

### 4.1 设计原则

**按本地高保真场景设计接口，托管作为降级后端。** 反过来会被远程沙箱的文件挂载能力拖累整个模型——主线场景是大型本地代码库。

### 4.2 接口

```
ExecutionRequest {
  executionId
  agentSpec       { model, systemPrompt, tools[], skills[], mcpServers[] }   // 装配面编译产物
  context         { head[], messages[], tail[], transient[] }                // 编排面精确构造
  workspace       { root, readable[], writable[], overflowPolicy }           // 文件范围（软边界）
  outputContract  { schema, allowedEmitPorts[] }                             // 只能选，不能构造
  limits          { tokenBudget, wallClock, maxToolCalls }
  control         { cancelToken, approvalChannel, streamChannel }
  resume?         { sessionHandle }
}

ExecutionResult {
  executionId
  emissions[]     { port, payload }          // 输出提案，需过 contract 校验
  artifacts[]     { kind, ref, version }     // 产生的对象版本
  usage           { inTokens, outTokens, cost, wallClock, toolCalls, compactions }
  termination     DONE | CANCELLED | BUDGET | INVALID_OUTPUT | FAILED
  sessionHandle   opaque                     // 编排面只存不解释
  diagnostics?    { failedValidationAttempts, ... }
}
```

**关键点**

- `outputContract.allowedEmitPorts` 是"Agent 只能选不能构造"这条安全属性的落地点：agent 通过一个 `emit(port, payload)` 工具输出，`port` 是枚举。schema 天然强制，无需运行时地址校验。
- `usage.compactions > 0` 是**图切分错误的告警信号**，不是正常统计项。
- `sessionHandle` 必须不透明。各 backend 含义不同，编排面存储但绝不解析。
- `INVALID_OUTPUT` 是常态终止原因之一（LLM 输出不合 schema）。重试循环属于执行面内部，不上升为协议错误。

### 4.3 Backend 矩阵

| Backend | 供应商 | 文件 | 自定义工具 | 审批 | 取消 | resume | 适用 |
|---|---|---|---|---|---|---|---|
| **pi** (`@earendil-works/pi-agent-core`) | **中立**（OpenAI/Anthropic/Google） | 本地 | ✅ `AgentTool.execute` | ✅ `beforeToolCall` | ✅ `agent.abort()` | ✅ `agentLoopContinue` | **已实测，定为主路径** |
| Claude Agent SDK（自托管） | Anthropic | 本地 | ✅ | ✅ hooks/permissions | ✅ | ✅ | 高保真备选 |
| Managed Agents（托管） | Anthropic | 远程沙箱，需挂载 | ✅ custom tool 事件 | ✅ `always_ask` | ✅ interrupt | ✅ session | 无基础设施场景 |
| 直连 API + 手写 loop | 中立 | 自理 | 全自理 | 全自理 | 全自理 | 全自理 | 兜底 / 特殊模型 |

**托管路径的真实代价（要认）**：大型本地仓库需按会话挂载进远程沙箱，改动需回传。对主线场景是明确降级。设计上保留该 backend，但不作为默认。

### 4.3.1 pi 接口核对结论（接线已验证；真实供应商待实测）

低层 Agent API 的**接线形状**已由 `TestPi`（faux provider，5 passed / 3 设计跳过）坐实；
下表接口落点经代码确认（真实供应商下 A2/A3/D1 仍待实测，见 `HARNESS_EVALUATION.md §3.1`）：

| 我们的接口 | pi 的落点 |
|---|---|
| `ExecutionRequest.agent_spec.systemPrompt` | `agent.state.systemPrompt`（可变） |
| `ExecutionRequest.agent_spec.tools` | `agent.state.tools: AgentTool[]`（可变） |
| `ExecutionRequest.context` 编译 | `agent.prompt(messages)` + **`transformContext(messages, signal)` hook** ← 上下文编译器的插入点 |
| `OutputContract.allowed_emit_ports` 强制 | **`beforeToolCall` → `{block, reason, terminate}`** ← 第一不变量的落点 |
| `control.streamChannel` | `agent.subscribe((event, signal) => ...)` |
| `control.cancelToken` | `agent.abort()` + AbortSignal 传入 `execute` |
| `resume_handle` | `agentLoopContinue(context, config)`，**结构化非 opaque**，可自行持久化 |
| 自定义工具（编排面回调） | `AgentTool.execute(toolCallId, params, signal, onUpdate)` |

**唯一缺口：无内置 MCP。** README 明示 "No MCP … or build an extension that adds MCP support"。
影响可控：按不变量 X，工具集本就必须编译期声明完，`agent.state.tools` 正是该契约的落点；我们需要自写
`MCP → AgentTool` 适配器。

**对齐处**：pi 的 skills 是 Agent Skills 标准的 Markdown，**自动追加到 prompt 尾部**——与不变量 X
的"skill 是文本可追加"撞上；其 system prompt 分层（`SYSTEM.md` → `AGENTS.md` 层叠 → skills 追加）
就是 §1.2 布局的 pi 版本。

**不采用其 CLI 层**：那一套从文件系统目录约定读取卡片，而我们的卡片是索引中的对象。
路线是直接使用 `pi-agent-core` 的 `Agent`，自行组装 systemPrompt——编译规则必须归内核。

### 4.3.2 待决：语言边界

pi 是 TypeScript；当前编排面骨架是 Python。三案：

| 方案 | 代价 | 收益 |
|---|---|---|
| A. 编排面改 TS | 重写 51 条测试 | 同语言；`transformContext` / `beforeToolCall` 直接是内核代码 |
| B. pi 作服务 + 自造 RPC | 要设计协议 | Python 保留 |
| **C. Python 编排面 + 薄 TS 适配进程** | 流式转发、取消跨进程 | 改动最小，且正好验证适配层是否真的窄 |

倾向 **C 先做最小验证**（`ExecutionRequest/Result` 本就 JSON 可序列化）；若流式与取消的跨进程摩擦
过大，A 是更干净的终局——毕竟 `transformContext` 与 `beforeToolCall` 恰是内核最核心的两块。

### 4.4 执行生命周期：三段式

```
commit A: claim
    锁定节点、消费输入消息、写入 ExecutionRecord(RUNNING)、推进提交序号
        ↓
    execute （事务外，分钟级，有副作用，可崩溃，可取消）
    只允许改：本次 execution 的草稿状态 + 经 Workspace 协议产生的对象版本
        ↓
commit B: apply
    base 检查只针对被 claim 的切片（NodeInstance + 消费的消息集合），
    不是整个容器
```

**冲突域 = NodeInstance + 被消费的消息集合。** 容器的提交序号保持单调递增（供 Checkpoint 与恢复引用），但乐观并发不按容器级 base 检查——否则并行图必然退化为串行。

`ExecutionRecord` 是必需的持久对象（第 10 帧：取消时需知道哪些执行在途；崩溃后需知道谁能接管）。

---

## 5. 编排面最小对象集

每一项标注它对应剧本的哪一帧。指不回帧的不得加入。

### 5.1 定义层

| 对象 | 帧 | 说明 |
|---|---|---|
| `GraphTemplate` | 3,5,9 | 节点、端点、边、Servo、策略绑定、子槽声明、订阅声明。发布后不可变，按版本引用 |
| `NodeDefinition` | 3,4,11 | kind: `agent` / `plain` / `strategy` / `approval` / `subflow` / `start` / `end`。**没有 `checkpoint` kind**——循环锚点是 `strategy` 的一种预置配置，见 §5.6。`end` 是终态汇点：只进不出、消费到达数据并留终态提交；实例关闭一律走控制面 `control(close)`（§6 降级表） |
| `EdgeDefinition` | 3,5,13 | 固定 source/target 端点 + operation + Servo 绑定 |
| `JsonTransformDefinition` | 3 | **单一类型 + `role` 枚举 + role→能力矩阵**（取代 V3 的 7 种） |
| `StrategyPolicy` | 5,11,13 | input policy → variable projection → evaluator → trigger policy → output policy |
| `ContainerSlot` | 5,9 | 允许绑定什么子容器、基数、所有权、**`instantiationPolicy`**：`PER_CALL` / `WARM_POOL(n)` / `SINGLETON` |
| `TopicDefinition` | 6,10,B1 | 消息主题 + contract + 投递规则。**独立索引，与图拓扑正交** |
| `SubscriptionDefinition` | 6,10 | 模板声明"本图的哪个端点订阅哪个主题" |
| `AssetCard` | 1,2,7,B3 | `kind`(skill/mcp/rules/prompt) + id + version + tags + body。稳定 ID，可被任意多处引用 |
| `AgentSpec` | 1,2 | 装配面编译产物：model + 已 pin 版本的卡片集 + tools |
| `MessageContract` | 全 | 不可变 JSON Schema，精确版本引用 |

### 5.2 实例层

| 对象 | 帧 | 说明 |
|---|---|---|
| `GraphInstance` | 0,5,6 | 唯一工作实例身份。持有 OPEN/CLOSED、节点状态、context head/tail、子容器绑定、提交序号。**服务式子流程就是一个长期 OPEN 的 GraphInstance，无需新对象** |
| `NodeInstance` | 3,13 | 归属某 GraphInstance。**状态拆两半**：`persistentState`（跨 epoch 长期）+ `executions[executionId]`（本轮工作区） |
| `ExecutionRecord` | 12,14 | claim→execute→apply 的持久事实。取消与崩溃接管的唯一依据 |
| `QueueInstance` | 6,10,B1 | 主题的运行期承载：有序引用 + 投递状态。**独立索引身份**，不属于任何图 |
| `MessageInstance` | 6,10 | 消息 + 投递状态 + callback 状态 |
| `Subscription` | 6,10,B1 | (topic) → (graphInstanceId, endpoint)。运行期可增删，不产生图内边 |

**节点单例规则**：同一 GraphInstance 内，一个 NodeDefinition 对应一个长期 NodeInstance；循环不重复实例化（第 13 帧）。需要多份并行状态时创建多个 **GraphInstance**（第 5、9 帧），不做节点多例。

**服务式复用不引入新对象**——它是"长期 OPEN 的 GraphInstance + Subscription"的组合。这是模型正确的一个信号。

### 5.3 记录 / 版本层

| 对象 | 帧 | 说明 |
|---|---|---|
| `CommitRecord` | 12 | (graphInstanceId, seq) → 本次提交的事实 |
| `ObjectVersion` | 3,4,12 | plan / spec / manifest / testReport / **RunSnapshot** 的不可变内容 —— 同一个机制 |
| `Annotation` | 12,15 | 策略节点提交时可附带的轻量标注：一组 objectRef + 自定义字段。**不是独立子系统** |
| `TraceSpan` | — | 派生观测，**不参与任何裁决** |

**RunSnapshot 不是新类型**：某条链路 / 某次循环的全量 JSON 就是一个 `ObjectVersion`，kind = `runSnapshot`。它解决可观测性——**保留全量，传递时不带**。想在里面注入自定义字段，配置 Servo 即可，不需要给 envelope 加协议字段。

### 5.6 循环与锚点不是内核机制

V3 和本文早期稿把 Checkpoint 当成一等对象。**收回**。它是：

```
Strategy 节点
  + persistentState 里存 epoch
  + evaluator 判断继续 / 退出
  + output policy 选循环边或退出边
  + 提交时附带一条 Annotation（引用本轮产物版本）
```

内核只需要提供已有的三件事：策略节点可读写 persistentState、可引用 ObjectVersion、提交时可附带标注。**没有 CheckpointRecord，没有 seal 协议，没有 cyclePath 字段。**

"Checkpoint 循环"因此降级为**几种预置的策略配置模板**（固定轮次 / 条件退出 / 评分阈值 / 人工放行），随产品附带，用户可改可弃。

**fork 也随之消失**：用某条 Annotation 里的 objectRefs 作为初始化参数实例化一个新图，就是 fork。不需要专门的 fork 语义、不需要定义 Workspace 共享关系。

### 5.4 上下文对象（命题核心）

```
InvocationContext {
  head[]       // 实例化前解析的引用，固定不变
  messages[]   // 本轮触发消息携带的切片，有数量上限
  tail[]       // 实例化后经 owner 批准追加（第 4 帧的 skill card）
  transient[]  // 本轮临时，下轮清空
}
```

每次 agent 调用重新编译，不保留隐藏会话历史。第 9 帧的裁剪发生在这里：新 epoch 的 `messages[]` 只含失败用例与相关文件切片，`head` 保持不变，上一 epoch 的执行过程不进入。

**上下文预算是版本化配置，且必须可观测**：每次执行记录 `usage.compactions`，非零即告警。

### 5.5 文件与 git —— 运行时内容，不进内核

**当前不定义。** 文件发现、编辑范围、越界存档全部交给 **agent 通过 tool 自行处理**：

- skill / agent 用 tool 自己发现文件与范围
- 后续若需要留痕，改的是**给 agent 的 tool 实现**——让它默认记录 id、自动创建存档
- 编排面不持有 `WorkspaceSnapshot`，不定义 `overflowPolicy` 三态

这不是推迟决策，是判定它属于错误的层：内核不该知道 git。

---

## 6. V2 / V3 遗产取舍

### 保留（已验证或已确认正确）

| 项 | 来源 |
|---|---|
| Definition / Instance / Record 三层，身份不混用 | V3 |
| GraphTemplate → GraphInstance 单层运行身份 | V2 |
| 统一 Endpoint（同一端点可 receive/emit，方向来自本次操作） | V2 + V3 |
| Servo 只改 payload，不改路由/操作/契约/关联 | V2 + V3 |
| Strategy = 可复用 policy 组合，不是新运行子系统 | V2 |
| 消息投递三态 QUEUED → CLAIMED → CONSUMED | V2 |
| 节点级锁 + 提交失败回滚 | V2 |
| close 走授权路径并留提交事实（控制面 API） | V4（test_boundaries close 实验1/2、G3/G4） |
| 每轮重建 agent 上下文，无隐藏会话历史 | V2 |
| Trace 只观测，不裁决 | V3 |
| **Agent 只能在预先声明的选项中选择，不能构造地址/能力/契约** | V3（提升为第一不变量） |
| 37 条行为测试 | V2 |

### 降级 / 改造

| 项 | 改成 |
|---|---|
| 容器级 revision 乐观并发 | 提交序号保留；冲突域降到 NodeInstance + 消费消息集合 |
| V2 的 close-tag 消息 + 内核 DRAIN + end 关闭语义 | **V4 定案**：关闭走控制面 `control(close)`（授权 + 提交事实，G3/G4）；`end` 是终态汇点（只进不出、消费到达数据并留终态提交，G5）；排空由编排自行表达（close 实验1/2）。不再有 CLOSING 状态 |
| 统一 JSON envelope 覆盖一切通信 | **拆成边传递 + 跨图消息投递两套** |
| `ContainerTemplate.runtimeSlot` 三选一联合 | 单一 Graph 运行时；Workspace / Queue 降为服务，不是 runtime type |
| 7 种 Transform Definition | 1 个 `JsonTransformDefinition` + `role` 枚举 + 能力矩阵 |
| `nodeState` 单值 | 拆 `persistentState` + `executions[executionId]` |
| "容器"一词承载四种含义 | 只保留：**可实例化 + 并行边界 + 上下文隔离边界** |
| `ExecutionRecord` 列为开放项 | 提升为必需对象 |
| Checkpoint 排在讨论顺序最后 | 提升为第一优先，它是差异化所在 |

### 删除

| 项 | 理由 |
|---|---|
| 跨容器分布式事务、outbox、lease/ACK broker、跨容器最终一致性 | 单运行时，跨流程同步是原生能力 |
| receipt 作为独立可投递对象 | 降为本地 API 返回值 |
| `plane: RUNTIME` 枚举值 | 内部函数，不该出现在消息模型里 |
| 四种图的形式化（Definition/Instance/Communication/Trace Graph） | 描述性收益，无实现收益 |
| `correlation.conversationId` | 无专属场景 |
| `cycleEpoch` 列为"版本身份" | 它是运行状态，不是版本 |
| `emit.REPLY.contractPolicy` | 契约由 pending 请求携带，端点声明近乎空值 |
| `CROSS_RETAIN` | 暂缓，无场景 |
| 通信完备性矩阵（13 行） | 边/消息拆分后自动坍缩 |

### 新增（V2/V3 均缺）

| 项 | 帧 |
|---|---|
| 执行面 + ExecutionRequest/Result 接口 | 全 |
| 装配面（character / skill / mcp / rules / prompt 组装、发现服务） | 4 |
| 取消 / 审批 / 预算 / 流式 | 2,10 |
| 文件软边界 + git 临时存档 | 5 |
| 上下文预算与压缩次数作为一等指标 | 9 |
| 产物版本作为 Checkpoint 的结构化引用 | 8,11 |
| Checkpoint fork | 11 |

---

## 7. JSON 的 LLM 可写性设计原则

JSON 是**编译目标**，画布是可视化与人工调整面，助手 AI 也在这一层生成配置。目标读写者是 LLM，不是人。

| 原则 | 反例 | 正例 |
|---|---|---|
| **内联优先，引用是优化** | `"servoRef": "plan-to-code@2"` 要求先知道注册表内容 | `"servo": { "map": {...} }`，可选 `"$ref"` |
| **扁平优于嵌套** | 五层嵌套的 runtimeSlot.definition.nodeDefinitions | 顶层 `nodes` / `edges` / `policies` |
| **规则一致** | 有的地方 `{id: ...}`，有的地方裸字符串 | 同一位置永远同一形状 |
| **枚举优于自由字符串** | `"operation": <任意>` | `"operation": "PUSH" \| "CALL"` |
| **结构化优于编码** | `"checkpointId": "impl-loop:4"` | `{"nodeId": "impl-loop", "epoch": 4}` |
| **错误可读** | "schema validation failed at #/definitions/..." | "节点 `coder` 的端点 `result` 未声明，可用端点：`out`, `error`" |
| **默认值显式化** | 隐式默认，LLM 猜不到 | 编译器补全后回写，画布显示 |

**画布 ↔ JSON 必须无损往返**：布局坐标、分组、注释存放在独立的 `_layout` 顶层键，不进入语义校验，不进入版本指纹。

---

## 8. 已确认的基线

1. 命题是上下文切分，不是通用编排。上下文压缩是失败信号。
2. 四个面：装配 / 编排 / 执行 / 控制。执行面通过窄接口接入，可换 backend。
3. **边是编排主干；队列是与图拓扑正交的独立索引空间。** 判据是"静态直连 vs 订阅投递"，不是"图内 vs 跨图"——同图内两个不连边的节点走队列是合法用法。消息送达已声明端点后，路由完全由边接管。
4. 容器 = 可实例化 + 并行边界 + 上下文隔离边界（回归原始定义）。
5. Agent 只能在预先声明的选项中选择，永远不能构造地址、能力或契约。
6. 执行拆 claim / execute / apply 三段，冲突域为 NodeInstance + 消费消息集合。
7. NodeInstance 状态拆长期状态与本轮执行工作区。
8. 单运行时。不假设分布式，不做 broker。
9. 运行中不改拓扑；动态编排通过"生成定义 → 校验 → 实例化子容器"表达。
10. JSON 是 LLM 可写的编译目标；画布是视图。
11. 文件、git、编辑范围属于运行时 tool 行为，内核不建模。
12. **循环锚点不是内核对象**，是 Strategy 配置 + 一条轻量 Annotation。差异化在"返工时裁剪上下文 + 产物版本化"这个**行为**上，不在某个具体对象上。
13. 可观测性靠**保留链路/循环的全量 JSON（作为 ObjectVersion）**，不靠给 envelope 加协议字段。自定义注入配 Servo。
14. 卡片：读为只读引用，写经 tool 交给 skill/mcp 服务，**休眠时生效**。

---

## 9. 开放项

**下一轮需要定的：**

- `AgentSpec` 的编译规则：skill 分级（全局/项目/会话）如何折叠、MCP 可用性探测何时执行、rules 与 prompt 的拼装顺序
- 审批节点的形态：是 NodeDefinition 的一个 kind，还是执行面的 `approvalChannel`，还是两者都要
- 消息投递保证等级：至少一次？恰好一次？失败重投谁负责？
- 存储、保留、压缩、GC：一次真实运行产生数百条 CommitRecord + ObjectVersion
- Strategy 的 evaluator 若由模型驱动，其自身的上下文如何构造（它也是一次 agent 执行）

**已判定为运行时 / 配置层，内核不管：**

- 文件、git、编辑范围、越界存档 → agent 的 tool 自理
- 循环模式 → 预置策略配置模板，可改可弃
- 卡片的修改与再分发 → skill / mcp 服务
- fork → 用旧 Annotation 的 objectRefs 重新实例化

**已明确推迟的：**

- 多例 NodeInstance（`MULTI` + `instanceKey`）——先用多 GraphInstance
- 嵌套循环 epoch 的推进/继承/关闭
- 定义热迁移
- pub/sub 高级形态（competing consumer、批处理、优先级）

---

## 10. 当前进度

**验收集 52/52 绿**（`nodeflow_v4.py` + `test_foundation_v4.py`，内存实现，mock backend）。
全仓当前 **278 条测试**：`PROBE_PI=1` 下 273 passed / 5 skipped（pi 未装或未设
`PROBE_PI` 时其 8 条自动跳过）。

Phase 1 真实工具执行闭环（2026-08-14）新增：

- `openai_compat_driver.mjs` 内置执行器 `read_file` / `write_file` / `list_dir` /
  `run_shell`（模块 `drivers/tool_executors.mjs`）：工作区根限制、越界拒绝、
  输出截断、超时；`run_shell` 需 `NODEFLOW_ALLOW_SHELL=1` 显式启用。
- 编排面把工作区根传入 `ExecutionRequest.workspace.root`：
  `node.workspace` > `instance.params.workspace_root` > `"."`（`test_workspace.py`）。
- 真实模型 L5：temp 工作区内 `read_file → write_file → emit → sink` 已跑通，
  `test_live_graph.py` 现为 5 条。

| 组 | 覆盖 | 关键结论 |
|---|---|---|
| A 卡片与 AgentSpec | 6 | 读=只读引用，写经 tool，**休眠时生效**；活跃期不漂移 |
| B 边编排 | 7 | Servo 越权在注册期被拒；Strategy 展开并行子容器；循环不重复实例化 |
| C 队列独立索引 | 9 | **同图不连边可走队列**；callback 落已声明端点；RunSnapshot 保留全量链路 |
| D 子流程复用 | 6 | 服务式复用**未加任何新对象**即绿；WARM_POOL 只复用资源不复用状态 |
| E 执行面 | 7 | claim/execute/apply 三段；**冲突域节点级**；崩溃可接管；handle 不透明 |
| F 循环与上下文裁剪 | 6 | **epoch 2 只见失败切片**；预算调用前拒绝；压缩产出告警 |
| G 控制面 | 5 | 审批授权；控制留提交事实非旁路；CLOSED 终态约束；end=终态汇点 |
| H 版本管理 | 6 | V1–V4 + lineage；RunSnapshot 就是 ObjectVersion |

Phase 0 一致性收口（2026-08-14）新增的硬约束：

- 定义层注册即完整：spec/policy/handler/slot/topic/端点/Servo 全引用注册期校验；
  模板/主题/变换/策略/handler 重复注册拒绝（`test_definition_guard.py`）。
- Strategy 选择/输出策略轴补齐：TOP_ONE(DISCARD/RETAIN)/ONE_PER_INPUT/CROSS_ALL/
  WAIT_ALL/CROSS（`test_strategy_policies.py`），ALL_REQUIRED 未声明 selection 时
  默认 ONE_PER_INPUT（兼容既有模板）。
- 输出契约推导进 `OutputContract.schema`；apply 对 emit 契约做取值校验；
  "reply" 只是回程通道，不再是自由端口。
- 持久化补齐 `messages.attempts/exit_port`（跨重启重试计数与 subflow 回程不丢）。
- pi：低层 Agent 接线由 `TestPi`（faux provider）验证 5/3；真实供应商待实测。

三条被测试验证掉的简化：
- `B6` 绿 → 循环控制不需要 Checkpoint 机制，Strategy 配置足够
- `D3/D4` **没写实现就绿** → 服务式复用真的只是"长期 OPEN 实例 + 订阅"
- `F5` 绿 → fork 不需要专门机制，拿旧 objectRefs 重新实例化即可

## 11. 下一步顺序

1. ~~把剧本写成测试骨架~~ ✅
2. ~~卡片与 AgentSpec 编译~~ ✅
3. ~~队列与订阅~~ ✅ —— "独立索引"判据站得住
4. ~~子流程两种复用~~ ✅ —— 服务式复用未加新对象即成立
5. ~~执行面三段式 + 节点级冲突域~~ ✅
6. ~~产物版本 + RunSnapshot + Annotation~~ ✅
7. ~~上下文裁剪与预算观测~~ ✅ —— 命题本身已可断言
8. ~~控制面授权与终态~~ ✅

9. ~~实测 harness 待验证清单~~ ✅ 对照组真实 API 全过；pi 低层 API 接线验证（faux provider 5/3），真实供应商待实测（见 `HARNESS_EVALUATION.md`）
10. ~~实现第一个真 backend~~ ✅ `SubprocessBackend` + OpenAI 兼容 driver，
    已用 DeepSeek `deepseek-v4-flash` 跑通真实图执行（`test_live_graph.py`，4 条，三轮稳定）

**以下为剩余工作：**
11. ~~持久化~~ ✅ `nodeflow_persistence.py` —— 对象 append-only 增量写，运行状态每次提交
    upsert，挂在 `Runtime.on_commit`。崩溃接管（帧 14）已是真能力（`test_persistence.py` S5）。
    定义层刻意不落盘：由装配面重新注册，handler 本就是函数存不了。
12. ~~真并发~~ ✅ `drain_concurrent(workers=N)` —— 调度拆成"锁内选取/claim"与
    "锁外执行"两段；`test_concurrency.py` 8 条坐实了**冲突域节点级**这条设计
    （N3 是 E5 的真线程版本：同容器两节点并发提交，无一被作废）
13. 消息投递保证等级（至少一次？谁负责重投？）
14. 装配面实体：卡片库、标签索引、发现服务
15. JSON schema 与校验器（含 LLM 友好的错误信息）
16. 画布与 `_layout` 无损往返
17. 控制面助手 AI（把 9–16 封装成 MCP）

每加一个持久对象继续追问：

> **删掉它，剧本的哪一帧无法正确表达？**
