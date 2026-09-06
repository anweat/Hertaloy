# 2026-09-07 内核、执行面与前端通道复审

基线：`75b8a8985252213b8d28518a217f0bf89a106d4d`，并保留用户原有未提交改动。
本轮只增加审阅实验和记录，没有修改生产代码，没有决定前端视觉设计。

## 判定边界

- `DEVELOPING.md` 与 `ITERATION.md` 记录最近已经落实的实现边界；`FOUNDATION_V5.md` 提供概念与不变量的论证。
- `ONESHOT.md` 仍是未跟踪的对齐草稿。它自称单一基线，但 `ITERATION.md` 明确要求逐项复核；本轮不替用户宣布文档切换或 API 冻结。
- 旧画布和 `RENDERING.md` 只用于理解当前投影，不构成新的界面设计约束。
- 缺少浏览器写接口是当前只读服务的范围限制；已有接口提供错误数据则是 bug。两者分开处理。

## 当前内核如何工作

1. 模板定义先校验、注册为不可变对象版本，继承在注册时物化。实例固定引用精确版本；新模板不会热替换正在运行的实例。根由 `root_config` 启动配置建立。
2. 一个状态目录对应一棵实例树。traceid 的段前缀表达父子、命名空间和作用域；节点通过 receive/emit 端口、容器内部边和跨容器别名通信。
3. 普通节点的 kind 仍是 handler；是否声明 agent 决定执行方式。同步 handler 是受信代码；agent 请求交给 ExecutionBackend，再由 SandboxBackend 和 Local/WSL/Docker runner 执行命令。
4. 执行按 claim → execute → apply/fail 分段：claim 先持久化；外部执行不持 head.lock；返回后重新打开状态目录并校验 attempt/输出，再提交。CLI driver.lock 覆盖整段推进。
5. 消息、执行、未回复请求和活跃子实例共同派生未了结义务。自然终结依赖义务清空；truncate 使旧结果失效，不等价于跨进程物理停止任务。
6. ObjectStore 保存版本对象，head 格式 2 的 objectHeads 确定已提交版本集合。已测试进程中断恢复，不宣称断电刷盘、外部副作用恰好一次或分布式租约。
7. ControlPlane 提供带授权的操作；整体推进只接受根作用域，子树读取和定点 send/truncate 继续按目标授权。RunState、CLI 和 MCP 是组合与接入层，不是另一套引擎。
8. 观测走 RunState → exportSnapshot → parseSnapshot/buildScene → 差量 → HTTP → page.html。Scene 是摘要投影，消息正文、完整 execution 身份和产物证据要通过专门查询提供。

本轮没有复现新的纯内核状态机缺陷。下列问题主要位于执行适配、投影与页面接线；不能据此推导整个内核已无 bug。

## 当前确认的问题

| ID | 级别 | 证据与影响 | 修复边界 |
|---|---|---|---|
| R01 | P1 | 两个真实 WSL 沙箱运行同一条本次实验专用命令，只 cancel 第一个，二者均退出 code=9；第二个 cancelled=false，未写完成标记。`wsl.ts:135` 用完整 argv 做 `pkill -f` 匹配 | 按本次执行的进程或进程组取消；增加同命令并发反例，不扩成全发行版匹配 |
| R02 | P2 | `.gitignore` 经过 backend.ts:373 的去扩展名变成空 object_id；完整 CLI drain 连跑 3 个 attempt，最终 INVALID_OUTPUT，零产物。`answer.md` 与 `answer.txt` 则静默成为 job/answer@1、@2 | 定义无碰撞的文件到对象身份映射，保留文件可区分性；处理旧产物命名的兼容，不仅改一个字符串 |
| R03 | P2 | A 上报 1/10、B 上报 9/10，$exec 历史各自正确，但 exportSnapshot 把两条 record 都投影成 B 的 9/10。snapshot.ts:125 按实例取 $exec head，未按 execution 关联 | 先关联正确执行证据，再取每节点适用进度；不要从整个实例的最新观测复制 |
| R04 | P2 | 首次读取 /templates 只有 root@1；spawn 后多出 worker@1。page.html:458 只取一次模板，后续仅消费 scene 差量，新子实例的定义和端口无法补齐 | 按精确 ref 缓存可以继续；缓存集合需要按需补全，不能等同于只请求一次 |
| R05 | P2 | 无凭据请求首页能得到当前 token，用它读 /scene 返回 200；与 serve.ts:16“挡住同机其他进程”的注释矛盾 | 明确本地信任边界与页面引导方式；未来接写操作前处理，不把当前 token 当成调用者身份验证 |

R01 是真实 WSL runner 实验；R02 是真实 Node agent 经完整 CLI drain；R03 是受控 backend 经真实内核、持久化和导出；R04 是模板接口生命周期实验结合页面代码；R05 是真实 HTTP 请求。不是所有结论都有真实浏览器证据。

页面静态检查还看到：详情只在点击时生成，后续 render 不刷新已选详情；请求未检查 HTTP 状态，renderAuthz 的异步失败未收口；流结束/出错没有重连。尚未在真实浏览器复现，列为待验证项。

## 最新信号修复的结果

真实 Windows LocalRunner 子进程启动后，让持锁的 drain 进程执行其 SIGINT 处理器：退出码 130、driver.lock 消失、后续 drain 把 exec-1 判为失败并执行 exec-2。

在当前 Windows 环境，第二次执行开始时旧子进程已不存在，也没有在驱动退出后写标记。因此“解锁必然留下旧任务并行运行”没有在本机复现，不能登记成已确认回归。

