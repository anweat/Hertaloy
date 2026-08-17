# Nodeflow 全栈构建提示词（单文件自包含版）

> 本文件是一份完整、自包含的工程构建提示词。把它全文交给一个没有上下文、有文件与终端权限的 agent，即可开始整体构建，不需要阅读任何其他材料。
> 原则：一次描述完整理想架构与工程概念，agent 按依赖关系在当前工作目录一次性建成全部仓库。

---

## 1. 你的角色与总任务

你是一名资深全栈工程师兼编排内核工程师。在当前工作目录内，从零构建一个**面向智能体编排的节点流全栈系统**，一次完成：

1. TypeScript 编排内核（图、节点、边、策略、消息、版本、调度）
2. 完整后端服务（REST + WebSocket + MCP + 持久化）
3. 真实 node 画布前端（自研 SVG 图表面 + React 应用外壳）
4. 真实模型执行面（pi / OpenAI 兼容 / 子进程兜底）
5. 完整的测试体系与行为 fixtures

系统名称统一为 **Nodeflow**。

---

## 2. 产品命题与设计立场

产品只做一件事：

> **把长任务切成多个短上下文的 agent 执行，用边编排它们，用版本化产物缝合它们，避免单 agent 上下文膨胀与注意力涣散。**

由此产生的设计立场（全部必须落实）：

1. 上下文压缩是失败信号：任何节点发生压缩，说明图切错了；压缩次数是一等可观测指标。
2. 编排面存在的理由是精确构造每一次 agent 调用的上下文。
3. 产物必须版本化：返工循环没有版本锚点就无法比较、回滚、复现。
4. 模型不做编排决策：编排由人在画布上排布，策略节点按配置执行，模型只在预先声明的选项中选择。
5. 执行面后端只是"租用推理循环"：给定编译好的上下文和声明好的工具，跑一轮模型+工具，返回结果；会话历史、版本、恢复、并行、快照全部由编排面自有，不依赖任何 harness 的会话存储。

四个面的划分，架构的每一行代码都要归属其中一面：

```
装配面：卡片（skill/mcp/rules/prompt）→ 编译 AgentSpec（模型、工具全集、五段 prompt）
编排面：图/节点/边/策略/Servo/消息/提交/快照 —— 确定性、可回滚、毫秒级
执行面：模型执行、工具调用、审批、流式、取消、预算 —— 分钟级、有副作用、不可回滚
控制面：助手 AI / 画布 / MCP —— 把装配+编排+执行封装成工具，把人当用户
```

---

## 3. 技术决策（不可更改）

- **全 TypeScript**：Node ≥ 20，strict，ESM，pnpm workspace。
- **画布自研**：React/Vite 只做应用外壳；图表面（数据模型、渲染、交互）完全自研 SVG，**不得引入 React Flow、Vue Flow、X6、LogicFlow 等任何现成画布库**。
- **后端 Fastify**：schema-first、Zod 校验、`@fastify/websocket`、pino 日志。
- **存储 SQLite 起步 + PostgreSQL 接口预留**：Repository 抽象，两个方言从第一天都跑契约测试；SQLite 用 better-sqlite3 + WAL；迁移用 drizzle-kit。
- **执行面 in-process 优先**：pi（低层 `Agent`，不用其高层 harness）与 OpenAI 兼容 driver 在 TS 内核进程内直连；保留子进程适配器与线协议给 CLI 型 backend。
- **单运行时**：不设计分布式、不做 broker/ACK/lease；单进程内调度，冲突域节点级。

---

## 4. 完整理想架构（monorepo）

