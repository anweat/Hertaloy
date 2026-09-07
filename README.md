# Hertaloy / Nodeflow V5

当前仓库已经进入 **V5 嵌套容器运行时重建阶段**。

## 当前基线

- 概念入口：[FOUNDATION_V5.md](./FOUNDATION_V5.md)
- 测试与实现准备：[V5_WORKPLAN.md](./V5_WORKPLAN.md)
- 当前迭代约定与修复记录：[ITERATION.md](./ITERATION.md)
- 历史资料与旧实现索引：[archive/README.md](./archive/README.md)

V5 的第一性变化是：容器成为实例，资产归约为变量，跨网关等待归约为**未了结的义务**（第八次归约把锁账本也删了，见 §9）。V4 的编排对象模型不再是实现基线。

## 仓库状态（v1）

**成熟度分档**（一个 ✅ 说不清全部，所以拆开）：

| 能力 | 已设计 | 已实现 | 入口可达 | 崩溃验证 | 端到端 |
|---|:-:|:-:|:-:|:-:|:-:|
| 内核编排（实例/义务/别名路由/截断/事务） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 沙箱执行面（local/wsl/docker + 出网） | ✅ | ✅ | ✅ | — | ✅ |
| 持久化与恢复 | ✅ | ✅ | ✅ | 部分 | ✅ |
| 权限层（ControlPlane + 授权文件） | ✅ | ✅ | ✅ | — | ✅ |
| 资源别名与工作区交接 | ✅ | ✅ | ✅ | — | ✅ |
| `hertaloy agent`（含 `--exec`） | ✅ | ✅ | ✅ | — | ✅ |
| MCP 工具层 | ✅ | ✅ | ✅ | — | ✅ |
| 画布 / 只读观测服务 | 实验 | 原型 | ✅ | — | 部分 |

**"崩溃验证"只标部分**：已有真实双进程的驱动排他测试；claim 落盘与孤儿恢复
仍主要通过 open/close 模拟，**没有真的 `kill -9` 子进程再恢复**的测试。

**已知边界**（不是 bug，是当前设计的边）：

- **外部副作用只能承诺 at-least-once**。generation fence 拦得住迟到的内核 apply，
  撤不回已发的邮件或已推的 commit。
- **`--as` 是自报身份不是认证**。当前只适合本机；开放出去必须由认证会话注入主体。
- **提交边界已使用 head format 2 的 objectHeads 清单**，未提交对象不纳入当前读取；
  损坏或缺失的已提交对象仍拒绝加载。对象提交中断实验见 ITERATION 的 H07。
- **对象回收没有设计路径**。沙箱可以手工 reclaim，消息窗口有上限，
  但对象版本及 objectHeads 清单仍会增长。
- **整树操作只接受根 scope 并检查根权限**：`run`、`runAgents`、`settleAll`、
  `reconcile`、`causesOf`。真实的子树调度尚未实现；子树查询和定点 send/truncate 可用。
- **CLI 用 driver.lock 排斥同一 run 的并发 drain**，head.lock 仍在 agent 执行期间释放。
  嵌入式宿主直接调用 Runtime/RunState 时须自行保证独占驱动权；进程崩溃后的遗留锁
  仍需确认持有者已结束再清理，不自动抢占。分布式执行租约尚未实现。
- **帧 14（上下文不随轮次膨胀）有测量但没有强制**，见 §21.6。

```
packages/contracts    68 条   身份/路径/变量/端口/消息/契约/模板/执行面/权限/资源
packages/kernel      314 条   store · tx · instances · obligations · aliases · context · extract · routing · runtime · control
packages/sandbox     199 条   契约目录 · runner(local/wsl/docker) · 出网 · git 观察 · profile · 资源
packages/state        87 条   对象落盘 · 可变头 · 目录锁 · 权限/资源文件 · claim 耐久性
packages/cli         198 条   状态命令 · 模板/操作反馈 · agent · JSON 契约 · 驱动排他
packages/mcp          19 条   13 个工具 · 授权 · 结构化注册校验 · 失败持久化
packages/scene        66 条   层积渲染的纯函数投影
合计                 951 条   944 passed / 7 skipped（Docker daemon 未运行）
```

以上为 2026-09-07 Windows + WSL 环境实测；test、typecheck、reachability 均退出 0，203 个导出无孤儿。
批次证据和未完成项见 [ITERATION.md](./ITERATION.md)。
S4–S6 的信息反馈已接通，真实本地执行与浏览器验证见 [可见性实验](./experiments/2026-09-07-s6/README.md)；前端布局仍是实验原型。
最新外部改动后的检查与补充见 [第十一轮可见性复审](./experiments/2026-09-07-visibility-review/README.md)。

**上手看 [DEVELOPING.md](./DEVELOPING.md)** —— 每一条都对应一次真踩过的坑。

逐项状态见 [FOUNDATION_V5.md](./FOUNDATION_V5.md) §16（不变量强制表）与 §17（持久化）。
全文带状态标记，与代码同步维护。

旧代码没有删除。Python V4 oracle、339 条旧测试以及旧 TypeScript 移植原型都保存在 `archive/implementations/pre-v5-reset/`，可独立复查。

## 边界

- `archive/` 是只读历史证据；新实现不得从中直接 import。
- 需要继承旧行为时，先把行为写成新的 V5 场景或契约测试，再做最小实现。
- 被忽略的本地密钥配置不进入归档或版本控制。
