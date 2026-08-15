# Nodeflow V4 —— 对象与器材接口参考

> 配套：`FOUNDATION_V4.md`（为什么这么设计）、`nodeflow_v4.py`（当前实现）、`test_foundation_v4.py`（45 条验收）
>
> 本文只回答 **有哪些对象、有哪些器材、它们之间的契约是什么**。
> 标注：`✅` 已实现并被测试钉住 ｜ `⚠️` 有已知缺口 ｜ `👤` 由用户 JSON 决定

---

## 0. 对象总表

| 层 | 对象 | 状态 | 一句话 |
|---|---|---|---|
| **装配** | `AssetCard` | ✅ | skill/mcp/rules/prompt 四种卡，稳定 ID + 版本 |
| | `AgentSpec` | ✅ | 卡片编译产物：五段 prompt + 工具全集 + `prefix_hash` |
| **定义** | `GraphTemplate` | ✅ | 节点 + 边 + 策略 + 槽 + 订阅，发布不可变；**定义本身是 ObjectVersion**（`register=@1`，`publish=@2…`） |
| | `GraphTemplateProposal` | ✅ | 提案只落版本不注册；审批 = 校验 + 发布 + approved 事实 |
| | `NodeDefinition` | ✅ | 7 种 kind |
| | `EndpointDefinition` | ✅ | `{ep: {emit/receive: {OP: {contract}}}}`；未声明 = 未约束 |
| | `EdgeDefinition` | ✅ | 固定 from/to + operation + servo |
| | `JsonTransformDefinition` | ✅ | 单类型 + role 枚举 |
| | `StrategyPolicy` | ✅ | readiness / selection / output |
| | `ContainerSlot` | ✅ | template + instantiation + entry + **exit** |
| | `TopicDefinition` | ⚠️ | 独立索引；**contract 仍存而未校验**（见 §7 遗留） |
| | `SubscriptionDefinition` | ✅ | 模板声明，实例化时解析 |
| | `MessageContract` | ✅ | 不可变、精确版本；连接期符号校验 + 运行期取值校验 |
| **实例** | `GraphInstance` | ✅ | 唯一工作实例身份 |
| | `NodeInstance` | ✅ | persistentState + executions + tail |
| | `MessageInstance` | ✅ | 投递状态 + callback + topic |
| | `QueueInstance` | ✅ | 主题的运行期承载（当前为投影） |
| | `Subscription` | ✅ | (topic) → (gid, node, endpoint) |
| | `ExecutionRecord` | ✅ | claim/execute/apply 的持久事实 |
| **版本** | `ObjectStore` | ✅ | **版本分配的唯一权威**（单例），H 组 6 条钉住 |
| | `ObjectVersion` | ✅ | 独立于 GraphInstance 的不可变实体 |
| | `Provenance` | ✅ | trace 追踪：谁在哪次执行里产出、派生自谁 |
| **执行** | `ExecutionRequest/Result` | ✅ | 编排面 ↔ 执行面的窄接口 |
| | `InvocationContext` | ✅ | head / messages / tail / transient |
| | `OutputContract` | ✅ | ports 强制；schema 由拓扑推导并编进 prompt |
| | `ExecutionBackend` | ✅ | 适配层协议 |
| | `Usage` | ✅ | 含 `compactions` 告警位 |

**已被删除、不再存在的**：`CheckpointRecord`、`AnnotationView`（并入 ObjectVersion）、`EndpointInstance`、`EdgeInstance`、`ServoRun`、`WaitInstance`、`fork_from_checkpoint`。

---

## 1. 装配面

### 1.1 `AssetCard`

```python
AssetCard {
    kind:     "skill" | "mcp" | "rules" | "prompt"
    card_id:  str
    version:  int          # 同 id 多版本并存，旧版永不覆盖
    tags:     [str]        # 用于自动化搭建时的索引
    body:     Mapping      # 👤 各 kind 的结构见下
}
```

**读 = 只读引用**（`card_body()` 返回 `MappingProxyType`）。**写经 tool / skill / mcp 服务**，产生新版本。**生效时机 = 休眠时**：`_resolve_spec` 在每次 claim 时解析一次，执行期间冻结。

`body` 结构 👤 —— 内核只要求四种 kind 各有一个约定字段，其余由用户 schema 限定：

| kind | 内核要求 | 其余 |
|---|---|---|
| `rules` | `text` | 👤 |
| `prompt` | `text` | 👤 |
| `skill` | `summary`（进索引）+ `text`（进尾部） | 👤 |
| `mcp` | `server`、`tools[]`（名称 + 摘要） | 👤 |