```
packages/
├─ contracts/              # Zod 单源 → GraphTemplate JSON Schema / OpenAPI / WS 协议
├─ kernel/                 # 内核：core/definitions/budget/scheduling/
│                          #   projections/control/presets/kernel-tools
├─ store/                  # Repository 接口 + sqlite/ + postgres/ + migrations
├─ server/                 # Fastify：routes/ ws/ auth/ mcp/ runtime-service
├─ execution/              # pi/ openai-compat/ subprocess/ tool-executors/ managed-backend
├─ canvas/                 # 自研图表面：model/commands/renderer/interaction/validate
└─ webapp/                 # React/Vite 外壳：editor/ dashboard/ api-client
fixtures/                  # 行为场景 JSON（内核回归测试的共享输入）
scripts/                   # schema 生成、迁移、开发启动
```

数据流向：

```
画布（React shell + 自研 SVG engine）
   │ REST：draft/template/instance/control   │ WS：实例/消息/execution 事件流
   ▼
Fastify Server（auth 注入 Principal → RuntimeService → 内核调度）
   │ Repository                    │ ExecutionBackend
   ▼                               ▼
SQLite / Postgres           pi · openai-compat · subprocess
```

---

## 5. 核心工程概念与不变量（必须原样实现）

### 5.1 第一不变量

> **Agent 只能在预先声明的选项中选择，永远不能构造地址、能力或契约。**

落点：`OutputContract.allowed_emit_ports` 是枚举；agent 的工具集编译期声明完整；`publish_topics`/`spawn_slots` 只有 agent 节点声明后才注入内核工具；运行时 emit 端口、topic、slot 都必须命中枚举，否则拒绝提交并进入失败通道。

### 5.2 消息三不变量

- **M1 编排权威属于边**：消息送达已声明端点后，路由完全由边接管；消息 payload 不得携带 `edgeId` 等下游边选择。
- **M2 队列是独立索引空间**：topic 地址与图拓扑正交，同图不连边的节点经 topic 通信合法。
- **M3 callback 落回已声明端点**：REPLY 投递到发起方声明端点，由边接管；callback 不重选边、不构造地址。

### 5.3 版本四不变量

1. 版本号只由 ObjectStore 分配，backend 只提交内容 `(kind, objectId, body)`。
2. ObjectVersion 独立于 GraphInstance，实例关闭/重建不影响版本。
3. 内容寻址幂等，同内容同版本。
4. 运行引用只接受精确版本 `objectId@version`，拒绝 latest 与负版本/越界版本。

### 5.4 终态不变量

- 实例状态机：`OPEN → {PAUSED, CLOSED}`、`PAUSED → OPEN`；**CLOSED 是终态**，拒绝 pause/resume、新消息、新订阅、新子实例、审批路由、on_error 路由；重复 close 幂等。
- 提交气密：执行期间实例被 close，或在途 claim 的节点版本被更新，结果作废，输入 FAILED，绝不向 CLOSED 实例制造死信；模型 evaluator 与 agent 同规。
- 控制走授权路径并留提交事实：actor 是 `Principal{kind: human|agent|system|service, id}`，由可信边界注入，payload 自封身份一律无效。

### 5.5 上下文不变量

- `InvocationContext = {head[], messages[], tail[], transient[], meta[]}`，每次 agent 调用重新编译，无隐藏会话历史。
- head 实例化前固定且永不裁剪；tail 运行期经批准追加、不回写模板；transient 本轮清空；messages 至少保留一条。
- 工具/系统前缀编译期定型并生成 `prefix_hash`，运行期发现只追加到 tail，不得改变前缀（缓存稳定）。
- 预算在调用前校验；裁剪顺序 `transient → tail → messages`；head 自身超预算直接失败；裁剪与压缩同级告警。

---

## 6. 领域模型与数据契约（内核直接按此实现）

### 6.1 定义层

`GraphTemplate`（发布不可变，版本 `templateId@1…`）：

