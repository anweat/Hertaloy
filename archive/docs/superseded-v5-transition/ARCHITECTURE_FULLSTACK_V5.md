# Nodeflow V5 —— 全量前后端架构与实施计划

> 状态：**架构与计划稿（2026-08-15）**。依据上一轮批判性审查 + 内核 P0 修复结果。
> 可直接投喂给无上下文 agent 的完整构建提示词见 [PROMPT_FULLSTACK_BUILD.md](./PROMPT_FULLSTACK_BUILD.md)。
>
> 决策前提（已确认）：
> - **全 TypeScript 重写**：Python V4 降级为黄金参考实现（golden oracle），行为证据继续保留。
> - **自研 SVG/Canvas 画布**：应用外壳仍用 React/Vite，自研部分限定为"图表面"（canvas model / renderer / interaction）。
> - **首个里程碑 = 最小闭环**：画布编辑 → 保存 → 运行 → 观测。
> - **SQLite 起步 + PostgreSQL 接口预留**：Repository 抽象从第一天就双 dialect 验证。

---

## 0. 决策记录（ADR）

| # | 决策 | 理由 | 代价与约束 |
|---|---|---|---|
| ADR-1 | 编排/控制/装配全部迁 TypeScript | 执行面 pi/openai 已是 TS，语言边界（JSON 子进程）与 `transformContext`/`beforeToolCall` 等内核接口本应同语言；HARNESS_EVALUATION §4.1 的 A 案终局 | 重写 300+ 条行为测试；Python 只作 oracle，禁止"顺手重新设计" |
| ADR-2 | 画布自研 SVG 图表面，React 外壳 | 用户选定；首版只需节点/边/端口/平移缩放/undo | React Flow 等库不引入；canvas model 必须与 React 解耦，可单测 |
| ADR-3 | 首个里程碑只做最小闭环 | 最快验证"真实画布 + 真实后端 + 真实执行"这条链路 | 卡片库/审批/模板 diff/多实例优化进入 M4+ |
| ADR-4 | Repository 抽象 + SQLite 首发，Postgres 接口预留 | 单机开发成本最低；与现有 SQLite 语义（append-only + 全量 upsert）衔接最顺 | 从 M2 起 SQLite/Postgres 双实现并行过契约测试，禁止只写方言 SQL |

---

## 1. 目标与非目标

### 目标（首个可交付版本 V5.0）

1. 画布上可视化排布节点、边、策略、槽、订阅，生成**合法 GraphTemplate JSON**。
2. 保存 draft、校验、发布模板版本（`id@1…`），`_layout` 与语义分离、无损往返。
3. 从画布实例化运行图，实时看到：节点状态、消息投递、execution 状态、RunSnapshot、错误与 on_error 路由。
4. 真实模型执行（pi / OpenAI 兼容）在 TS 进程内直连，内核工具桥（emit / read_artifact / publish / spawn）可用。
5. 控制面（pause / resume / close）与人工审批节点可用。

### 非目标（首版明确不做）

- 分布式调度、跨进程 broker、ACK/lease、多租户。
- 服务式子流程实例池的运行时动态扩容 UI（内核已有，画布只展示）。
- 卡片库 / skill 市场的完整 UI。
- 可视化模板 diff、复杂群组、小地图之外的高级画布能力。
- 把 Python V4 当作生产后端继续演进（冻结为 oracle）。

---

## 2. 设计原则（继承 FOUNDATION_V4，并新增 TS 期约束）

1. 四个面：装配 / 编排 / 执行 / 控制。执行面只接收 `ExecutionRequest`，只返回 `ExecutionResult`。
2. 边是编排主干；topic 是与拓扑正交的独立索引空间（M1–M3）。
3. Agent 只能选，不能构造：端口、topic、slot、工具全部编译期声明。
4. 单运行时：首个版本单进程、单 SQLite；Postgres 只改变 Repository 实现，不改变内核语义。
5. **Python 是 oracle，不是草稿**：TS 每模块必须有对照测试；任何"顺手改进"必须先改 Python + 测试，两边同步，否则记为 deferred。
6. 契约先行：GraphTemplate JSON Schema v1、OpenAPI、WS 事件协议先冻结，三个工作流并行不互相等。
7. TS 内核继续修掉审查轮 P1（定义层原子性、深只读、emit 端口精确语义、limits 执行、快照 seq 语义），不在 TS 里复制已知 bug。
8. 画布只是语义 JSON 的视图：画布状态永远可重建，真相源只有 `GraphTemplate + _layout`。

