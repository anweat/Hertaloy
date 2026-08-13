# Harness 评估：判据与候选

> 配套：`FOUNDATION_V4.md`（命题与四个面）、`INTERFACES_V4.md`（对象与契约）
>
> 目的：为**多个执行面 backend**（pi / Claude / Codex / …）建立**同一把尺子**，
> 使选型与替换是可比较的工程决策，而不是逐个试。

---

## 1. 立场：我们租用推理循环，不租用状态

执行面 backend 只负责一件事：

> **给定一份我们编译好的上下文和一组我们声明好的工具，跑一轮模型 + 工具，把结果交回来。**

**会话历史、版本、恢复、并行、快照，全部由编排面自有**（`ObjectStore` / `ExecutionRecord` /
`GraphInstance`）。理由有三：

1. **可分析性** —— 自维护的历史结构受我们控制，能对齐 provenance、能按 epoch 切片、能喂给评测。
2. **可替换性** —— backend 之间只要"接受我们的历史、返回一轮结果"就能互换；一旦依赖它的会话对象，换 backend 等于迁移数据。
3. **不双份** —— 多数成熟 harness 自带持久化与崩溃恢复。用它就会有两套并行机制、两套恢复语义，
   在最难对齐的地方对不齐。

harness 自己的 session 存储**保留作为调试与审计兜底**，但**不是真相源**。

### 1.1 由此产生的接口修正

`ExecutionRequest.resume_handle` 从**必需**降级为**可选优化**（用于命中 provider 侧前缀缓存）。
真相源永远是 `InvocationContext`。丢失 handle 只影响成本，不影响正确性。

**判据推论**：一个 backend 若**只能**从它自己的会话存储恢复、不接受外部传入的完整历史，
则不满足最低要求。

---

## 2. 判据分三档

不是所有能力都需要"可控"。多数组件根本不需要我们调整，**查询出来展示就够**——
尤其各家 harness 那些不可干预的内部 tool。判据因此分三档：

| 档 | 含义 | 不满足的后果 |
|---|---|---|
| **必控** ★ | 命题本身。不可控则系统失去存在理由 | 淘汰 |
| **宜控** ◇ | 理想可控；不可控时有替代路径 | 降级，仍可用 |
| **只需观测** ○ | 能查询、能展示即可 | 缺失则该 backend 的运行不可解释 |

### 2.0 为什么"必控"只有四条

第一不变量（Agent 只能选不能构造）**在 `apply_execution` 已经强制**（测试 E2）：
输出提案必须落在 `allowed_emit_ports` 内，否则拒绝提交。因此 `beforeToolCall`
一类的**调用前拦截是纵深防御，不是唯一防线**——降级为 ◇。

同理：取消不可用时可退化为杀子进程；工具集不可精确限定时，至少要能**观测到**
实际调用了什么，落进 RunSnapshot 供展示与审计。

真正不可降级的，只有**上下文由我们编译**与**状态由我们持有**这两件事——它们就是命题。

### A 组 · 上下文（命题本身）

| # | 档 | 判据 | 降级路径 |
|---|---|---|---|
| A1 | ★ | **system prompt 可完全替换**，而非只能追加 | 无。只能追加 ⇒ 编译规则不归内核 |
| A2 | ★ | **messages 数组可完全由我们提供** | 无。这是"自维护历史"的前提 |
| A3 | ★ | **可禁用自作主张的压缩/裁剪** | 无。压缩是失败信号，不是特性 |
| A4 | ○ | 实际输入 token 数、是否发生压缩可观测 | 缺失则 `compactions` 告警失效 |
| A5 | ◇ | 缓存断点可控或可预测 | 不可控 ⇒ 成本上升，正确性不受损 |
| A6 | ◇ | 前缀/尾部注入位置分层明确 | 不明确 ⇒ 保守地全放前缀，牺牲缓存 |

### B 组 · 输出与工具

