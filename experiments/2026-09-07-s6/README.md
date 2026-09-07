# S1–S6 可见性复审与实验

2026-09-07，最终实现基线 `36fe19c`。原始输出见 [results.json](./results.json)，
实验程序见 [visibility.mts](./visibility.mts)。旧实验结果保留在相邻日期目录，没有覆盖。

结论：在本机只读观测与 CLI/MCP 操作的范围内，基础反馈已足够进入前端信息结构与交互设计讨论。
这不表示旧画布完成了产品设计，也不表示 HTTP 写操作、全局模板资产库或完整日志回放已经实现。

## 文档承诺 → 实现 → 证据

| 需要看见什么 | 当前实现 | 实测 |
|---|---|---|
| 模板与运行固定版本分离 | definitions 声明闭包与 usedBy；正式注册返回 ref | 注册 leaf@2 后，运行及未实例化依赖仍引用 leaf@1 |
| 草稿错在哪 | 注册与干跑共用准备阶段，结构化字段错误 | 缺失子模板定位 children.broken；CLI/HTTP/MCP 回归覆盖结构、执行规格、overlay 与拒绝不落盘 |
| 当前执行是谁 | Scene.execution 与当前相位、进度使用同一条记录 | exec-1 FAILED → 自动重试 exec-2 DONE；节点显示 exec-2 和新进度 |
| 执行中实际输出 | 真实 Node 调用沙箱 toolkit，HTTP 读 journal | 1/3 到 2/3 的 note 在页面不刷新时自动追加 |
| 当前成功与历史失败分开 | message.state 与 lastFailure 分开 | 同一消息最终 CONSUMED，attempts=1，历史失败仍可查询 |
| 结束后的观测与产物 | execution 给精确引用，object 读正文 | 浏览器点击 answer.md@1 读到实际文件内容和 exec-2 provenance；观测不重复计入产物 |
| 为什么操作不可用 | permission / available / reasons / requires | HTTP read_only_transport；终态 send/spawn 另有 terminal_instance |
| 断流与拒绝的反馈 | 新流重建基线，凭据失效停止轮询 | 服务同端口重启后旧 token 401，页面提示刷新；刷新恢复；无权流 403，服务存活 |
| 生存期、覆盖率、语义进度的区别 | lifecycle、coverage、progress/progressUnavailable | 最终浏览器显示 TERMINAL、覆盖 1/1、节点 done 和 3/3 note；坏进度透传用例通过 |

## 本轮修复与提交

| 提交 | 内容 |
|---|---|
| e5b4b47 | runner 参数丢失、沙箱缺席误报空现场、选中项过期响应 |
| 96f58a2 | S6 声明依赖查询及未实例化子槽消费 |
| b84a537 / f715bd1 | 共用注册校验、CLI/HTTP/MCP 结构化反馈与类型断言修正 |
| 25ae3ad | 操作权限、条件、通道限制；凭据失效停止侧栏轮询 |
| 2210c24 | 对象正文出口、结束后的页面入口、子树消息详情及读取竞态 |
| 76f9cea | 原始实例生命周期、覆盖率标签、坏进度不可用原因透传 |
| 36fe19c | 执行观测不重复计入用户产物 |

## 如何复现

在仓库根目录运行：

```powershell
corepack pnpm exec tsx experiments/2026-09-07-s6/visibility.mts
```

程序创建独立临时 run，使用真实 CLI 子进程与 LocalRunner，不调用模型。
第一次 agent 故意失败，驱动在同一次 drain 中自动重试；返回 0 表示最终收敛成功，
不能据此推断历史从未失败。程序断言执行记录、消息、进度、产物、权限及重启状态，并运行内核不变量检查。

加 `--interactive` 时在 `session.json` 给出的临时目录依次创建 `more`、`fail`、`retry`、
`restart`、`stop` 文件，可在每个阶段查看浏览器。加 `--hold-result` 则自动运行所有阶段后，
保持最终页面直到创建 `stop`。门控等待最长 15 分钟。服务结束时关闭监听；临时 run 保留作排查证据。
`session.json` 只是本机连接信息，已忽略，不入库。

## 浏览器与整体验证

用户明确允许使用 Codex 内置浏览器。真实页面验证了：运行日志追加、未实例化子槽定义、
DONE/进度 note、点击对象引用并滚动阅读正文、重启提示与刷新恢复，以及最终生命周期/覆盖率标签。
页面异步用例另外覆盖选中项切换、对象读取竞态和终态到达时仍有旧请求在途。

- 全量：929 passed / 7 skipped；7 个包 typecheck 通过；reachability 203 个导出无孤儿。
- Docker daemon 未运行，7 个 Docker 集成用例跳过；不能据此宣称真实容器网络/隔离验证完成。
- 本实验验证真实 LocalRunner；WSL 覆盖来自全量现有测试。没有调用付费模型，也没有验证任何外部 Agent 的完整私有推理过程。

实验过程中修正了两项夹具假设：drain 会自动重试；服务重启后旧连接池可能先报 ECONNRESET，
需要建立新连接后再判断旧 token 的 401。它们已写入程序，不修改产品行为来迁就实验。

## 留给前端设计的明确边界

- HTTP 只读加纯校验。网页注册/投消息/推进/截断前需要明确本机认证与写通道。
- definitions 是运行关联的声明闭包。全局模板目录、草稿保存、模板版本比较仍需单独设计。
- journal 展示最近 20 条；需匹配 runner。未接入 journal 的工具输出、跨进程物理取消、全量历史回放不在本次承诺内。
- 状态与对象规模、分页和长期保留策略仍需后续约束；现有消息窗口不能冒充完整历史。
- 旧页面只是消费接口的实验载体。模板工作区和运行观察区如何组织，可以从这些已验证的事实开始讨论。