---

## 3. 系统总览

```
┌────────────────────────────────────────────────────────────────┐
│ 画布前端（React/Vite）                                          │
│  app-shell · editor · palette · inspector · run-dashboard       │
│  canvas-engine（自研：model/commands/renderer/interaction）      │
└───────────────┬────────────────────────────────────────────────┘
                │ REST（CRUD/命令） + WebSocket（事件流）
┌───────────────▼────────────────────────────────────────────────┐
│ Nodeflow Server（Fastify + TypeScript）                          │
│  API 层：draft/template/card/instance/object/control            │
│  信任边界：Principal 注入（session/服务账户），payload 不自封     │
│  RuntimeService：定义注册表 + 实例调度 + 提交 + 快照             │
│  MCP stdio server：给顶层助手 AI（复用 ControlPlane 工具层）      │
└──────┬──────────────────────────────┬──────────────────────────┘
       │ Repository 接口              │ ExecutionBackend 接口
┌──────▼──────────────┐   ┌──────────▼───────────────────────────┐
│ SQLite（首发）       │   │ pi（in-process）                      │
│ Postgres（接口预留） │   │ openai-compat（in-process）           │
│ objects / runtime   │   │ subprocess CLI（通用 escape hatch）    │
└─────────────────────┘   └──────────────────────────────────────┘
```

进程边界策略：

- **pi 与 OpenAI 兼容 driver 在 TS 内核进程内直连**：取消 ADR-3 之前的 JSON 子进程边界；`transformContext`、`beforeToolCall`、`AgentTool.execute` 直接是内核代码。
- **保留 SubprocessBackend + 线协议**：给 Claude Code CLI、Codex 等"只能子进程"的 backend 与测试探针。内核工具桥在 in-process 模式是直接 async 调用；subprocess 模式继续用 `kernel_tool ⇄ kernel_tool_result` 线协议（V4 已实现，TS 按同协议重写）。

---

## 4. 仓库布局（monorepo）

```
Hertaloy/
├─ py_oracle/                    # 冻结的 Python V4（不删，不进生产路径）
│   └─ (nodeflow_*.py + test_*.py 现有全部内容)
├─ packages/
│   ├─ contracts/                # GraphTemplate JSON Schema、事件协议、OpenAPI
│   │   ├─ schemas/*.json
│   │   └─ src/ (zod → json-schema 生成器、TS 类型)
│   ├─ kernel/                   # TS 内核（黄金测试逐模块移植）
│   │   ├─ core.ts               # Principal/ObjectStore/ExecutionRequest/Result/内部结构
│   │   ├─ definitions.ts        # 卡片/spec/模板/契约/Servo/policy/订阅/连接期校验
│   │   ├─ budget.ts             # 上下文预算与裁剪
│   │   ├─ scheduling.ts         # claim/execute/apply、失败进图、并发调度
│   │   ├─ projections.ts        # 只读投影
│   │   ├─ control.ts            # ControlPlane 工具层（MCP schema 形状）
│   │   ├─ presets.ts            # fanout/review/fixed_rounds/threshold/审批
│   │   └─ kernel-tools.ts       # read_artifact/publish/spawn 声明与分发
│   ├─ store/                    # Repository 接口 + 迁移
│   │   ├─ repo.ts               # ObjectRepo/RuntimeRepo/SubscriptionRepo 接口
│   │   ├─ sqlite/               # better-sqlite3 实现（首发）
│   │   ├─ postgres/             # pg 实现（接口预留，M2 起双测）
│   │   └─ migrations/
│   ├─ server/                   # Fastify 服务
│   │   ├─ routes/               # REST
│   │   ├─ ws/                   # WebSocket 事件总线
│   │   ├─ auth/                 # principal 信任边界
│   │   └─ mcp/                  # stdio MCP server
│   ├─ execution/                # ExecutionBackend 实现
│   │   ├─ pi/                   # pi-agent-core 直连
│   │   ├─ openai-compat/        # 原 openai_compat_driver 迁入
│   │   ├─ subprocess/           # CLI 子进程适配 + 线协议
│   │   └─ tool-executors.ts     # read_file/write_file/list_dir/run_shell
│   ├─ canvas/                   # 自研画布（纯 TS，框架无关）
│   │   ├─ model/                # GraphDocument/LayoutDocument/geometry
│   │   ├─ commands/             # undo/redo 命令对象
│   │   ├─ renderer/             # SVG renderer + viewport
│   │   ├─ interaction/          # pointer/keyboard 状态机
│   │   └─ validate/             # 前端预校验 + 服务端错误映射
│   └─ webapp/                   # React/Vite 外壳
│       ├─ editor/               # 画布工作台
│       ├─ dashboard/            # 运行观测（消息/execution/快照）
│       └─ api-client/           # OpenAPI 生成 + WS client
├─ fixtures/                     # 黄金 parity 场景（两语言共用 JSON）
├─ scripts/                      # oracle 比对、schema 生成、迁移
├─ package.json                  # pnpm workspace 根
└─ docs/                         # 本文档 + V4 文档保持可追溯
```