```jsonc
{
  "template_id": "export-flow",
  "nodes": {
    "plan": {
      "kind": "agent",                       // agent|plain|strategy|approval|subflow|start|end
      "spec": "planner",                     // agent 引用已编译 AgentSpec
      "handler": "…",                        // plain/strategy 引用服务端注册 handler
      "policy": "fanout@1",                  // strategy 引用 policy
      "evaluator": {"kind": "model", "spec": "judge"},   // strategy 可选模型判断
      "publish_topics": {"skill.discovery": "io"},       // agent 可选：topic→回调端点
      "spawn_slots": ["workers"],            // agent 可选：可实例化的 slot 白名单
      "on_error": "err",                     // 失败端口（可选）
      "authorized_actors": ["human:alice"],  // approval
      "approve_port": "out", "deny_port": "denied",
      "slot": "reviewers", "return_port": "out",         // subflow
      "emit": "out",                         // start
      "endpoints": {
        "io":  {"receive": {"PUSH": {"contract": "Task@1"}}},
        "out": {"emit":    {"PUSH": {"contract": "Plan@1"}}}
      }
    },
    "end": {"kind": "end", "endpoints": {"io": {}}}
  },
  "edges": [
    {"id": "e1", "from": "plan.out", "to": "code.io",
     "operation": "PUSH", "servo": "plan2code@1"}
  ],
  "slots": {
    "reviewers": {
      "template": "review-flow@1",
      "instantiation": "PER_CALL",           // PER_CALL|WARM_POOL(n)|SINGLETON
      "entry": "work.io",
      "exit": {"endpoint": "work.out", "contract": "Review@1"}
    }
  },
  "subscriptions": [{"topic": "progress", "endpoint": "metrics.io"}],
  "strict_contracts": false
}
```

规则：
- 节点 kind 七种，**没有 checkpoint**（循环锚点是 strategy 配置 + annotation）。
- 端点统一：方向来自本次 operation，不区分永久 input/output 两类；未声明契约 = 未约束。
- 边只支持 `PUSH`；`end` 是终态汇点，只进不出。
- 连接期校验在模板注册时完成：源 emit 契约 → Servo 符号推演 → 目标 receive 契约，缺失必需字段即拒，错误信息 LLM/画布可读。
- 所有引用精确到版本。
- `_layout` 是独立顶层文档（坐标/尺寸/折叠/视口/分组），不进入语义校验与版本指纹。

其他定义对象：`JsonTransformDefinition`（单一类型 + `role` 枚举 + role→能力矩阵，边只认 `EDGE_SERVO`；Servo 只允许 `set/map/drop`）；`StrategyPolicy`（readiness `ANY|ALL_REQUIRED`，selection `FIRST|TOP_ONE|ONE_PER_INPUT|CROSS_ALL`，output `EMIT_EACH|WAIT_ALL|CROSS|FANOUT_TO_SLOT`）；`TopicDefinition`（request/reply contract，运行期取值校验）；`MessageContract`（不可变 JSON Schema 子集：type/properties/required/additionalProperties/items/enum/const/pattern）。

### 6.2 实例与消息

- `GraphInstance`：唯一工作身份；持有 status(`OPEN|PAUSED|CLOSED`)、seq、params、head、children、pool_cursor、overflow、controllers；节点单例（循环不重复实例化）。
- `NodeInstance`：`persistentState`（长期，epoch/策略状态）+ `tail` + `transient` + `version`（节点级冲突域）+ `sessionHandle`（不透明缓存）。
- `MessageInstance`：`{messageId, target(gid,nodeId,endpoint), payload, state, callback?, topic?, mkind, attempts, exitPort?, requestId?}`；状态 `QUEUED→CLAIMED→CONSUMED`，审批暂停 `AWAITING`，失败终态 `FAILED`。
- `ExecutionRecord`：claim/execute/apply 的持久事实，崩溃接管唯一依据。
- 子流程：slot 只绑定已存在 child；`PER_CALL/WARM_POOL(n)/SINGLETON`；WARM_POOL 只复用执行资源，承接前清空 `persistentState`、`tail`、`sessionHandle`、`lastContext`；服务式复用 = 长期 OPEN 实例 + 订阅，无新对象。
- 队列：`QueueInstance` 是 topic 的运行期投影；订阅 `(topic) → (gid,node,endpoint)`，运行期可增删，不产生图内边；取消订阅是持久化删除。

