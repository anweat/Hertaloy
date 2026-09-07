# 外部改动后的可见性复审

2026-09-07。审查范围 `0944dd2..858d389`；修复后实现基线 `f15b272`。

结论：本机只读观察链路通过，可进入模板工作区与运行观察区的前端准备。
本轮不以旧页面的布局作为最终产品设计，也不将接口可见性等同于网页操作能力。

## 发现与修复

| 级别 | 反例 | 修复与证据 | 提交 |
|---|---|---|---|
| P1 | 读者改写缓存模板的嵌套端口，运行读取随之变化，固定版本正文没变 | 解析结果深冻结；保留版本缓存优化；反例先红后绿 | a922fa4 |
| P2 | handler 首次 FAILED / DISCARDED 没有成功提交，画面仍为 idle | 没有成功也检查终结消息；两个反例通过 | 60954cc |
| P2 | 成功消息被回收，保留的更早失败覆盖新成功 | 比较投递序号；真实 405 条后续提交触发回收后仍为 done | 60954cc / f15b272 |
| P2 | handler 有相位但页面只接受 execution ID，无法查看原因 | `Cell.result` 关联消息与精确提交，复用现有读取接口；迟到响应不覆盖新结果 | f15b272 |

Lock → Obligation 的场景接线、授权死锁查询、请求方截断后的服务方收口，相关现有测试通过。
缓存仍按版本对象寻址，不恢复每次解析，也没有撤销外部的性能优化。

## 真实实验

- [results.json](./results.json)：复用 S6 程序，真实 Node + LocalRunner + CLI 子进程；exec-1 故意失败，自动重试 exec-2 成功。HTTP 验证两阶段日志、新进度、产物正文与归属、固定依赖、纯校验、通道限制、重启后旧 token 401、拒绝流 403 和内核不变量。
- [handler-results.json](./handler-results.json)：[handler.mts](./handler.mts) 运行真实同步 handler，落盘后经 HTTP 重新查询。failed 首次失败，recovered 先失败后成功，再经 filler 的 405 次提交回收成功消息。状态仍为 done，消息标不可读，`$run@1` 的 consumed 精确对应 msg-3。sceneSummary 只保留 cells/tethers 与流数量，避免重复保存 200 条窗口流。
- 两组实验无模型调用，临时 run 保留，服务在检查后正常关闭。会话路径文件被忽略。

```powershell
corepack pnpm exec tsx experiments/2026-09-07-s6/visibility.mts --output-dir experiments/2026-09-07-visibility-review
corepack pnpm exec tsx experiments/2026-09-07-visibility-review/handler.mts
```

加 `--hold-result` 可保留监听给浏览器查看，在程序输出的临时目录创建 `stop` 文件后结束。
等待最多 15 分钟。S6 原程序新增可选输出目录，旧实验结果保持不变。

## 页面实测与测试门检

使用用户已允许的 Codex 内置浏览器：

1. 点 failed，看到 phase=failed、msg-1 与 value 提取失败原因。
2. 点 recovered，看到 phase=done、msg-3 已回收；点击 `handler-review/$run@1`，读到 node=recovered、consumed=[msg-3]。
3. 切到 agent 实验，看到 exec-2、done、3/3 note；点击 answer.md@1，读到实际正文及 exec-2 provenance，观测未重复计入产物。
4. 检查时控制台 error/warn 为空。

全量测试 **944 passed / 7 skipped**；7 个包 typecheck 通过；reachability **203** 个导出无孤儿。
7 个跳过项是 Docker daemon 未运行；真实 Docker 隔离不在这次验证结果内。

## 留给前端的边界

- HTTP 当前提供读取与纯校验，正式写入仍走 CLI/MCP；写认证与运行驱动生命周期待设计。
- definitions 是选定运行的固定依赖闭包，不是全局模板资产目录。当前服务绑定一个 run，也没有全局运行列表。
- 同步结果按消息投递顺序比较，不是任意调度策略下的完成时间线。
- 历史消息与现场日志均有窗口。对象正文有独立权限；缺席、回收、拒绝都要分别展示。
- 当前实例 coverage 来自近期消息窗口中的节点触达，子槽 coverage 来自已收口子实例；前端应给不同口径清楚的名称，不能当全程完成率。
- 浏览器实验显示旧页长侧栏被原始 JSON 与日志撑开。前端应首先改善信息层级、阅读宽度与选择上下文，而不是直接延续该布局。
