# 前端渲染所需的信息反馈复审

基线 `10195d2acc69edb69a098254402f0c73d6662f6d`，审阅上一轮 R01–R05 修复后的代码。本轮只新增审阅实验与建议，不修改生产代码，不冻结接口或前端设计。

## 结论

下一步宜围绕“可信的运行摘要 + 可追溯的详情 + 明确的数据新鲜度”补全反馈。
模板与运行仍分离：模板面回答配置、约束、版本及校验；运行面回答这次执行、为何等待、如何结束、产物在哪里。

上一轮 R01/R02 的修复已进入完整回归；R03 的逐 execution 进度关联正确，但后续 Scene 仍选第一条执行；R04 的模板补载和选中详情更新有改进，重连闭环仍有缺口；R05 已改成如实说明本地信任边界，未改变认证模型。

## 已确认的阻断项

| 编号 | 级别 | 触发与实际结果 | 位置与建议边界 |
|---|---|---|---|
| F01 | P1 | 同一无权主体 GET /scene 返回 403；GET /scene/stream 却返回 200，然后观测服务以 code=1 退出。拒绝读取变成整个服务崩溃 | cli/serve.ts:124–144。首帧前验证；流中失败有显式错误收口与连接清理，不能留下未处理的 Promise rejection |
| F02 | P2 | exec-1 FAILED、exec-2 RUNNING 时节点仍 failed；exec-2 DONE 后仍 failed/1-of-10，实际最新进度为 9-of-10 | scene/build.ts:96、210。相位与进度必须选同一次适用执行；保留当前执行身份，重试历史在详情中查看 |
| F03 | P2 | 后端删除键为 `job job/child waits`，页面保存键为 `job|job/child|waits`，应用删除差量后 waits 仍存在 | scene/diff.ts:46 与 cli/page.html:160。共用一个稳定的 wire key，或直接传统一 id，不能各自拼 |
| F04 | P2 | 断线期间旧流离开消息窗口；新连接收到“空场景 → 当前场景”基线，客户端继续合并，旧流永久残留 | cli/page.html:508、state-commands.ts:341。每条新连接首帧替换本地基线，连接内才合并增量；不必先给内核增加事件账本 |
| F05 | P2 | HTTP 服务原端口重启后，旧页面 token 读 /scene 为 401，新 token 为 200；页面的 const TOKEN 不变，退避也不能恢复 | cli/page.html:143、545；serve.ts:90。区分临时断线与凭据失效；当前本地模型下可明确要求刷新页面，或另做可信引导刷新 |
| F06 | P2 | backend 返回 DONE 且 diagnostics.progress.done 为字符串：内核接受普通 JSON 观测，整份 Scene 却因进度格式错误无法解析 | state/snapshot.ts:130–157 与 scene/snapshot.ts。可选观测字段先校验，错误以执行级 warning/不可用表达；保持结构事实的严格校验 |
| F07 | P2 | 产物 `job/reports/result.md` 的 provenance.traceid 是 job，Scene 却推断 owner=job/reports，该 cell 根本不存在 | state/snapshot.ts:163、scene/build.ts:450–457。对象清单保留真实 provenance 归属；对象子路径不等于实例路径 |

F02 说明 R03 的源数据修复已生效，但测试不能止于 exportSnapshot。F03 和 F07 是此前未覆盖的接线问题，不能靠新增提示文案解决。

实验使用真实内核/RunState/Scene、页面原有数据处理函数和真实本地 HTTP。页面函数在 Node VM 中运行，无 DOM 交互；本轮不声称做过浏览器视觉验收。

另外两项：

- page 的 topUpTemplates 把尚未实例化的 slot.template 也列入 wanted，但 /templates 只返回已有实例的模板。本次两次补载均请求接口，仍得不到该 ref。需明确“已声明依赖”与“运行实例所用模板”的查询范围，避免每帧反复请求不存在于这个清单中的定义。
- progress-projection.test.ts:100 在队列已空时 claimAgent()，并没有创建注释所说的“无观测执行记录”；后面的断言仍通过。这条测试需明确准备第二条消息、断言 claimed/RUNNING，再验证没有观测的记录。

## 反馈应该补哪些信息

以下是数据需求与归属建议，不是最终字段签名。优先复用已有事实，不新增第二套运行状态。

