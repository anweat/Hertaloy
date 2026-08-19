# Hertaloy / Nodeflow V5

当前仓库已经进入 **V5 嵌套容器运行时重建阶段**。

## 当前基线

- 概念入口：[FOUNDATION_V5.md](./FOUNDATION_V5.md)
- 测试与实现准备：[V5_WORKPLAN.md](./V5_WORKPLAN.md)
- 历史资料与旧实现索引：[archive/README.md](./archive/README.md)

V5 的第一性变化是：容器成为实例，资产归约为变量，跨网关等待归约为锁账本。V4 的编排对象模型不再是实现基线。

## 仓库状态（v1）

**成熟度分档**（一个 ✅ 说不清全部，所以拆开）：

| 能力 | 已设计 | 已实现 | 入口可达 | 崩溃验证 | 端到端 |
|---|:-:|:-:|:-:|:-:|:-:|
| 内核编排（实例/锁/路由/截断/事务） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 沙箱执行面（local/wsl/docker + 出网） | ✅ | ✅ | ✅ | — | ✅ |
| 持久化与恢复 | ✅ | ✅ | ✅ | 部分 | ✅ |
| 权限层（ControlPlane + 授权文件） | ✅ | ✅ | ✅ | — | ✅ |
| 资源别名与工作区交接 | ✅ | ✅ | ✅ | — | ✅ |
| `hertaloy agent`（含 `--exec`） | ✅ | ✅ | ✅ | — | ✅ |
| MCP 工具层 | ✅ | ✅ | ✅ | — | ✅ |
| 画布 / 服务端 | 部分 | — | — | — | — |

**"崩溃验证"只标部分**：claim 落盘、孤儿执行会被认领并重跑，都有跨进程用例；
但**没有真的 `kill -9` 子进程再恢复**的测试，用例都在一个进程内 open/close。

**已知边界**（不是 bug，是当前设计的边）：

- **外部副作用只能承诺 at-least-once**。generation fence 拦得住迟到的内核 apply，
  撤不回已发的邮件或已推的 commit。
- **`--as` 是自报身份不是认证**。当前只适合本机；开放出去必须由认证会话注入主体。
- **对象已写、head 未换的崩溃窗口会让 run 拒载**。修法已想清（对象文件写入序号，
  装载时按 cursor 截断），未做。
- **对象回收没有设计路径**。沙箱与头都已封顶，唯独对象版本只增不减 ——
  `status` 会报保留了多少，至少让人看得见。
- **`run`/`settleAll` 的 scope 只用于授权，实际驱动整棵树**。

```
packages/contracts    54 条   身份/路径/变量/端口/消息/契约/模板/执行面/权限/资源
packages/kernel      145 条   store · tx · instances · locks · context · extract · routing · runtime · control
packages/sandbox     117 条   契约目录 · runner(local/wsl/docker) · 出网 · git 观察 · profile · 资源
packages/state        52 条   对象落盘 · 可变头 · 目录锁 · 权限/资源文件 · claim 耐久性
packages/cli         110 条   16 条命令 · 内置 handler · 模板构造器 · agent · JSON 契约
packages/mcp          15 条   11 个工具 · 三条纪律（过控制面 / 身份不可伪造 / 不常驻持锁）
合计                 493 条   pnpm -r test · typecheck · reachability 三个退出码均为 0
```

**上手看 [DEVELOPING.md](./DEVELOPING.md)** —— 每一条都对应一次真踩过的坑。

逐项状态见 [FOUNDATION_V5.md](./FOUNDATION_V5.md) §16（不变量强制表）与 §17（持久化）。
全文带状态标记，与代码同步维护。

旧代码没有删除。Python V4 oracle、339 条旧测试以及旧 TypeScript 移植原型都保存在 `archive/implementations/pre-v5-reset/`，可独立复查。

## 边界

- `archive/` 是只读历史证据；新实现不得从中直接 import。
- 需要继承旧行为时，先把行为写成新的 V5 场景或契约测试，再做最小实现。
- 被忽略的本地密钥配置不进入归档或版本控制。
