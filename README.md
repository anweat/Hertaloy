# Hertaloy / Nodeflow V5

当前仓库已经进入 **V5 嵌套容器运行时重建阶段**。

## 当前基线

- 概念入口：[FOUNDATION_V5.md](./FOUNDATION_V5.md)
- 测试与实现准备：[V5_WORKPLAN.md](./V5_WORKPLAN.md)
- 历史资料与旧实现索引：[archive/README.md](./archive/README.md)

V5 的第一性变化是：容器成为实例，资产归约为变量，跨网关等待归约为锁账本。V4 的编排对象模型不再是实现基线。

## 仓库状态（2026-08-17）

设计门已收束，Task 1–3 与 Checkpoint A 通过；**Task 4/5 经外部审核标回进行中**，七条 P1 已修并补了反例测试。Checkpoint B 未达成。

```
packages/contracts   51 条   身份/路径/变量/端口/消息/契约/模板/执行面 schema
packages/kernel      69 条   store · instances · locks · extract · routing · runtime
合计                120 条   typecheck 绿，离线，无数据库/网络/真实模型
pnpm test / pnpm typecheck
```

尚未具备：RunSnapshot、上下文编译与预算强制、策略执行器、持久化与崩溃恢复、
MCP/服务端/画布/真实 backend。当前是**内核实验切片，不是可用工作流系统**。
逐项状态见 [V5_WORKPLAN.md](./V5_WORKPLAN.md) §2.9。

旧代码没有删除。Python V4 oracle、339 条旧测试以及旧 TypeScript 移植原型都保存在 `archive/implementations/pre-v5-reset/`，可独立复查。

## 边界

- `archive/` 是只读历史证据；新实现不得从中直接 import。
- 需要继承旧行为时，先把行为写成新的 V5 场景或契约测试，再做最小实现。
- 被忽略的本地密钥配置不进入归档或版本控制。