包管理器：pnpm workspace；语言：Node ≥ 20、TypeScript strict、ESM。
不引入 monorepo 构建编排器（turborepo 等）直到仓库出现明显构建瓶颈。

---

## 5. 契约层（先冻结，后开发）

### 5.1 GraphTemplate JSON Schema v1

从 Python `_validate_template/_validate_edges` **反向提取**，作为画布、LLM、后端三方唯一契约。要点：

- 顶层：`template_id?`、`nodes`、`edges`、`policies?`、`slots?`、`subscriptions?`、`topics?`、`strict_contracts?`、`_layout`（独立文档，不参与语义指纹）。
- `NodeDefinition`：`kind ∈ agent|plain|strategy|approval|subflow|start|end`；统一 `endpoints: {ep: {receive/emit: {PUSH: {contract}}}}`；agent 的 `publish_topics` / `spawn_slots`；strategy 的 `policy`、`evaluator`、`on_error`；subflow 的 `slot`、`return_port`；approval 的 `authorized_actors`、`approve/deny_port`。
- `EdgeDefinition`：`id`、`from`、`to`、`operation=PUSH`、`servo`；end 无出边。
- 所有引用（template/contract/transform/policy/topic）只接受精确版本 `id@n`。
- schema 附带 `x-nodeflow-error` 注释，校验错误必须 LLM/画布可读（沿用现有中文错误风格）。

生成方式：`packages/contracts` 用 **Zod** 写单一定义 → `zod-to-json-schema` 产出 JSON Schema → 画布与 MCP 读取同一份；不手写双份。

### 5.2 REST/WS 契约

- OpenAPI 3.1 由 Fastify schema 生成，`webapp/api-client` 用 openapi-typescript 生成类型。
- WS 事件协议：

```jsonc
// client → server
{"type":"subscribe","channels":["instance:gi-1","topic:skill.discovery","execution:exec-1"]}
{"type":"unsubscribe","channels":["instance:gi-1"]}

// server → client
{"type":"event","channel":"instance:gi-1","seq":42,
 "payload":{"kind":"message.created","messageId":"msg-1","state":"QUEUED"}}
{"type":"event","channel":"execution:exec-1","seq":43,
 "payload":{"kind":"execution.applied","record":{...}}}
```

事件种类（首版全集）：`instance.status`、`message.created/claimed/consumed/failed`、`execution.claimed/running/applied/cancelled/failed`、`commit.snapshot`、`queue.depth`、`control.applied`、`error`。

### 5.3 迁移与兼容