| # | 档 | 判据 | 降级路径 |
|---|---|---|---|
| B1 | ◇ | 工具集可精确限定 | 不可限定 ⇒ 退到 B1′ |
| B1′ | ○ | **至少能观测实际可用工具与实际调用** | 缺失则运行不可解释 |
| B2 | ◇ | 工具调用可执行前拦截，理由可回传 | 不可拦截 ⇒ 依赖 `apply_execution` 的事后校验（E2 已强制） |
| B3 | ◇ | 结构化输出 schema | 无 ⇒ 靠工具参数 schema 或提示词约束 + B4 重试 |
| B4 | ◇ | 输出不合规可在执行面内重试 | 无 ⇒ 整轮 `INVALID_OUTPUT` 失败 |
| B5 | ◇ | 客户端自定义工具（回调进编排面） | 无 ⇒ 只能靠输出解析拿 emissions |
| B6 | ○ | **不可干预的内部 tool 也要能观测到调用与结果** | 缺失则黑箱 |

### C 组 · 执行控制

| # | 档 | 判据 | 降级路径 |
|---|---|---|---|
| C1 | ◇ | 可取消在途执行 | 不可取消 ⇒ 杀子进程（副作用如实上报） |
| C2 | ○ | 流式事件可订阅 | 缺失则监控与子代理流式保存失效 |
| C3 | ◇ | 一轮执行边界清晰 | 不清晰 ⇒ 靠进程退出判定 |
| C4 | ◇ | 预算/上限可设 | 无 ⇒ 由编排面前置校验兜住（F4 已实现） |

### D 组 · 状态所有权

| # | 档 | 判据 | 降级路径 |
|---|---|---|---|
| D1 | ★ | **可不使用其会话持久化**（无状态调用） | 无。§1 立场 |
| D2 | ○ | 自有 session 存储可保留作旁路审计 | 缺失只损失兜底 |
| D3 | ◇ | 供应商中立 | 不中立 ⇒ 该 backend 仅覆盖单一厂商 |

**必控合计四条：A1 / A2 / A3 / D1。** 其余全部可降级或只需观测。

---

## 3. 候选评估

`✅` 已确认 ｜ `⚠️` 部分/有条件 ｜ `❔` 待实测 ｜ `❌` 不满足

| # | 判据 | **直连兼容端点**<br>（对照组·已实测） | **pi** | **Claude Agent SDK** | **Claude Code CLI** | **Codex** |
|---|---|---|---|---|---|---|
| ★A1 | system prompt 可替换 | ✅ P3 | ✅ | ✅ | ⚠️ | ❔ |
| ★A2 | messages 可完全提供 | ✅ P1 | ✅ | ❔ | ❌ | ❔ |
| ★A3 | 可禁用自动压缩 | ✅ P2（恒不压缩） | ✅ | ❔ | ❔ | ❔ |
| ○A4 | 压缩可观测 | ✅ 恒为 0 | ✅ | ⚠️ | ⚠️ | ❔ |
| ◇B1 | 工具集精确限定 | ✅ P3 | ✅ | ✅ | ⚠️ | ❔ |
| ◇B2 | 调用前拦截 + 理由回传 | ✅ 两处拦截 | ✅ | ✅ | ⚠️ | ❔ |
| ○B6 | 内部 tool 可观测 | ➖ 无内部 tool（完全受控） | ❔ | ❔ | ❔ | ❔ |
| ◇C1 | 取消 | ✅ P5 | ✅ | ✅ | ⚠️ | ❔ |
| ★D1 | 可无状态调用 | ✅ P6 + P7 | ✅ | ❔ | ❌ | ❔ |
| ◇D3 | 供应商中立 | ✅ 换 base_url 即可 | ✅ | ❌ | ❌ | ❌ |

**对照组实测：DeepSeek `deepseek-v4-flash`，8 条探针 6 过 2 合理跳过，连续三轮稳定。**
跳过的两条是 `P2b`（受控 backend 无法被强制压缩）与 `P4`（完全受控，没有不可干预的内部
tool）——都是"该 backend 不具备该情形"，不是缺陷。

下表为详细判据，各候选列待补。