### 1.2 `AgentSpec` 与卡片编译器 ✅

**这是命题的一部分，编译规则属内核，用户不可改。**

```
AgentSpec = compile(model, cards[], node.emit_contracts)
```

产出的 prompt 布局，**按缓存稳定性排列**：

```
┌─ 稳定前缀（参与缓存，同一 spec 跨调用逐字节相同）───────────┐
│ [1] tools 全集声明          ← 含本节点可能用到的全部工具    │
│ [2] system:                                                │
│      a. rules 卡全量（必须遵守，含编辑范围根）              │
│      b. prompt/角色卡                                       │
│      c. mcp 可用列表（名称 + 摘要，不含全量 schema）        │
│      d. skill 压缩索引（按匹配，不全量）                    │
│      e. ★ 输出契约声明（由 emit 端点 contract 生成）        │
├─ 缓存断点 ────────────────────────────────────────────────┤
│ [3] messages:                                              │
│      head    实例化前固定的引用内容                         │
│      messages 本轮触发消息                                  │
│      tail    运行期发现的 skill 正文、追加资料              │
│      transient 本轮临时                                     │
└────────────────────────────────────────────────────────────┘
```

**不变量 X —— 稳定前缀不得因运行期发现而改变。**

推论，两条，方向相反：

- **skill / 资料 → 可以运行期追加**（纯文本，落在 `tail`，位于缓存断点之后）
- **tool → 不可运行期新增**。工具定义渲染在 prompt 最前，中途增删会让整个前缀失效。因此 **AgentSpec 必须在编译期声明本节点可能用到的全部工具**（可标记为延迟加载，运行期只做启用/暴露，不做新增）。若确实需要一个编译期未声明的工具，那是**下一轮执行 / 另一个 spec**，不是当前会话的追加。

> 缓存渲染顺序 `tools → system → messages` 及"改工具即全失效"对 Anthropic 系 harness 成立；其他供应商需在 §4.3 实测清单里一并验证。

---

## 2. 定义层

### 2.1 `EndpointDefinition` ✅

两种合法形态：

1. **未声明 = 未约束**：`{"io": {}}` —— 向后兼容，任何 payload 放行；
   模板可用 `strict_contracts: true` 要求所有边都有契约。
2. **声明方向 + 契约**（运行期取值校验 + `OutputContract.schema` 推导）：

```json
"endpoints": {
  "io": {
    "receive": { "PUSH": {"contract": "CodeTask@3"} }
  },
  "out": {
    "emit":    { "PUSH": {"contract": "CodeResult@2"} }
  }
}
```

边只实现 `PUSH`（CALL/REPLY 在注册期拒绝）；调用/回程语义落在 subflow 节点
与队列 REQUEST + callback 上（不变量 M3）。端点不是永久的 input/output 两类；
方向来自本次 operation 与已定义连接。

### 2.2 连接期校验 ✅

**校验发生在 `register_graph_template`，不是运行时。** 对每条边：

```
source.emit[op].contract  ──▶  servo(in → out)  ──▶  target.receive[op].contract
                    └────────── 三段必须相容，否则模板注册失败 ─────────┘
```

这条要求 Servo 也声明形状（或从 `map`/`set` 推导）。校验失败的错误信息必须是 LLM 可读的：

```
边 plan-to-code 不合法：
  源  planner.out  产出 PlanResult@2  {planRef, tasks[]}
  Servo plan-to-code-servo@2 之后  {planRef, tasks[], includeTests}
  目标 coder.io    要求 CodeTask@3   {specRef, includeTests}
  缺失字段：specRef。可用的映射来源：planRef
```

### 2.3 Agent 输出契约的推导 ✅

**因为每条输入边必有 Servo，agent 节点必然对输出 JSON 有形式限定。** 所以：

```
node.OutputContract.schema  ⟸  该节点所有 emit 端点的 contract 之并
node.OutputContract.allowed_emit_ports  ⟸  声明了 emit 的端点集合   ✅ 已实现
```

schema 不是用户可选填的，是**从拓扑推导出来的**。它有三个消费者：

1. 连接期校验（能不能连）
2. 运行期 `apply_execution` 的输出校验（现在只校验 port 名）
3. **prompt 编译（§1.2 的 [2e]）** ← 这是"prompt 范围要拓展"的落点

### 2.4 `ContainerSlot` 的 exit ✅

现在只有 `entry`，返回靠 handler 返回 `"reply"` 字符串约定。需补：

```json
"reviewers": {
  "template": "review-flow@1",
  "instantiation": "PER_CALL | WARM_POOL(n) | SINGLETON",
  "entry": "work.io",
  "exit":  {"endpoint": "work.out", "contract": "ReviewResult@1"}
}
```