### 6.3 版本层

`ObjectStore` 单例分配版本；`ObjectVersion{objectId, version, kind, contentHash, body, provenance}`；`Provenance{graphInstanceId?, nodeId?, executionId?, atSeq, derivedFrom[]}`。Annotation 与 RunSnapshot 都是普通 ObjectVersion（kind=`annotation` / `run`）；内核 kind 归内核独占，backend artifacts 不得伪造。

### 6.4 执行面契约

```ts
interface ExecutionRequest {
  executionId: string;
  agentSpec: {specId; model; cardRefs; systemPrompt; tools[]; kernelTools[]; prefixHash};
  context: {head[]; messages[]; tail[]; transient[]; meta[]};
  origin: [gid, nodeId];
  workspace: {root: string};
  outputContract: {schema: JsonSchema; allowedEmitPorts: string[]};
  limits: {tokenBudget?; wallClockSeconds?; maxToolCalls?};
  resumeHandle?: unknown;
}
interface ExecutionResult {
  executionId: string;
  emissions: {port, payload}[];
  artifacts: {kind, objectId, body}[];
  usage: {inTokens; outTokens; cost; wallClockSeconds; toolCalls; compactions};
  termination: "DONE"|"CANCELLED"|"BUDGET"|"INVALID_OUTPUT"|"FAILED";
  sessionHandle?: unknown;
  observations: unknown[];
  diagnostics?: Record<string, unknown>;
}
```

---

## 7. 内核实现细节

### 7.1 模块职责

- `core.ts`：Principal、ObjectStore、ObjectVersion、InvocationContext、ExecutionRequest/Result、内部状态类型、错误分类（`InvariantError`=编程错误立即抛；运行时异常进失败通道）。
- `definitions.ts`：卡片/spec/模板/契约/Servo/policy/topic/订阅的注册、快照、连接期校验；所有注册数据 `structuredClone` 入库、`deepFreeze` 出库（深只读）。
- `budget.ts`：token 估算（拉丁/CJK 分密度）、head 永不裁剪、预算调用前拒绝、裁剪告警。
- `scheduling.ts`：锁内选活+claim → 锁外 execute → apply；apply 校验 OPEN + 节点版本；原子提交（先 prepare 全部端口与边，再 materialize，失败零副作用）；`on_error` 进图；模型 evaluator 与 agent 同规。
- `projections.ts`：只读查询返回副本/frozen，不暴露可写引用。
- `control.ts`：ControlPlane 工具 schema + dispatch；所有写操作留版本/快照事实。
- `presets.ts`：fanout/review/fixed_rounds/threshold_loop/approval 片段。
- `kernel-tools.ts`：`read_artifact`（恒可用，精确引用，返回深拷贝 body）、`publish`（topic 必须在 `publish_topics` 枚举，callback 落回声明端点，共享 request_id）、`spawn`（slot 必须在 `spawn_slots` 枚举，实例化后投递 entry）；分发前校验 execution RUNNING + 实例 OPEN + 工具名在声明集。

### 7.2 并发与调度

- 单进程；claim/apply 是同步临界区，execute 是锁外 async。
- 每 `(gid, nodeId)` 一个 async 信号量：同节点串行，跨节点/跨实例并行。
- 冲突域 = NodeInstance + 被消费消息集合：claim 推进 node version，apply 比对 base version，不一致则作废重试。
- 失败分类：CANCELLED/BUDGET 不重试、消息回 QUEUED；FAILED 按 `maxAttempts` 重试；耗尽经 `on_error` 沿边进图，未声明则 FAILED 终态；backend 抛异常按 FAILED 处理；handler 抛异常转失败快照，禁止消息滞留 CLAIMED。
- seq 只由 apply/control 推进；claim 只写 ExecutionRecord，不制造 run seq 空洞。
- `ExecutionLimits` 由统一 `ManagedBackend` wrapper 强制：token_budget 调用前、wall_clock/max_tool_calls 执行中。

