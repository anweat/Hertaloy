# 历史资料索引

本目录保存 V5 重建前的设计与实现证据。归档是分类和冻结，不代表这些内容已被 V5 采纳。

## 文档

| 目录 | 内容 | 状态 |
|---|---|---|
| `docs/origin/` | 最初 `nodeflow.md` 与设计背景 | 思路源头 |
| `docs/v3/` | Container 元模型与协议工作台 | 历史候选，存在未冻结边界 |
| `docs/v4/` | V4 foundation、interfaces、复杂度与执行面评估 | 旧实现规格；仅按 V5 §14 选择性继承 |
| `docs/superseded-v5-transition/` | 旧全栈架构、一次性构建提示词、重置前 README | 名称虽含 V5，仍以 V4 GraphTemplate/7 类节点和长期 parity 为基础，已被 `FOUNDATION_V5.md` 取代 |

## 实现

`implementations/pre-v5-reset/` 保留重置前的原始相对布局，包括：

- Python V2/V4 runtime、drivers 与完整测试集；
- 基于 V4 语义启动的 TypeScript contracts/kernel 原型；
- 对应的 npm/pnpm 配置与示例配置。

归档前基线（2026-08-17）：

- Python：收集 339 条，`321 passed, 18 skipped, 20 subtests passed`；
- TypeScript contracts：6/6 通过；
- TypeScript kernel：5 条中 3 通过、2 失败。失败分别是入口契约没有拒绝缺失字段，以及 agent usage 没有累计。

归档目录禁止作为新 V5 生产代码的依赖。若要复用执行面、ObjectStore、预算估算或契约校验器，应先在新测试集中固定 V5 所需行为，再移植最小代码。