| # | 判据 | **pi** | **Claude Agent SDK** | **Claude Code CLI** | **Codex** |
|---|---|---|---|---|---|
| ★A1 | system prompt 可替换 | ✅ `agent.state.systemPrompt` | ✅ | ⚠️ `--system-prompt` / `--append-system-prompt` | ❔ |
| ★A2 | messages 可完全提供 | ✅ `initialState.messages` | ❔ | ❌ CLI 面向交互，非任意历史注入 | ❔ |
| ★A3 | 可禁用自动压缩 | ✅ 压缩是可选 hook | ❔ 内置上下文管理，能否关闭待验 | ❔ | ❔ |
| A4 | 压缩/token 可观测 | ✅ 事件流 | ⚠️ | ⚠️ stream-json | ❔ |
| A5 | 缓存断点可控 | ✅ 自行组装前缀 | ❔ | ❌ | ❔ |
| A6 | 前缀/尾部分层明确 | ✅ skills 追加在尾部 | ✅ | ⚠️ | ❔ |
| ★B1 | 工具集精确限定 | ✅ `agent.state.tools` | ✅ | ⚠️ `--allowedTools` 粗粒度 | ❔ |
| ★B2 | 工具调用前拦截 + 理由回传 | ✅ `beforeToolCall → {block, reason, terminate}` | ✅ permissions/hooks | ⚠️ | ❔ |
| B3 | 结构化输出 schema | ⚠️ 靠工具参数 schema | ⚠️ | ⚠️ | ❔ |
| B4 | 执行面内重试 | ✅ 我们自控循环 | ✅ | ⚠️ | ❔ |
| B5 | 客户端自定义工具 | ✅ `AgentTool.execute` | ✅ | ❌ | ❔ |
| ★C1 | 取消 | ✅ `agent.abort()` + AbortSignal | ✅ | ⚠️ 杀进程 | ❔ |
| C2 | 流式事件 | ✅ `agent.subscribe` | ✅ | ✅ `--output-format stream-json` | ❔ |
| C3 | 执行边界清晰 | ✅ `agent_end` 事件 | ✅ | ⚠️ | ❔ |
| C4 | 预算上限 | ⚠️ 自行实现 | ⚠️ | ⚠️ | ❔ |
| ★D1 | 可无状态调用 | ✅ 低层 `Agent` 不强制持久化 | ❔ | ❌ 会话文件驱动 | ❔ |
| D2 | 自有存储可作审计 | ✅ `~/.pi/agent/sessions/` JSONL | ✅ | ✅ | ❔ |
| D3 | 供应商中立 | ✅ OpenAI / Anthropic / Google / 兼容端点 | ❌ Anthropic | ❌ Anthropic | ❌ OpenAI |

### 3.1 pi —— 已实测，满足全部否决项

**用低层 `Agent`，不用 `AgentHarness`。**

`AgentHarness` (v2) 在执行面内部又实现了一遍我们编排面的东西：

| AgentHarness v2 | 我们已有 |
|---|---|
| Lanes（命名执行位，可并行） | NodeInstance / 并行容器实例 |
| Lane Records（时序记录，崩溃重建） | `ExecutionRecord` |
| Tree（append-only，挂 `parentId`） | `ObjectStore` lineage |
| SuspendedOperation + `resume()` | claim/execute/apply + `reclaim_stale_executions` |
| SessionSnapshot / LaneSnapshot | RunSnapshot |
| `Result<T,E>` | `termination` 枚举 |

用它就是双份实现，违反 §1 立场。低层 `Agent` 恰好是"跑一轮"的抽象，与 `ExecutionRequest/Result` 一一对应。

**接口映射：**

| 我们的 | pi 低层 |
|---|---|
| `agent_spec.systemPrompt` | `agent.state.systemPrompt` |
| `agent_spec.tools` | `agent.state.tools: AgentTool[]` |
| `context` 编译 | `transformContext(messages, signal)` |
| `allowed_emit_ports` 执法 | `beforeToolCall → {block, reason, terminate}` |
| `control.streamChannel` | `agent.subscribe((event, signal) => …)` |
| `control.cancelToken` | `agent.abort()` + AbortSignal |
| 自定义工具 | `AgentTool.execute(toolCallId, params, signal, onUpdate)` |

**已知缺口：**
- **无内置 MCP**（README 明示）。需自写 `MCP → AgentTool` 适配器。按不变量 X 工具集本就必须编译期声明完，`agent.state.tools` 正是落点。
- 结构化输出 schema 靠工具参数 schema 间接达成，非一等能力。

