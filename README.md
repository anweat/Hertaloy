# Hertaloy / Nodeflow V5

当前仓库已经进入 **V5 嵌套容器运行时重建阶段**。

## 当前基线

- 概念入口：[FOUNDATION_V5.md](./FOUNDATION_V5.md)
- 测试与实现准备：[V5_WORKPLAN.md](./V5_WORKPLAN.md)
- 历史资料与旧实现索引：[archive/README.md](./archive/README.md)

V5 的第一性变化是：容器成为实例，资产归约为变量，跨网关等待归约为锁账本。V4 的编排对象模型不再是实现基线。

## 仓库状态（2026-08-18）

设计门已收束。Task 1–6 完成，**Checkpoint A / B 均通过**；外部审核轮七条 P1 已修。
此后经历**第四次归约**：策略节点删除，汇聚 / 循环计数 / 择优改由「版本历史即状态」承担。
批 0（事务化提交）、A（资产 ctx）、F（对象命名空间）、B（物化继承）已落地。

```
packages/contracts   51 条   身份/路径/变量/端口/消息/契约/模板/执行面 schema
packages/kernel     102 条   store · tx · instances · locks · context · extract · routing · runtime
合计                153 条   typecheck 绿，离线，无数据库/网络/真实模型
pnpm test / pnpm typecheck
```

尚未具备：容器工具（从节点内建子容器）、权限、
持久化与崩溃恢复、MCP / 服务端 / 画布 / 真实 backend。
当前是**内核实验切片，不是可用工作流系统**。

逐项状态见 [FOUNDATION_V5.md](./FOUNDATION_V5.md) §16（不变量强制表）与 §17（待开发清单）。
`FOUNDATION_V5.md` 全文带 ✅🚧📋❓ 状态标记，与代码同步维护。

旧代码没有删除。Python V4 oracle、339 条旧测试以及旧 TypeScript 移植原型都保存在 `archive/implementations/pre-v5-reset/`，可独立复查。

## 边界

- `archive/` 是只读历史证据；新实现不得从中直接 import。
- 需要继承旧行为时，先把行为写成新的 V5 场景或契约测试，再做最小实现。
- 被忽略的本地密钥配置不进入归档或版本控制。