### 7.3 持久化

- 对象表 append-only；运行状态（instances/nodes/messages/records/subscriptions）每次提交在同一事务 upsert。
- claim/release/订阅增删都是提交边界，必须立即落盘。
- unsubscribe 是删除/tombstone，重启不得复活。
- Repository 接口不得泄漏 SQLite 类型：

```ts
interface ObjectRepo { append(ov): void; get(oid, ver); head(oid); history(oid); lineage(ref); }
interface RuntimeRepo {
  saveInstance(i); saveMessage(m); saveRecord(r); saveSubscription(s);
  deleteSubscription(sid); restore(): RuntimeSnapshot;
}
```

---

## 8. 后端服务实现细节

### 8.1 Fastify 服务

- REST 域：`cards`（注册/搜索）、`specs`（编译）、`drafts`（CRUD/validate/publish）、`templates`（版本历史/按 ref 取）、`contracts/topics/policies/transforms`、`instances`（创建/send/run/control/state/messages/executions/runs）、`objects`（版本/历史）、`annotations/search`、`subscriptions`、`control/dispatch`。
- 所有状态变化走命令端点并落 RunSnapshot；GET 只读。
- `POST /instances/:gid/run` 创建后台 run 任务返回 runId，不阻塞；同实例重复 run 幂等返回已有任务；pause 取消 RUNNING execution（消息保留）；close 走终态守卫。
- auth 中间件把会话/服务账户映射为 Principal；定义写操作也记录 principal 审计字段。

### 8.2 WebSocket 事件总线

```jsonc
// client→server
{"type":"subscribe","channels":["instance:gi-1","topic:t","execution:exec-1"]}
{"type":"unsubscribe","channels":["instance:gi-1"]}
// server→client
{"type":"event","channel":"instance:gi-1","seq":42,
 "payload":{"kind":"message.created","messageId":"msg-1","state":"QUEUED"}}
```

事件种类：`instance.status`、`message.created/claimed/consumed/failed`、`execution.claimed/running/applied/cancelled/failed`、`commit.snapshot`、`queue.depth`、`control.applied`、`error`。事件持久化（channel+seq），断线重连支持回放，首版保留 24h。

### 8.3 MCP

stdio JSON-RPC 2.0：`initialize/ping/tools/list/tools/call`；工具 schema 与 ControlPlane 同源；actor 由 `NODEFLOW_MCP_ACTOR` 注入；工具参数里的 actor/proposer 一律忽略。

---

## 9. 执行面实现细节

- `ExecutionBackend { run(req): Promise<ExecutionResult>; cancel(id): Promise<void> }`。
- `ManagedBackend` 包裹所有 backend：强制 limits、INVALID_OUTPUT 重试、事件采集、异常→FAILED 分类。
- pi：低层 `Agent`；`agent.state.systemPrompt` 完全替换、`agent.prompt(messages)` 外来历史、`transformContext` 恒不压缩、`beforeToolCall` 拦截未声明端口/工具、`AgentTool.execute` 承载内核工具桥；usage 事件不暴露时如实报 0，不伪造。
- OpenAI 兼容：自实现 chat loop；工具集 = `{emit} ∪ declared tools ∪ kernelTools`，一个不多；未声明工具调用返回错误给模型。
- 工具执行器：`read_file/write_file/list_dir/run_shell`；工作区根强制（resolve 后必须在 root 内）；run_shell 需环境变量显式开启；输出截断、超时。
- 子进程线协议：下行 `run/cancel`；上行 `event/observation/kernel_tool/result/error`；内核工具回调 `kernel_tool → kernel_tool_result`。
- 探针判据：★必控 A1 system prompt 可替换、A2 历史外来、A3 可禁用压缩、D1 可不使用其会话存储；◇宜控工具集/拦截/取消/预算；○观测内部 tool 与流式。断言断 backend 能力，不断模型顺从度。

---