**不采用其 CLI 层**：那一套从文件系统目录约定读卡片（`.pi/SYSTEM.md`、`AGENTS.md` 层叠、`skills/`），
而我们的卡片是索引中的对象。编译规则必须归内核。

### 3.2 Rust 版的可换性（有条件）

[nktkt/pi](https://github.com/nktkt/pi) 是**第三方移植**，非官方。移植 `pi-ai` / `pi-agent` /
`pi-coding-agent` 三个 crate；**明确不含** CBOR 协议、server/client、TUI、web UI。MCP client 在 roadmap。

因此"可换 Rust"**取决于建在哪一层**：

- 建在**低层 Agent API**（`run_agent()` + 权限门）→ 形状对应，可换
- 建在 **CBOR 协议 + server** → 没有对应实现，换不了

这是选择低层 API 的第二个理由。

### 3.3 CBOR 协议：本项目不采用

`packages/protocol` 是语言无关的 CBOR 线协议（4 字节大端长度 + 单个 CBOR item，传输中立），
听上去很适合 Python 编排面直连。但：

1. `packages/server` **不是开箱即用的服务器** —— README 明示 *"does not provide a standalone CLI
   or coding-agent service. Applications supply the `PiServerService` implementation."* 走这条路
   我们照样要写 TS 服务端，还多背一套协议与 lanes 语义。
2. 协议携带 `SessionSnapshot` / `LaneSnapshot` 等**会话状态概念**，与 §1 立场冲突。
3. Rust 版没有移植它。
4. **它是 pi 专属的**，对 Claude / Codex 毫无帮助 —— 而我们要的是多 backend 同一把尺子。

### 3.4 Claude Agent SDK / Claude Code / Codex —— 待实测

三条**必须实测**的项，因为它们是否决项且资料无法确认：

- **A2**（messages 可完全提供）：Claude Code CLI 面向交互会话，能否注入任意外部历史存疑。
- **A3**（可禁用自动压缩）：Claude 系内置上下文管理/压缩，**能否关闭**是关键 —— 关不掉则与
  "压缩是失败信号"直接冲突，只能降级为受限 backend。
- **D1**（可无状态调用）：CLI 由会话文件驱动，SDK 待验。

Codex 整列待实测，判据同上。

---

## 4. 适配层契约

一个 backend 要成为合法执行面，需实现：

```python
class ExecutionBackend:
    def run(self, request: ExecutionRequest) -> ExecutionResult: ...
    def cancel(self, execution_id: str) -> None: ...
```

并满足：

| 要求 | 说明 |
|---|---|
| **无状态** | 同一 `ExecutionRequest` 重放应产生等价执行；不依赖上次调用留下的隐藏状态 |
| **历史外来** | 完整对话由 `request.context` 提供，backend 不得自行补历史 |
| **工具封闭** | 实际暴露给模型的工具集 == `agent_spec.tools`，一个不多 |
| **端口封闭** | 模型试图输出 `allowed_emit_ports` 之外的动作必须被拦截，理由回传模型 |
| **可取消** | `cancel()` 后不再产生副作用；已发生的副作用如实报告 |
| **如实计量** | `usage` 反映真实消耗；发生压缩必须置 `compactions` |
| **句柄不透明** | `session_handle` 仅作缓存优化，丢失不影响正确性 |

### 4.1 语言边界

编排面骨架当前是 Python，pi 是 TS，Rust 版是第三方。三案：

| 方案 | 代价 | 说明 |
|---|---|---|
| **Python 编排面 + 窄 IPC** | 自造一层很窄的进程通信 | 只传 `ExecutionRequest/Result` 两个 JSON；正好检验适配层是否真的窄 |
| **编排面改 TS** | 重写 51 条测试 | 无进程边界；`transformContext` / `beforeToolCall` 直接是内核代码 |
| **编排面改 Rust** | 重写测试 + Rust 成本 | 终局最干净；但 Rust 版是第三方且功能落后 |

多 backend 目标（pi + Claude + Codex）**利好第一案**：Claude/Codex 的 SDK 分别是 TS/Python，
无论如何都要跨语言，与其绑定某一门，不如把边界固定在 `ExecutionRequest/Result` 的 JSON 上。

---

## 5. 选型结论

1. **pi 低层 `Agent`** 为首个 backend —— 唯一已实测满足全部否决项者，且供应商中立。
2. **不用** `AgentHarness`、不用 CBOR 协议、不用其 CLI 层。
3. **不依赖任何 backend 的会话存储**；历史与恢复自有，其存储仅作审计兜底。
4. **Claude / Codex 待实测**，重点是 A2 / A3 / D1 三条否决项。
5. 语言边界**固定在 JSON 上**，不绑定实现语言。

---

## 6. 探针（已可执行）

装置已就位，**结果待补**：

| 文件 | 作用 | 状态 |
|---|---|---|
| `nodeflow_adapters.py` | `SubprocessBackend` —— 边界固定在 JSON 上，不绑定实现语言 | ✅ |
| `drivers/fake_driver.mjs` | 假 driver，用于验证探针与适配层本身 | ✅ 8/8 绿 |
| `test_probes.py` | `ProbeSuite` 混入 —— 换 driver 即换候选 | ✅ |
| `drivers/pi_driver.mjs` | pi 的 driver | ⚠️ 骨架，含 `[TODO-VERIFY]`，未在装 pi 的环境跑过 |

```bash
python -m unittest test_probes -v
```

接一个新候选只需两步：写一个 driver，派生一个 `ProbeSuite` 子类实现
`make_backend()` / `fake()`。判据不重新讨论。

```bash
npm i @earendil-works/pi-agent-core @earendil-works/pi-ai
PROBE_PI=1 python -m unittest test_probes.TestPi -v
```

### 6.0 对照组已跑通，并抓出三个问题

用 DeepSeek `deepseek-v4-flash` 跑对照组，**在测任何真实候选之前**就暴露了三处，全是
**探针自身的缺陷**，不是 backend 的：

| 症状 | 真因 | 修正 |
|---|---|---|
| P4 失败：`'internal_todo' not found in ['emit']` | 探针断言"必须存在不可干预的内部 tool"。完全受控的 backend 压根没有——**那是优点** | 改为断言**标注属性**：每次调用都必须带 `gated`；无 ungated 调用则 skip |
| P7 失败：`{'message': …}` ≠ `{'response': …}` | 断言两次输出内容相等。真实模型有随机性，这是**顺从度差异不是隐藏状态** | 改为**信息不泄漏**测试：第一轮给暗号，第二轮问暗号，答得出才算有隐藏状态 |
| P1 间歇失败（约 1/3 概率） | 断言 `termination == "DONE"`，但传入的外来历史里**没有让模型调 emit 的指令**——模型爱调不调 | 末轮补上任务指令；断言放宽为 `!= "FAILED"`（走通即可，顺从度不是 backend 判据） |

**这正是设立对照组的目的**：先校准尺子，再量候选。若这三条在完全受控的 backend 上都过不了，
拿去量 pi / Claude 只会得到错误结论。

一条方法论：**真实模型上的探针天然 flaky**。断言必须落在
*backend 的能力* 上（能否接受外来历史、会不会偷偷压缩、有没有隐藏状态），
不能落在 *模型的顺从度* 上（有没有照指令调工具）。

### 6.1 探针清单

对每个候选跑同一组探针：

| 探针 | 验证 |
|---|---|
| P1 | 传入一段**人造的**、非该 harness 产生的 messages 历史，能否正常续跑 | ★A2 |
| P2 | 传入超长上下文，观察是否**未经允许**自行压缩 | ★A3 |
| P3 | 只给一个工具，检查模型看到的工具集是否恰好是它 | ★B1 |
| P4 | 在 `beforeToolCall` 位置否决一次调用，检查理由是否回传模型且未执行 | ★B2 |
| P5 | 执行中途取消，检查是否停止且副作用如实上报 | ★C1 |
| P6 | 完全不配置会话存储，检查能否运行 | ★D1 |
| P7 | 同一 request 连跑两次，检查结果是否等价（无隐藏状态） | 无状态 |

P1–P6 任一失败 ⇒ 该 backend 降级为受限用途或淘汰。