| 前端要回答的问题 | 当前权威信息 | 最小补全 | 约束 |
|---|---|---|---|
| 我正在看哪个模板、哪个 run、哪次执行？ | templateRef、traceid、nodeId、ExecutionRecord.executionId/generation | 运行/服务标识、scope、精确模板 ref、当前 executionId、详情引用 | traceid 只在一棵树内有意义，不能当跨 run 全局键；模板草稿不混入运行事实 |
| 现在在跑、重试、失败还是结束？ | execution status/termination、消息 state/attempts/failure、实例 status | 当前执行与最新结果分开；保留 termination、重试次数、失败详情入口 | CANCELLED/BUDGET/FAILED 不混成一个故障；实例 TERMINAL 不等于成功；同步 handler 无 agent execution 时不得编造一条 |
| 为什么卡住、在等谁？ | obligations/locks、pending request、claim、子实例；CLI blockers/deadlocks/dirLocks | 结构化阻塞项及指向消息/执行/请求/子实例的 id；目录占用单列；可执行的动作与不可用理由 | 容器义务与进程锁分开；不能把所有 request 都叫“待人工审批”，回复必须符合既有协议 |
| 进度是什么含义？ | agent journal/$exec progress；Scene 结构覆盖率 | 语义进度的 done/total/note、所属 execution、采集状态；结构覆盖率另标含义 | 覆盖率不是任务完成度；未知不显示 0%；旧 attempt 的进度不能冒充当前进度 |
| 产物是什么、谁产生的、还能读吗？ | 对象 ref/version/kind/provenance、$exec 沙箱观测 | 精确 ref、真实 owner/producer execution、历史入口、内容与现场可用性 | retained 是执行结束时的记录，回收后是否仍存在需另查；缺失、未产生、无权查看分别表达 |
| 失败原因和输出内容在哪里？ | 消息 failure、$exec diagnostics、$run、对象正文、why | execution/message/object 的按需详情查询，错误摘要指向具体字段/对象/执行 | Scene 保持摘要；正文与日志按权限、按页或按上限读取，不能每帧塞进整张图 |
| 页面还连着吗，数据是不是最新？ | head 发布、配置文件、authz 日志、目录锁、连接状态 | 快照来源版本/指纹、观察时间、连接/过期/部分不可用状态、错误码与重试提示 | 观察时间属于观察层；断线后旧画面必须标旧，空数据不等于请求失败 |

特别需要注意：本次成功重试后的消息仍保留 `failure: 执行终止于 FAILED` 与 attempts=1。这是历史痕迹，若简单把 failure 字段搬到当前状态卡上，又会把成功显示成失败。要区分当前结论和历史失败，而不是只增加字段。

## 接口分层与渠道

建议用同一组带授权的查询结果服务 CLI、HTTP、MCP，再投影给 Scene。下面按语义列操作，暂不规定 URL：

1. **运行摘要**：根/子树生命周期、当前执行、消息数量、结构化阻塞、目录驱动锁、可用能力。已有 CLI status 的 data 可作为起点，但不能把中文 blockers 字符串当机器协议。
2. **执行详情与历史**：按 executionId 查询 status/termination/generation/claimed、观测 ref、usage 可用性和产物；节点历史分页。没有 $exec 观测的执行仍可查到执行事实。
3. **消息/请求详情**：按消息 id 查询端点、请求/回复关联、尝试次数、原因及按需正文；保留因果查询。正文已回收时返回明确不可用，不把 404 解释成从未发生。
4. **对象清单、正文与版本**：清单返回精确 ref 和 provenance，正文/版本比较按需取；生产者与所属实例可回到同一条执行证据。
5. **模板定义与校验反馈**：精确 ref 和已声明依赖能查到；草稿校验返回字段路径、问题码/说明和严重程度。模板注册后的 ref 是创建 run 的输入，已有实例不跟着草稿变化。
6. **反馈订阅**：提供可重建基线和连接内增量；配置、权限、资源、审计和驱动占用有自己的变化来源。当前 page 只在 scene 变化时拉 authz，会漏掉仅日志/配置变化的反馈。

目前 HTTP 仍只有 scene/templates/authz/scene-stream；详情能力多数停在 CLI/MCP。无需先开放写操作就能补齐读取与反馈；写操作的权限模型和执行所有权沿用既定边界另审。

### 实时语义进度需要补采集链