## 10. 画布前端实现细节（自研，融合成熟节点编辑器已验证的共性）

### 10.1 总体结构

```
React/Vite app-shell（webapp）
 └─ canvas-engine（packages/canvas，零 React 依赖）
     ├─ model:        GraphDocument / NodeView / EdgeView / LayoutDocument
     ├─ commands:     AddNode/MoveNodes/ConnectPorts/SetProperty/RemoveNodes…
     ├─ renderer:     SVG（grid → edges → nodes → ports → selection → overlay）
     ├─ interaction:  pointer 状态机（idle/pan/dragNode/dragEdge/marquee）
     └─ validate:     本地 JSON Schema 校验 + 服务端错误投影
```

### 10.2 核心数据模型

```ts
interface GraphDocument {
  version: 1;                          // 序列化版本，迁移入口
  semantic: GraphTemplate;             // 后端语义 JSON，唯一真相源
  layout: LayoutDocument;              // 坐标/尺寸/折叠/视口/分组，独立文档
}
interface LayoutDocument {
  nodes: Record<string, {x;y;width?;height?;collapsed?}>;
  edges?: Record<string, {controlPoints?}>;
  viewport: {x;y;zoom};
  groups?: Record<string, {x;y;width;height;title}>;
}
```

- 模型与渲染分离：model/commands 纯 TS 可单测；renderer 只读投影。
- type 注册表：`kind ↔ 默认端点/schema/图标/颜色/校验器` 三合一注册；未知 kind 渲染虚线占位节点。
- 序列化前清理 `selected/hover/runtimeStatus` 等瞬态字段；反序列化两遍（先节点后边）。
- 画布保存只写 draft；发布才产生模板版本；拖动坐标只改 `_layout`，绝不产生新模板版本。

### 10.3 端口与连线

- 端口 id 语义化 `nodeId.endpointName`；方向可视化：emit 实心圆在右、receive 空心圆在左。
- 端口类型 = 端点 contract ref；颜色由**单一查色函数**按 contract kind 映射（plan 靛蓝 / code 青 / review 紫 / error 红 / 无契约灰），端口圆点、预览线、选中态三处共用。
- 默认三次贝塞尔；预览线颜色随源端口类型；非法连接预览为实心红线。
- **三阶段连线校验**：起点 magnet（只允许合法端口起线）→ 拖动悬停吸附（24px）→ 落点校验（方向相反、非自连、非重复、仅 PUSH、end 无出边、Servo 后字段相容）。
- 边命中：3px 主线 + 20px 透明加宽路径；选中态显示 `源契约 → Servo → 目标契约` 链。

### 10.4 交互与渲染

- 指针状态机：`idle / pan / dragNode / dragEdge / marquee`；一次拖拽一个 State，进入记录初值、结束 eject。
- 基础交互：节点拖拽、滚轮缩放（光标锚点）、空白平移、网格吸附 16px（可开关）、Delete 删除、Esc 取消、Ctrl+Z / Ctrl+Shift+Z。
- undo/redo = 命令对象；Move 命令合并；栈上限 200。
- 节点用**通用 schema 驱动渲染**，不为每类节点写专属组件：标题栏（kind 色+图标+id）→ 可编辑字段白名单 → 端口列。
- kind 配色：agent 蓝 / plain 灰绿 / strategy 琥珀 / approval 紫 / subflow 青 / start 绿 / end 红。
- 运行状态覆盖：RUNNING 蓝色脉冲、CLAIMED 黄、APPLIED 绿、FAILED 红框、PAUSED 灰；节点下方状态徽章 `{fill, shape: dot|ring, text<20}`；错误进气泡。
- 性能：视口裁剪 + 脏标记重绘；目标 500 节点 / 1000 边流畅。

### 10.5 运行观测闭环