- 冻结 V4 的线协议（`run/cancel/result/event/observation/kernel_tool/kernel_tool_result`），TS SubprocessBackend 与 Python driver 探针可以互测。
- ExecutionRequest/Result 结构保持 JSON 兼容；仅把 `control` 字段按 HARNESS_EVALUATION §1.1 定稿（cancel 走 backend.cancel，stream 走事件回调）。

---

## 6. TS 内核设计

### 6.1 模块映射（移植即测试，不是翻译即完事）

| Python（oracle） | TS（kernel） | 对照测试 |
|---|---|---|
| nodeflow_core.py | core.ts | test_kernel_contracts 迁移 + 类型级测试 |
| nodeflow_definitions.py | definitions.ts | test_foundation_v4 A/B/H、test_contracts、test_definition_guard |
| nodeflow_budget.py | budget.ts | test_context_budget |
| nodeflow_scheduling.py | scheduling.ts | test_foundation_v4 B–G、test_closed_loop、test_robustness |
| nodeflow_projections.py | projections.ts | test_annotation_search、test_card_library |
| nodeflow_persistence.py | store/sqlite/* | test_persistence、test_kernel_hardening C/P/U |
| nodeflow_control.py / nodeflow_mcp.py | control.ts + server/mcp | test_definition_approval、test_mcp |
| nodeflow_adapters.py | execution/subprocess | test_probes |
| nodeflow_presets.py | presets.ts | test_presets |

### 6.2 关键类型（TS 终版，允许结构改进但不改行为）

```ts
type Termination = "DONE"|"CANCELLED"|"BUDGET"|"INVALID_OUTPUT"|"FAILED";
interface ExecutionRequest { executionId; agentSpec; context; origin;
  workspace; outputContract; limits; resumeHandle? }
interface ExecutionResult { executionId; emissions; artifacts; usage;
  termination; sessionHandle?; observations; diagnostics }
interface ExecutionBackend {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
}
type Principal = {kind:"human"|"agent"|"system"|"service"; id:string};
interface ObjectVersion {objectId; version; kind; contentHash; body; provenance}
```

### 6.3 并发模型（TS 单进程）

- claim/apply 是同步临界区（单线程天然原子）；**execute 是 async，锁外运行**，对应 Python 的 `drain_concurrent`。
- 每 `(graphInstanceId, nodeId)` 一个 async 信号量，禁止同节点并发 claim；不同节点/不同实例可并发执行。
- 冲突域仍是 `NodeInstance + 被消费消息集合`：claim 时推进 `nodeVersion`，apply 校验 base version。
- 实例状态机按修复后的 V4：`OPEN → {PAUSED, CLOSED}`、`PAUSED → OPEN`；CLOSED 终态，任何 `pause/resume` 拒绝；重复 close 幂等。
- 定义注册表是单进程内同步操作；若未来开 worker，定义发布走事件日志，不在本期设计。

### 6.4 必须从第一天就做对的 P1（不复制已知 bug）

1. **深只读**：卡片/模板/契约注册时 `structuredClone` 进库；读取用 `deepFreeze`，任何路径写尝试在开发模式抛错。
2. **allowed_emit_ports 精确语义**：默认 = 声明了 `emit` 的端口；无任何 emit 声明时兼容退化为全部端口；receive-only 端口永不可 emit。
3. **ExecutionLimits 强制**：token_budget（调用前）、wall_clock / max_tool_calls（执行中），由 ExecutionBackend 统一 wrapper 执行，不依赖各 driver 自觉。
4. **RunSnapshot 完整 + seq 定稿**：每次提交一个 snapshot，内容含输入/输出 payload、下游消息 id、artifact refs、usage/trims；seq 只由 apply/control 推进，claim 单独写 `ExecutionRecord`（不再造成 run seq 空洞）。
5. **Repository 删除语义**：unsubscribe 是 tombstone/delete 而非仅内存移除。
6. **入口校验**：send/subscribe/publish callback 全部校验实例/节点/端点与状态，错误结构化。

### 6.5 调度与失败路径

完全继承 V4 修复后语义：

- 锁内选活 + claim → 锁外 execute（可重试 INVALID_OUTPUT）→ apply（OPEN + 节点版本校验）→ 失败进 `on_error` 或 FAILED 终态。
- backend 抛异常 = FAILED 可重试；handler 抛异常 = FAILED + 失败快照；InvariantError = 编程错误立即抛出。
- 模型 evaluator 与 agent 同规（含 CLOSED 与版本检查）。
- drain 收敛保护保留（10_000 上限）。

---

## 7. 后端服务（Fastify）

### 7.1 技术选型

| 关注点 | 选择 | 理由 |
|---|---|---|
| HTTP | Fastify 5 | schema-first、TS 好、与 Zod 集成、性能足够 |
| WebSocket | `@fastify/websocket` | 最小依赖，JSON 行协议，不引入 Socket.IO |
| 存储 | better-sqlite3（首发） | 同步事务模型最贴近 V4 的"提交即落盘" |
| ORM/迁移 | Drizzle ORM + drizzle-kit | 一套 schema 定义同时产 SQLite/Postgres dialect，ADR-4 的落点 |
| 校验 | Zod（fastify-type-provider-zod） | 与 contracts 同源 |
| 日志/观测 | pino + OpenTelemetry 预留 | 结构化日志；trace 字段预留不强制接 collector |

### 7.2 REST API（首版）

| 域 | 端点 |
|---|---|
| 装配 | `GET/POST /cards`、`POST /specs`、`GET /cards/search` |
| 定义 | `GET/POST /drafts`、`PUT/DELETE /drafts/:id`、`POST /drafts/:id/validate`、`POST /drafts/:id/publish`、`GET /templates/:id/versions`、`GET /templates/:ref`、`GET/PUT /templates/:ref/layout` |
| 注册表 | `POST /contracts`、`POST /topics`、`POST /policies`、`POST /transforms`、`POST /handlers`（handler 首版只允许服务端注册的内置/预置实现） |
| 实例 | `POST /instances`、`GET /instances/:gid`、`POST /instances/:gid/messages`、`POST /instances/:gid/run`、`POST /instances/:gid/control`、`GET /instances/:gid/executions`、`GET /instances/:gid/runs` |
| 队列 | `POST /topics/:id/subscribe`、`DELETE /subscriptions/:sid`、`GET /topics/:id/queue` |
| 产物 | `GET /objects/:oid/:version`、`GET /objects/:oid/history`、`GET /annotations/search` |
| 控制 | `POST /control/dispatch`（ControlPlane 工具层，供 MCP/画布复用同一语义） |

命令与查询分离的边界：**状态变化一律走命令端点并落 CommitRecord/RunSnapshot**；GET 只读。

### 7.3 运行循环

- `POST /instances/:gid/run` 创建后台 run task（非阻塞），`drain` 语义与 V4 一致；返回 `runId`。
- `POST /instances/:gid/messages` 入站后不自动 drain（首版显式 run，避免画布保存半成品时误跑）；提供 `auto_drain` 实例参数供后续选择。
- pause：取消该实例全部 RUNNING execution（backend.cancel），消息保留；close：终态守卫。
- 单实例同节点串行，跨实例并发由 `Promise` 调度器完成；首版不引入 worker 线程。

### 7.4 信任边界

- 每个请求由 auth 中间件注入 `Principal`（session → `human:id`；MCP → env `NODEFLOW_MCP_ACTOR`；内部服务 → `service:*`）。
- `arguments` 里的 `actor/proposer` 字段永远不可信（继承 `nodeflow_control.py` 规则）。
- 首版认证：dev token + session；生产接口（OIDC/OAuth）留 `AuthProvider` 接口。

### 7.5 MCP

- 把 TS `ControlPlane.dispatch` 暴露为 stdio MCP（JSON-RPC 2.0，与 `nodeflow_mcp.py` 同协议）；顶层助手 AI 与画布共享同一套 15+ 工具 schema。
- 新增 `canvas.import_draft` 工具：助手生成图 → 画布可见（最小闭环之外的第一个 AI 入口）。

---

## 8. 画布前端

### 8.1 总体结构

```
React/Vite app-shell（webapp）
 └─ canvas-engine（packages/canvas，零 React 依赖）
     ├─ model:        GraphDocument / NodeView / EdgeView / LayoutDocument
     ├─ commands:     AddNode/MoveNodes/ConnectPorts/SetProperty/Remove/...
     ├─ renderer:     SVG layer（grid → edges → nodes → ports → selection）
     ├─ interaction:  pointer 状态机（idle/pan/dragNode/dragEdge/marquee）
     └─ validate:     本地 JSON Schema 校验 + 服务端错误投影
```

为什么 React 外壳 + 自研图表面：自研成本可控（首版只有四种交互），React 负责面板/表单/路由/数据；canvas-engine 是纯 TS，所有命令可单测、undo 可精确验证。

### 8.2 数据模型与 undo/redo

- 每个用户操作 = 一个 Command 对象：`{do(ctx), undo(ctx), coalesce?(next)}`；redo 栈、undo 栈；移动/拖拽合并为一次提交。
- 真相源是 `GraphDocument`（语义 JSON + `_layout`）；渲染层只读投影。
- 保存动作：`PUT /drafts/:id`；发布：`POST /drafts/:id/publish` → 模板 `id@n`。

### 8.3 首版交互清单（M3 验收）

1. 平移/缩放画布，网格吸附。
2. 从 palette 拖入 7 种节点；节点渲染端口（emit/receive 方向用端口形状区分）。
3. 端口连线；非法连接实时红显（kind/方向/契约错误引用服务端同一错误文案）。
4. 属性面板编辑节点/边/策略 JSON；非法字段即时标记。
5. 保存/发布/模板版本列表。
6. 实例化并运行；节点按状态着色（OPEN 灰 → CLAIMED 黄 → RUNNING 蓝 → APPLIED/绿 → FAILED 红），消息/execution 面板流式滚动。
7. pause/resume/close 控制按钮，审批节点弹窗。
8. `_layout` 与语义互相独立：改动坐标不产生新模板版本。

### 8.4 后续画布路线（不在 M3）

小地图、群组/注释、多选复制粘贴、模板版本 diff、service 实例与订阅可视化管理、消息队列深度面板、卡片库面板。

---

## 9. 数据模型与迁移

沿用 V4 的 append-only 对象 + 运行状态 upsert，修正已知问题：

```sql
objects(object_id, version, kind, content_hash, body, provenance)  -- append-only
instances(gid, template_ref, owner, status, seq, params, head, nodes,
          children, pool_cursor, overflow, controllers)
records(execution_id, gid, node_id, status, claimed, base_node_version,
        request_json, session_handle)
messages(mid, target, payload, state, callback, topic, mkind, attempts,
         exit_port, request_id)
subscriptions(sid, topic, target, tombstoned_at)   -- 删除语义显式化
drafts(draft_id, spec, layout, updated_by, updated_at)              -- 新增：画布工作区
run_tasks(run_id, gid, status, started_at, finished_at)             -- 新增：后台 run
```

原则：

- **对象表永不 UPDATE/DELETE**；运行状态表可 upsert，但每次提交在同一个事务内。
- 迁移只增列/表，字段带默认值；沿用 `_migrate` 思路但用 drizzle-kit 管理。
- `objects` 的 `body` 存规范 JSON（stable stringify），hash 与内容强一致。
- SQLite 开 WAL + `synchronous=NORMAL`；Postgres 实现同一 Repository 接口，CI 用 testcontainers 双跑契约测试。

---

## 10. 执行面

| Backend | 形态 | 首版状态 |
|---|---|---|
| pi（低层 Agent） | in-process | `transformContext`/`beforeToolCall`/`AgentTool.execute` 直接接内核；usage 如实报 0（事件流不暴露时） |
| OpenAI 兼容 | in-process | 保留工具执行器（工作区根限制/shell 开关/截断/超时） |
| Subprocess CLI | 子进程 | 保留 V4 线协议，用于 Claude Code CLI/Codex 与探针 |
| Mock/Fake | in-process | 测试与前端联调默认 backend |

统一 wrapper（`ManagedBackend`）在 backend 外层强制：limits（wall_clock/max_tool_calls）、INVALID_OUTPUT 重试、事件采集、异常→FAILED 分类。**内核工具桥**在 in-process 模式直接调用 kernel-tools 模块；subprocess 模式走线协议。

---

## 11. 安全与可观测性

- 工作区根强制：所有文件工具 resolve 后必须落在 `workspace.root` 内；shell 默认关。
- 密钥只走环境变量；仓库内任何 `*.local.json` 永不提交；现有 Python `config/llm.local.json` 中的真实 key 立即轮换（已在审查轮标记）。
- 内核前缀保护：backend artifacts 不得伪造 `run/`、`annotation/` 与内核 kind。
- 可观测性：RunSnapshot 全量保留（输入+输出+下游消息 id），TraceSpan 只观测不裁决；pino 结构化日志带 `gid/executionId/seq`；WS 事件是唯一前端实时通道。
- 压缩/裁剪告警进 RunSnapshot，前端 dashboard 红点展示 `usage.compactions > 0` 与 `context_trims`。

---

## 12. 测试与双 oracle 策略

### 12.1 黄金 parity 栅栏（防止重写变成重设计）

1. `fixtures/` 存**两语言共享**的场景 JSON：图定义、卡片、topic、消息序列。
2. `scripts/run-oracle.mjs` 分别跑 Python V4 与 TS 内核，产出规范化 trace：

```json
{"seq":0,"event":"snapshot","gid":"gi-1","node":"w","edges":["e1"],
 "messageStates":{"msg-1":"CONSUMED"},"produced":["plan@1"]}
```

   id 归一化（`gi-N`/`msg-N`/`exec-N` 映射）后逐行 diff；**diff 非零即 CI 红**。
3. 先移植测试，后移植实现：TS 测试文件与 Python 测试一一对应、docstring 保留帧号；禁止新增 Python 没有的语义（新语义先加 Python oracle）。

### 12.2 测试分层

| 层 | 工具 | 内容 |
|---|---|---|
| 内核 | vitest | 52 条 foundation + 15 条 hardening + contracts/robustness/persistence 全量迁移 |
| 契约 | vitest + ajv | JSON Schema 对 fixtures 校验；OpenAPI 生成一致性 |
| 存储 | vitest + testcontainers | SQLite/Postgres 同一 Repository 测试套件 |
| 服务 | vitest + fastify inject | API 契约、auth、WS 事件顺序 |
| 画布 | vitest + Playwright | commands 单测；最小闭环 E2E：画图→保存→发布→运行→观测 |
| 执行 | 探针套件 | P1–P7 复用，pi 真实探针与 OpenAI 兼容对照组分开跑 |

### 12.3 完成定义（Definition of Done，全仓适用）

- Python oracle 对应场景仍然全绿；
- TS 对应测试绿 + parity diff 为空；
- 新代码带类型/边界测试；
- API 变更有 OpenAPI 生成物更新；
- 涉及持久化的变更带 SQLite+Postgres 双测。

---

## 13. 里程碑与验收门

### M0 —— 契约冻结与仓库骨架（先行，可与其他工作并行准备）

交付：monorepo 初始化；`contracts` 的 GraphTemplate Schema v1 / WS 协议 / OpenAPI 骨架；`fixtures/` 首批 30 个场景；parity runner 跑通空实现（全部 RED 但可执行）。

验收：`pnpm fixtures:diff` 能报告逐条差异；Python 侧全量测试仍绿。

### M1 —— TS 内核黄金移植

交付：`kernel` 完成 core/definitions/budget/scheduling/projections/presets；SQLite store 完成 Repository 首发实现；Python 的 52+15 条主测试全部迁移为 TS 测试。

验收：**parity diff = 0**；`pnpm -r test` 绿；Python 全量仍绿。

### M2 —— 服务端闭环

交付：Fastify REST/WS/auth/ControlPlane/MCP；SQLite+Postgres 双 Repository 契约测试；run 后台任务与事件总线。

验收：不经过画布，用 API + WS 客户端完成"注册卡片→发布模板→实例化→send→run→观测到 applied 事件"；OpenAPI 文档可生成。

### M3 —— 画布最小闭环 ★ 首个用户可见里程碑

交付：canvas-engine（model/commands/renderer/interaction）+ webapp 编辑器/运行面板；保存/发布/实例化/运行/观测全链路。

验收：Playwright 脚本从空画布开始，拖 2 个节点连边、保存发布、实例化运行、面板看到消息与状态变化；undo/redo 200 步无状态损坏。

### M4 —— 真实执行面

交付：pi in-process、OpenAI 兼容 in-process、Subprocess 适配；内核工具桥 in-process；探针 P1–P7 TS 版。

验收：`test_live_graph` 的 L5/L6 等价场景由真实模型跑通（DeepSeek 对照组 + pi faux/real 分档）；取消/usage/limits 契约测试绿。

### M5 —— 硬化与补齐（进入多人使用前）

交付：审查轮 P1 全量关闭；GC/索引替换点落地（annotation/card 检索）；安全评审；Playwright 全旅程 E2E。

验收：Python oracle 与 TS 双绿；P1 清单逐项关闭并在文档勾销；并发/持久化组合压力测试通过（≥ 100 实例 × 1000 消息）。

### M6 —— 部署形态

交付：Docker 镜像（server + webapp 静态托管）；Postgres 部署模式文档；备份/恢复/迁移 runbook。

验收：Postgres 模式 CI 绿；`docker compose up` 一键起全栈；从 SQLite 导出到 Postgres 的迁移脚本跑通 fixtures。

---

## 14. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| TS 重写范围失控、顺手改语义 | 高 | ADR-1 + parity 栅栏；新语义先改 Python；每模块只允许"结构改进，行为零改动" |
| 自研画布交互膨胀 | 中 | M3 只做 4 种交互；canvas-engine 与 React 解耦；超出即砍进 backlog |
| LLM 真实测试 flaky | 中 | 探针方法论沿用（断能力不断顺从度）；真实模型测试独立 profile、可跳过 |
| Postgres 预留变成空话 | 中 | M2 起双 dialect 契约测试；Repository 接口不许出现 SQLite 专属类型 |
| 单进程调度上限 | 低（首版） | 冲突域已节点级；M5 压力测试给出上限数字，超限再拆 worker |
| 现有 Python 测试漂移 | 低 | `py_oracle/` 冻结，CI 双跑；任何改动必须 Python+TS 同提交 |

---

## 15. 开放问题（进入 M1 前需拍板）

1. 仓库是否把 Python 移入 `py_oracle/` 子目录，还是原位冻结？（建议原位冻结，最小 diff）
2. 服务端框架最终确认：Fastify（建议）还是 Hono/Express。
3. 首版认证：dev token 是否够用，是否需要接现有 SSO。
4. handler 注册：首版只允许服务端预置 handler；用户自定义脚本 handler 何时开放、用什么沙箱。
5. 画布节点视觉规范与命名（中英文、颜色、端口形状）由谁定稿。
6. 是否需要在 M3 同时做"助手 AI 生成图 → 画布导入"（建议放到 M4 之后，避免首版分心）。

---

## 16. 建议的工作切分（按依赖启动）

1. **契约组**（1 人）：M0 全部 + 后续所有 schema/协议评审。
2. **内核组**（1–2 人）：M1 全部；与契约组在 M0 末会合。
3. **服务端组**（1 人）：M0 末启动，M2 全部。
4. **画布组**（1–2 人）：M1 末启动（先做 canvas-engine 纯 TS 部分，不等服务端）；M3 集成。
5. **执行组**（1 人）：M2 末启动，M4 全部。
6. **QA/oracle**（0.5–1 人）：fixtures 扩充、parity runner、Playwright 与探针维护，横跨全期。

每完成一个里程碑，先跑"Python oracle 全绿 + TS 全绿 + parity diff 为空"，再宣布完成。