当前 SandboxBackend 等 runner 返回后才读取 journal/progress，再落成 $exec。已有 RUNNING 的场景更新不等于能持续看到执行内部的进度、日志。

下一步可由执行宿主或独立观察适配器读取已有 journal、绑定 executionId，产出有上限的过程观测；前端只消费这份观测。过程观测与最终执行结算必须分开，观察失败不能回滚提交，取消已请求也不能显示成物理停止已确认。

节点的 note 在现有 Scene.progress 中已丢弃，page 的节点卡片和节点详情也不展示语义 progress；补采集时必须一路验到最后消费点。不要仅在 snapshot 上增加字段就认定完成。

## 旧观察面文档不能直接照搬

OBSERVATION_V5.md 的只读独立、摘要/详情分层、观察失败不影响执行，仍值得保留。以下内容需要先修订：

- **游标漏 claim**：实测 claim 前后 `{seq:1, objects:1, config:unchanged}` 完全相同，但消息已 CLAIMED、执行已 RUNNING。它不能覆盖所有状态变更。当前 watchScene 用 mtime/size，不受这个尚未实现的游标影响；未来不能据此换成有缺口的协议。
- 观察层来源指纹可以用于判等；若要实现草稿的“读己所写”，必须另行证明提交版本的先后比较规则。消息序号、对象版本数、配置哈希不能直接当通用递增提交版本。
- **tolerateSkew 已过时**：当前 head 格式 2 的 objectHeads 已区分已提交版本。不要为了渲染而把未提交对象重新混进快照，也不能忽略真实损坏。可以保留上一份有效画面并明确标记过期/读取失败。
- 文档中的“无授权快照”“沙箱 git 观察未实现”等说明已过期；按当前实现校准。L1 与历史无关的规模承诺也还不成立：当前导出遍历执行历史和全部对象版本。

## 建议的逐步迭代与验收

| 切片 | 内容 | 必须验到的反例 |
|---|---|---|
| S1 | 修 F01/F06：流错误收口、可选观测校验 | 无权读取不杀服务；坏 progress 不毁整张图，错误有明确归属 |
| S2 | 分别修 F02/F03/F07：当前执行选择、关系删除、产物归属 | 失败→重试运行→成功；父子等待解除；多级产物仍归属正确实例 |
| S3 | 修 F04/F05：流重建、凭据失效反馈 | 断线后移除旧流；服务重启可恢复或明确提示刷新 |
| S4 | 运行摘要与执行/消息/产物详情查询 | 同一条执行从节点能追到失败、消息和产物；空/缺失/无权/未采集分别有结果；CLI 与 HTTP 语义一致 |
| S5 | 语义进度与日志采集 | 执行中产生进度可见；note 不丢；旧 attempt 数据不污染新 attempt |
| S6 | 模板依赖与操作反馈 | 未实例化的子模板也能检视；校验错误能定位字段；注册版本和运行使用版本对应；动作不可用给出真实原因 |

每个切片完成相关验证后单独提交。这里的次序与数据需求供下一步实现评审，未冻结新的公开类型或端点。

进入前端设计前，至少走通：模板精确版本 → 独立 run → 当前执行 → 等待/失败解释 → 某条消息和某个产物 → 断线重建。此时页面布局才有可靠的数据基础。

## 证据与复跑

```powershell
corepack pnpm exec tsx experiments/2026-09-07-feedback/feedback-probe.mts
```

使用新临时目录、受控 backend、页面原数据函数及一次性本地 HTTP 子进程；不调用模型、不读取密钥、不访问用户现有 run。子进程有 12 秒 watchdog；服务均关闭。实验退出 0 表示取证完成，不表示记录的产品行为正确。

`results.json` 包含：旧游标漏 claim、当前执行选择、产物归属、等待删除、重连基线、未实例化模板补载、重启凭据、坏进度、流授权错误，共九组证据。

基线全仓验证：**874 passed / 7 skipped**；7 个包 typecheck；196 个导出无孤儿。
分包：contracts 68、kernel 305、sandbox 192 passed + 7 skipped、state 83、CLI 157、MCP 17、scene 52。
Docker daemon 不可用，7 个 Docker 集成用例跳过；WSL 取消新用例包含在通过的基线中。

日志：本机 `%TEMP%/hertaloy-feedback-audit-tests.log`、`hertaloy-feedback-audit-types.log`、`hertaloy-feedback-probe.log`。