- WS 事件 → `ExecutionStore{running, progress, errors}` → 订阅者重渲染；store 不写回 semantic JSON。
- 消息面板按 messageId 流式追加状态与 payload 摘要；execution 面板显示 claim→apply 时间线、usage、trims。
- `usage.compactions > 0` 与 `context_trims` 红点告警。
- 子流：subflow 节点显示 slot 徽章；"进入子流"用 in/out 端口节点 + 面包屑导航（数据模型直接支持，首版 UI 可简化）。

---

## 11. 测试与验收体系

1. 行为 fixtures：`fixtures/*.json` 描述场景（卡片、模板、topic、消息序列、期望状态），覆盖 PUSH 扇出、Servo、CALL/REPLY、四种 selection、WAIT_ALL/CROSS/FANOUT、并发冲突、close/pause、崩溃接管、内核工具桥、契约失败。内核测试把 fixture 运行结果与期望 trace 逐行比对；trace 规范化：id 归一化（`gi-N/msg-N/exec-N` 映射），移除时间戳与随机序。
2. 内核单测：每个不变量至少一条测试；每个失败路径至少一条测试；每个策略模式至少一条测试。
3. 存储契约测试：SQLite 与 Postgres 跑同一套 Repository 测试（testcontainers）。
4. 服务契约测试：REST/OpenAPI/WS 事件顺序/auth 拒绝路径。
5. 画布测试：commands 单测 + Playwright 端到端（拖节点→连线→保存→发布→实例化→运行→观测状态变化；undo/redo 200 步无状态损坏）。
6. 真实模型测试独立 profile，不阻塞常规 CI；断言断 backend 能力（能否接受外来历史、会不会擅自压缩、有没有隐藏状态），不断模型顺从度。
7. 完成定义：`pnpm -r test` 绿；fixtures 全部通过；SQLite/Postgres 双绿；Playwright 最小闭环绿。

---

## 12. 工程注意事项与红线

1. **许可红线**：ComfyUI（GPL-3.0）、Blender（GPL-2.0+）、Rete.js scopes 插件（CC-BY-NC-SA）的设计思想可参考，代码不得复制；MIT/Apache 项目可借鉴。
2. **不引入现成画布库**；画布只参考成熟项目的架构模式（type 注册表、模型渲染分离、纯 JSON 序列化、三阶段校验、状态机交互、执行状态闭环）。
3. **深只读**：卡片/模板/契约 `structuredClone` 进、`deepFreeze` 出；ObjectVersion body 内容哈希用 stable stringify。
4. **精确引用**：运行中禁止 latest；ObjectStore 拒绝负数/越界版本。
5. **终态不可复活**：任何路径不得 CLOSED→PAUSED/OPEN；晚到提交必须被拒并留痕。
6. **画布不藏语义状态**：运行时高亮/选中/错误只存内存或 `_layout`。
7. **密钥**：只读环境变量；任何真实 API key 不得出现在源码、示例或测试中；交付报告提醒使用密钥轮换。
8. **内核工具只能回调内核**：driver 不得本地实现 publish/spawn/read_artifact。
9. **压缩是失败信号**：compactions>0 永远告警呈现。
10. **控制留事实**：pause/resume/close/approve 都是提交记录，不是旁路 API。
11. **一次构建全量仓库**：按依赖关系实现（contracts → kernel/store → server/execution → canvas/webapp → fixtures），交付时所有包共存于同一 monorepo 且全部命令可运行。

---

## 13. 交付要求

完成时当前工作目录必须满足：

1. `pnpm install && pnpm -r test` 绿。
2. 全部行为 fixtures 通过。
3. SQLite 与 Postgres 存储契约测试都绿。
4. `pnpm dev` 一条命令启动 server + webapp；浏览器打开画布即可完成：拖节点→连线→保存→发布→实例化→运行→看到节点状态/消息/execution 实时变化。
5. MCP 可被标准客户端连接并列出全部控制工具。
6. 交付报告包含：完成清单、架构图、契约说明、测试证据、已知限制、启动方式。

如果遇到与本提示词冲突的事实或阻塞，停下来在报告中说明冲突点，不得自行放宽红线。
