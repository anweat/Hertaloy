# Nodeflow V4 复杂度分析（2026-08-15）

范围：`nodeflow_v4.py` + `nodeflow_*`（单运行时、内存对象 + SQLite append-only）。
符号：`M`=消息总数，`N`=节点数，`E`=边数，`P`=本次输出端口数，
`V`=对象版本数，`C`=卡片数，`S`=订阅者数，`W`=worker 数。

## 1. 调度与路由（热路径）

| 操作 | 复杂度 | 说明 |
|---|---|---|
| `_take_unit`（选活+claim） | **O(M)** | 每次从全局 `_messages` 线性扫描；strategy 就绪检查再扫一遍按节点分组，仍 O(M) |
| `_select_for_strategy` | O(M) | TOP_ONE 用 `max()` 线性扫描候选；CROSS_ALL 笛卡尔积 O(L×R)（本批消息数） |
| `_run_unit`（执行外） | 取决于 backend | agent 在锁外并行，与 M 无关 |
| `_prepare_route` | **O(P×E)** | 每个 emit 端口扫描全部边；每边契约校验 O(fields) |
| `_materialize_route` | O(P×E) | 逐个创建消息（payload 深拷贝 O(size)） |
| `drain` | O(commits×(M+E)) | 每轮 commit 至少消费 1 条消息；commits ≤ M（失败重试按 `max_attempts` 有界） |
| `drain_concurrent` | O(commits×(M+E)/W 摊销) | claim/apply 在全局 RLock 内串行；执行在锁外 |

结论：**每提交一步 O(M+E)**。消息全部在单进程内存且节点数固定，主线性规模
（百级节点、千级消息）无压力；十万级消息会因"每次挑活全量扫描"退化。

## 2. 对象版本 / 持久化

| 操作 | 复杂度 |
|---|---|
| `ObjectStore.put` | O(1) 均摊 + JSON 序列化 O(body)（内容哈希算 body） |
| `get/resolve` | O(1) |
| `history` / `lineage` | O(V) / O(V+DAG 边) |
| `SqlitePersistence.flush` | 对象增量 O(新增版本×body)；运行状态**全量 upsert** O(I×N + M + R + S) |
| `restore` | O(总行数) |

瓶颈：每次提交把全部 instances/nodes/messages/records/subscriptions 重写一遍 →
**持续运行是 O(commits×(M+I)) 的二次方**。骨架规模可接受，规模上来改脏标记。

## 3. 上下文编译 / 预算

| 操作 | 复杂度 |
|---|---|
| `_compile_agent_prompt` | O(cards×tools)，排序主导 |
| `estimate_tokens` | O(总字符数) |
| `_fit_context` | **O(K²)** 最坏（K=上下文条目数）：每裁一条重新估全量；可改成增量前缀和 |
| `_emit_schema_for` | O(端口×契约字段) |

## 4. 检索 / 装配

| 操作 | 复杂度 |
|---|---|
| `search_annotations` | O(全部对象×版本) —— **线性投影**，故意不建索引 |
| `search_cards` | O(C×V×T) —— tag 反向索引已有，query 仍需线性 |
| `publish` | O(S×payload 大小)，每订阅者深拷贝 |

规模上来后的替换点明确：`search_annotations`→反向索引，`search_cards`→倒排文本，
`_take_unit`→每实例 READY 队列。

## 5. 并发

- 单 `RLock` 保护全部可变状态；锁内只有选择/claim/apply（O(M+E) 短临界区）。
- 唯一锁外长执行是 `backend.run`（agent / 模型 evaluator），所以 `workers>1` 对
  LLM 任务是真实并行，对纯内存 handler 是串行化。
- 无多锁顺序，死锁面极小；代价是 claim 阶段全量扫描无法并行。

## 6. 端到端主链（一次典型任务）

```
O(K 次提交) × [ O(M+E) 调度路由 + O(LLM) + O(产物大小) + O(M+I) 持久化 ]
```

LLM 时间与网络支配；编排面开销在百级图上是毫秒级。复杂度工程顺序建议：
① `_fit_context` 增量估算 → ② 持久化脏标记 → ③ READY 队列替代全量扫描 →
④ 检索真索引。每步都有既测试钉住的语义边界，优化不改变接口。