### 2.5 其余定义对象 ✅

`EdgeDefinition` / `JsonTransformDefinition`（单类型 + role）/ `StrategyPolicy` / `TopicDefinition` / `SubscriptionDefinition` 形式已定，见 `nodeflow_v4.py`。

---

## 3. 版本层 ✅

### 3.1 `ObjectStore` —— 单例，版本分配的唯一权威

```python
store.put(object_id, kind, body, provenance) -> ObjectVersion   # 唯一写入口
store.get(object_id, version)  -> ObjectVersion
store.head(object_id)          -> ObjectVersion
store.history(object_id)       -> [ObjectVersion]
store.lineage(ref)             -> 版本 DAG
```

```python
ObjectVersion {
    object_id, version, kind, content_hash, body, provenance
}
Provenance {
    graph_instance_id, node_id, execution_id, at_seq,
    derived_from: ("plan@2", "spec@1")      # ← trace 追踪
}
```

**四条不变量**

- **V1 分配权唯一**：版本号只由 store 分配，单调，per `object_id` 全局唯一。backend 与 handler 只提交内容。
- **V2 独立于实例**：ObjectVersion 不属于任何 GraphInstance。关闭、fork、重新实例化不影响已有版本。
- **V3 内容寻址 + 幂等**：同内容重复提交返回同一版本。
- **V4 引用永远精确**：运行消息中只有 `object_id@version`，无 "latest"。

### 3.2 统一之后消掉的东西

| 原对象 | 变成 |
|---|---|
| `AnnotationView` | `ObjectVersion(kind="annotation", body={object_refs, fields})` |
| RunSnapshot 定型问题 | 降级为"定义 `kind="run"` 的 body 结构" |
| `artifact_versions` / `artifact` / `annotations` | 收敛进 store 的五个方法 |

### 3.3 接口改动

```python
# 现在
ExecutionResult.artifacts: ((kind, object_id, version), ...)
# 改成
ExecutionResult.artifacts: ((kind, object_id, body), ...)
```

内核 kind 枚举：`run` / `annotation` / `context_summary`。其余 👤（plan / spec / manifest / test_report …）由用户注册 kind + schema。

---

## 4. 执行面 ✅

```python
ExecutionRequest {
    execution_id, agent_spec, context, origin,
    workspace, output_contract, limits, resume_handle
}
ExecutionResult {
    execution_id, emissions, artifacts, usage,
    termination, session_handle, diagnostics
}
```

`termination`：`DONE | CANCELLED | BUDGET | INVALID_OUTPUT | FAILED`

三段式（`FOUNDATION §4.4`）：**claim（提交 A）→ execute（事务外）→ apply（提交 B，base 检查节点级）**。

Backend 矩阵与待验证清单见 `FOUNDATION_V4.md §4.3`。

---

## 5. 器材清单

| 器材 | 状态 | 职责 | 关键约束 |
|---|---|---|---|
| **卡片编译器** | ✅ | 卡片 + 输出契约 → AgentSpec/prompt | 布局固定（§1.2），不变量 X |
| **上下文编译器** | ✅ | 每轮重建 head/messages/tail/transient | 预算分配与截断顺序待定，见 §6 |
| **连接期校验器** | ✅ | 模板注册时校验边的三段相容 | 错误信息必须 LLM 可读 |
| **运行期校验器** | ✅ | source contract → servo → target contract | 只接受或拒绝，不暗中补字段 |
| **调度器** | ✅ | 扫描 QUEUED、readiness 门控、分派 | 单线程顺序；冲突域已按节点级设计 |
| **路由器** | ✅ | 边路由（图内）+ 队列投递（独立索引） | 不变量 M1/M2/M3 |
| **版本 store** | ✅ | 版本分配与 lineage | 不变量 V1–V4 |
| **实例池** | ✅ | PER_CALL / WARM_POOL / SINGLETON | WARM_POOL 每次清空 persistentState |
| **授权器** | ✅ | control / approve 的 actor 校验 | principal 形式 ✅ |
| **执行适配层** | ✅ | 三段式驱动 backend | session_handle 不透明 |

---

## 6. 尚待定形的内核契约

按依赖顺序，前两条是其余的前置。