该实验和新增单元测试都通过 `process.emit("SIGINT")` 触发处理器，没有测试终端 Ctrl-C 的 OS 递送。源码仍直接 releaseHeldLocks + process.exit，没有建立跨进程 supervisor 或持久化物理取消协议；对 WSL/Docker 的进程残留不能由本实验作保证。

## 渠道完整性

| 用户动作 | CLI | MCP | HTTP / 当前页面 |
|---|---|---|---|
| 校验与注册模板 | validate/run/init；没有独立模板库管理命令 | validate_template、define_template | 只有运行所用模板的读取，无草稿、版本编辑或注册写通道 |
| 创建和选择运行 | init 指定目录；每目录单根 | create_run，服务绑定一个目录 | 无运行列表、创建、选择和服务管理 |
| 投消息、创建子实例 | send；子实例通常由流程 handler 创建 | send_message、spawn_child | 无写入口 |
| 执行 agent | drain 显式指定 runner | advance 明确只推进同步 handler | 无启动、runner 配置、驱动任务句柄 |
| 截断 | truncate，逻辑作废 | truncate_instance | 无操作入口；跨进程物理取消仍不完整 |
| 状态与图 | status、scene、templates、scene --watch | get_status 摘要 | scene/templates/authz/scene-stream 有；新目录锁只在 CLI status 展示 |
| 消息原因与对象证据 | why、show、history | explain_message、read_object、list_versions | 无详情查询通道；Scene 不能替代这些内容 |
| 资源与权限 | resources、permissions | 无对应资源管理工具 | 无 |

实测 `/scene`、`/templates`、`/authz` 为 200；`/status`、`/objects`、`/runs` 为 404；带 token 的 POST /scene 为 405；无 token 的 GET /scene 为 401。

另一个契约差异：CLI 的 CommandResult 有 data，MCP 工具自身主要返回 text/isError，各渠道尚未共用完整的结构化业务结果。MCP get_status 也没有复用新增的 CLI dirLocks 输出。

实时能力应如实表述：watchScene 轮询 head 并发差量；SandboxBackend 在 runner 返回后才读 journal/progress。目前没有执行中的实时日志、语义进度采集推送链。

## 设计前的建议出口

优先修 R01、R02，再修 R03/R04；随后明确 R05 和读服务错误/断线语义。按既有“反例 → 小切片 → 验证 → 单独提交”流程进行。

然后用一条最小闭环验收前端所需 API：模板草稿 → 校验 → 注册精确版本 → 用该版本建独立 run → 显式选择执行面并启动 → 观察状态 → 读取某次 execution/产物 → 截断或结束。

模板操作与运行操作应在对象和生命周期上分开；可以继续共用版本库、ControlPlane 和投影。先定义这条闭环的输入、返回值和错误，再讨论页面布局。当前适合做只读观察原型，还不足以开始完整模板/运行工作台的视觉定稿。

## 文档需要对齐的事实

- ONESHOT 的 A-1 retain、A-2 Docker 内网、A-8 safeId 已有修复；C-3 scope 通过只接受根作用域收紧；C-6 真强杀持久化测试已补。不能照旧表重复开发。
- README/FOUNDATION 的部分统计、持久化现状和执行面“未实现”标记已过期。以本次测试和 ITERATION/DEVELOPING 中已落地的边界为准。
- A-4 usage 硬编码 0、默认墙钟上限缺失、配置失败落重试档仍能从当前 backend 看到。usage=0 不等于真实消耗为 0；本次未调用模型做成本测量。
- 全局运行身份、跨进程物理取消/恢复、可复用模板目录、消息正文长期回放仍是单独的能力缺口，不包装成修几个按钮即可完成。

## 验证与复跑

基线完整验证均退出 0：867 passed / 7 skipped；7 个包 typecheck；196 个导出无孤儿。
分包：contracts 68、kernel 305、sandbox 188 passed + 7 skipped、state 81、CLI 156、MCP 17、scene 52。
Docker daemon 不可用，7 条真实 Docker 集成测试跳过。原有真实 WSL 用例通过；本轮另做 R01 并发取消实验。

```powershell
corepack pnpm exec tsx experiments/2026-09-07/audit.mts
corepack pnpm exec tsx experiments/2026-09-07/projection.mts
corepack pnpm exec tsx experiments/2026-09-07/wsl-cancel.mts
```

输出：results.json、projection-results.json、wsl-results.json。每次使用新临时目录；不调用模型，不读模型密钥，不打开用户现有 run，不删除旧现场。
WSL 实验命令包含一次性 UUID 路径，只匹配本次两个 fixture；子进程最长 sleep 4 秒。实验先检查 wslAvailable。本机冷启动时曾出现 UNC 写入后 Linux 侧不可见的夹具准备失败，预热后实验正常；没有把该环境现象定为产品 bug。

浏览器实验宿主：`corepack pnpm exec tsx experiments/2026-09-07/audit.mts serve`。
地址和临时 run 路径写入 browser-session.json，不保存 token。可在其 root 下创建 advance/restart/stop 标记驱动这份实验；它们只影响新建的测试 run 和测试 HTTP 服务。

当前 Chrome 不在 CUA 的可用连接中；启动命令被自动执行审查以“blocked by policy”拒绝。已询问是否允许改用内置浏览器，尚未获得答复，因此没有声称完成真实浏览器交互、视觉或可访问性验收。本轮测试 HTTP 服务已关闭，browser-session.json 保存的是取证时地址。

完整测试日志在本机 `%TEMP%/hertaloy-audit-20260907-tests.log`，类型日志为 `%TEMP%/hertaloy-audit-20260907-types.log`。
