# Hertaloy / Nodeflow V5

当前仓库已经进入 **V5 嵌套容器运行时重建阶段**。

## 当前基线

- 概念入口：[FOUNDATION_V5.md](./FOUNDATION_V5.md)
- 测试与实现准备：[V5_WORKPLAN.md](./V5_WORKPLAN.md)
- 历史资料与旧实现索引：[archive/README.md](./archive/README.md)

V5 的第一性变化是：容器成为实例，资产归约为变量，跨网关等待归约为锁账本。V4 的编排对象模型不再是实现基线。

## 仓库状态（2026-08-18）

**成熟度分档**（一个 ✅ 说不清全部，所以拆开）：

| 能力 | 已设计 | 已实现 | 入口可达 | 崩溃验证 | 端到端 | 可作服务 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 内核编排（实例/锁/路由/截断） | ✅ | ✅ | ✅ | — | ✅ | — |
| 沙箱执行面（local/wsl/docker + 出网） | ✅ | ✅ | ✅ | — | ✅ | — |
| 持久化与恢复 | ✅ | ✅ | ✅ | 部分 | ✅ | — |
| 权限层（ControlPlane + 授权文件） | ✅ | ✅ | ✅ | — | ✅ | — |
| `hertaloy agent`、MCP、画布 | 部分 | — | — | — | — | — |

**"崩溃验证"只标了部分，原因要说清**：claim 会落盘，换进程能看见 `RUNNING`
记录，但**恢复后没有接管流程** —— 调度器只挑 `QUEUED`，那条 `CLAIMED` 消息
不会被任何人继续。所以目前是"claim 不丢"，不是"崩了能接着跑"。
测试也都在同一个进程里 open/close，没有真的 `kill -9` 子进程。

**尚不具备**：`hertaloy agent`、MCP / 服务端 / 画布、崩溃接管、
外部副作用的恢复语义（generation fence 拦得住内核 apply，撤不回已发出的邮件
或已推的 commit）、真实项目工作区（沙箱目前是空临时目录，不从 repo 拉基线）。

**当前是本地 CLI 切片，不是可用的工作流服务。**

```
packages/contracts    51 条   身份/路径/变量/端口/消息/契约/模板/执行面/权限 schema
packages/kernel      141 条   store · tx · instances · locks · context · extract · routing · runtime · control
packages/sandbox      76 条   契约目录 · runner(local/wsl/docker) · 出网策略 · git 观察 · profile
packages/state        35 条   对象落盘 · 可变头 · 目录锁 · 权限文件 · claim 耐久性
packages/cli          39 条   doctor/validate/run + status/show/history/send/drain/truncate
合计                 342 条   pnpm -r test 与 pnpm -r typecheck 退出码 0
```

逐项状态见 [FOUNDATION_V5.md](./FOUNDATION_V5.md) §16（不变量强制表）与 §17（待开发清单）。
全文带状态标记，与代码同步维护。

旧代码没有删除。Python V4 oracle、339 条旧测试以及旧 TypeScript 移植原型都保存在 `archive/implementations/pre-v5-reset/`，可独立复查。

## 边界

- `archive/` 是只读历史证据；新实现不得从中直接 import。
- 需要继承旧行为时，先把行为写成新的 V5 场景或契约测试，再做最小实现。
- 被忽略的本地密钥配置不进入归档或版本控制。