| # | 契约 | 依赖 | 说明 |
|---|---|---|---|
| ~~1~~ | ~~版本管理单例~~ | — | ✅ 已完成，H 组 6 条 |
| ~~2~~ | ~~卡片编译规则~~ | — | ✅ 五段布局按缓存稳定性排列：rules 全量 → 角色 → mcp 名称+摘要 → **skill 压缩索引（summary，非全文）** → **输出契约（由 emit 端点 contract 生成，非人写）**。工具全集编译期定型并标 `defer_loading`。`prefix_hash` 指纹钉住不变量 X。见 `test_card_compilation.py` 12 条 |
| ~~3~~ | ~~端点声明形式~~ | — | ✅ `{"out": {"emit": {"PUSH": {"contract": "X@2"}}}}`；**未声明 = 未约束**（向后兼容），模板可设 `strict_contracts: true` 强制 |
| ~~4~~ | ~~连接期 + 运行期校验~~ | 3 | ✅ 连接期看**结构**（Servo 符号推演字段集），运行期看**取值**（源契约 → Servo → 目标契约）。错误信息面向 LLM/画布。见 `test_contracts.py` 13 条 |
| ~~5~~ | ~~上下文预算分配与截断顺序~~ | — | ✅ **head 永不裁剪**（自身超预算即失败，图切分过粗）；顺序 `transient → tail → messages`，**messages 至少留一条**（当前任务不可丢光）；同段砍最旧；截断产生告警，与压缩同级。估算含 spec 开销，系数由真实 `usage.in_tokens` 校准（拉丁 2.2 / CJK 0.9 字符每 token，实测比值 1.05 / 1.08）。见 `test_context_budget.py` 11 条 |
| ~~6~~ | ~~evaluator 返回守门 schema~~ | — | ✅ 已完成。**信任分层**：受信 handler 可返回 `emit`/`items`/`annotate`；**模型驱动的 evaluator 只能返回 `emit`**——`items` 会实例化子容器、`annotate` 会写版本锚点，都属"构造"而非"选择"。含 fan-out 上限（policy 声明或 `default_max_fanout` 兜底）与 `object_refs` 精确版本校验。模型 evaluator 走 claim/execute/apply 三段式，不占锁。见 `test_evaluator_guard.py` 16 条 |
| ~~7~~ | ~~错误分类与失败如何进入图~~ | — | ✅ CANCELLED/BUDGET 不重试（是意图非故障）；FAILED 按 `max_attempts` 重试；耗尽后经 `on_error` **沿边进入图**，未声明则进 FAILED 终态并记录。修掉了失败无限重试（10001 次 → 3 次） |
| ~~8~~ | ~~tool 注入与命名冲突~~ | — | ✅ 内核保留名 `emit/read_artifact/publish/spawn` 不可占用；跨卡片重名显式报错，不靠加载顺序；工具带 `source` 溯源 |
| ~~9~~ | ~~子流程 exit 声明~~ | — | ✅ `slot.exit.endpoint` 声明回程端口，取代 `"reply"` 魔法串；未声明时兼容退回 |
| ~~10~~ | ~~principal 形式~~ | — | ✅ `Principal(kind, id)`，kind ∈ human/agent/system/service；必须由可信边界注入，payload 不能自封 |

**用户 schema 👤（内核只提供机制与位置）**：各边的 MessageContract 内容、各主题 contract 内容、各卡片 body、各产物 kind 的 schema。

**实现细节（等真 backend）**：usage 计量口径、resume_handle 生命周期、`_layout` 结构、持久化边界。

---

## 7. 不变量总表

| 编号 | 内容 | 状态 |
|---|---|---|
| **首要** | Agent 只能在预先声明的选项中选择，永不构造地址/能力/契约 | ✅ E2 |
| M1 | 编排权威属于边；消息送达端点后由边接管 | ✅ C3/C4 |
| M2 | 队列是独立索引空间，与图拓扑正交 | ✅ C1/C2 |
| M3 | callback 落回已声明端点，不重选边 | ✅ C3 |
| V1 | 版本号只由 store 分配 | ✅ H1 |
| V2 | ObjectVersion 独立于 GraphInstance | ✅ H2 |
| V3 | 内容寻址 + 幂等 | ✅ H3 |
| V4 | 运行消息只用精确版本引用 | ✅ H4 |
| X | 上下文稳定前缀不因运行期发现而改变 | ✅ |
| — | 在途实例的能力集不漂移（休眠时更新） | ✅ A2 |
| — | 冲突域是 NodeInstance + 消费消息集合 | ✅ E5 |
| — | WARM_POOL 只复用资源不复用状态 | ✅ D2 |
| — | 上下文压缩是失败信号 | ✅ F3 |
| — | 预算在调用前校验 | ✅ F4 |
| — | 控制走授权路径并留提交事实 | ✅ G3 |
| — | 关闭走控制面 `control(close)`；`end` 是终态汇点，无内核 DRAIN/CLOSING | ✅ G4/G5、close 实验1/2 |
