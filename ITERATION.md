# Hertaloy 迭代约定与本轮修复台账

本轮基线：2026-09-06，`81f622f`。依据当前源码、近期提交、`V5_WORKPLAN.md` 的历次审核记录，以及 `experiments/2026-09-06/` 的实测。`ONESHOT.md` 是工作区中的对齐草稿，其漂移表需要逐项复核，不能直接视为当前事实。本轮不冻结前端设计。

## 从历史沿用的规则

- `23ee8dc`：同一不变量的校验应共用；同步 handler 的事务与外部执行的三段式有实际差异，不强行合并。
- `0956680`：工作区交接从持久执行记录派生，避免另一份进程内账本；跨模块既测消费者，也测生产者是否真的供给。
- `3fb6fce`：通知发出还不算完成，要验证下游真正消费；修复前先证明测试会失败。
- `a7a7741`、`a1fda17`：接口接线必须同时覆盖真实数据与拒绝授权的反例。
- `e9c1a8a`：模板版本不可变、运行状态可变，两条读取路径保持分离。

历史结论也要复核。例如 `V5_WORKPLAN.md` 曾以“拿到写锁时 RUNNING 必为孤儿”支持恢复逻辑；目前 agent 在写锁外运行，该论据已不成立。

## 每批的流程

1. **登记**：写明触发、期望、实际结果、证据，以及 bug / 能力缺口 / 待核实的分类。
2. **先行审核**：追到当前强制边界，检查最小修法是否破坏 pin、事务、generation fence、授权及锁外执行。结论可以是采纳、改方案、延后或不采纳；不能只累加建议。
3. **反例先红**：使用确定性本地输入；并发用屏障控制时序；测试断言用户可见的结果与失败后的状态，不只断言返回码。
4. **最小修复**：一批解决一个根因；复用已有机制；新增机制必须说明原机制为何无法表达该事实。
5. **验证与复审**：运行受影响测试与类型检查；检查 diff 的拒绝路径、跨入口一致性和实际接线。受环境限制的测试单列，不改成假通过。
6. **原子提交**：只暂存本批文件，提交说明原因和验证结果；保留工作区已有改动。收尾跑 `corepack pnpm test`、`corepack pnpm typecheck`、`corepack pnpm reachability`。

产品语义、公开契约扩展与 bug 修复分开讨论。尚未验证的旧文档条目不得写成“已修”；新发现的问题进入台账，避免顺手扩大当前批次。

## 本轮先行审核

| 编号 | 级别 / 分类 | 复现与根因 | 审核决定 / 验收 |
|---|---|---|---|
| H01 | P1 / bug | 本机 sandbox 39 条失败、CLI 14 条失败；观察器通过无 shell 的 exec 启动 `mkdir -p`，Windows 没有该可执行文件 | 采纳：由 git init 自己创建外置记录仓，继续在 runner 所属环境执行；验证不存在的多级记录仓和真实文件差异 |
| H02 | P1 / bug | 实验 02：overlay 跳过执行规格、信号和根别名检查；MCP define 未注入执行面校验；缺失 child ref 在没有 entry 时被放过；CLI validate 对任何 extends 对象直接成功 | 采纳：完整模板与物化 overlay 共用注册校验，MCP 注入同一执行面校验，静态 validate 只承诺自己确实检查的部分；拒绝后不得追加版本 |
| H03 | P1 / bug | 实验 06：第二个 drain reconcile 尚在运行的 attempt，又 claim 同一消息；旧结果还能消费新 attempt 的 CLAIMED 消息 | 采纳根因；修复须同时约束驱动所有权与迟到结果，不能把写锁重新持有到 agent 结束；验证只启动一次、外部 send/truncate 仍可进入、旧结果不改变新 attempt |
| H04 | P1 / bug | 实验 07：仅获 job/a 权限的主体 run(job/a) 实际执行 a、b；settleAll/reconcile 同类全局行为 | 采纳；按实际作用范围授权或实现真实子树限制，须明确兼容行为并验证兄弟子树不受越权操作影响；不以隐藏 UI 按钮代替后端检查 |
| H05 | P1 / bug | MCP advance 返回失败后重开目录，消息仍是 QUEUED，失败转移没有落盘 | 复审新增并采纳：正常返回的执行失败也保存；抛出的授权/校验异常仍不提交 |

本表是修复前的审核结论，完成情况和具体方案在下方逐批登记。历史基线为 719 passed / 53 failed / 7 skipped（779 条）；这是当前 Windows 环境结果，不能与其他平台历史提交的全绿数字混用。

## 需要另行补充的能力

| 项目 | 当前边界 / 下一步 |
|---|---|
| 模板资产操作 | `templates` 只返回实例使用的版本；模板目录、草稿、派生编辑不在现有 API 中。围绕模板与运行分离另做接口设计 |
| 人工回复 | 普通 send 到 callback 不等于关联 REPLY，实验 04 已证明；需要明确人工回复能力，不能顺手解除不相关请求 |
| 物理取消 | 实验 05 的跨进程 truncate 能挡迟到 apply，但不能调用另一个进程的 backend.cancel；驱动归属、进程终止和恢复需共同设计 |
| 数据溯源与历史 | why 跟踪触发消息，不记录 collect 读取的全部历史版本；旧消息正文会被裁剪。完整回放需要先定义保留与读取依赖契约 |
| 执行与持久化 | 多 run 的 executionId、对象/head 崩溃窗口、真实 kill9 恢复，以及 ONESHOT §8 中 retain/network/usage 等条目逐项核实，不能仅据旧草稿批量修改 |
| 前端 | 旧画布和设计稿属于实验；本轮优先建立可信接口和运行行为，再讨论模板操作与运行观察的布局 |
| 子树推进 | H04 先封闭全局操作的授权，明确拒绝子树参数。真正的子树驱动要同时定义调度、向外发消息、子终止通知及恢复边界，再单独实施 |

## 批次记录

### H01：Windows 观察器初始化

- 反例先红：目标环境只提供 git 时，旧实现报“没有可执行文件 mkdir”。直接删除 mkdir 的试修仍在不存在的多级父目录下失败，未采纳。
- 最终修法：`git init --bare --quiet <记录仓路径>` 创建目录，后续继续显式传 `--work-tree`，不往 workspace 留 .git。
- 验证：观察器 15/15，sandbox 146 passed / 7 skipped（含真实 WSL），CLI 148/148，sandbox typecheck 通过。
- 复审：没有改变 LocalRunner 的无 shell 执行策略；本地与 WSL 共用原 runner，未硬编码宿主机路径。Docker daemon 未运行，7 条测试维持跳过。

### H02：注册校验闭合

- 反例先红：kernel 5 条、CLI 2 条、MCP 1 条明确复现；另有普通根模板拒绝与合法 overlay 的对照。
- 修法：overlay 只物化正文，回到普通注册路径执行全部校验后一次落库；没有 entry 的子槽也检查引用。MCP writable 注入 `checkAgentSpec`；CLI validate 先解析覆盖层自身结构，仍明确提示基定义校验尚未完成。
- 验证：kernel 285/285、MCP 16/16、CLI 命令测试 13/13，三个包 typecheck 通过。
- 复审：内核继续接受宿主自定义执行规格；没有把 sandbox 的具体 schema 移回 contracts/kernel。物化对象的 kind、基定义 provenance 与实例 pin 语义保持不变；拒绝不追加模板版本。

### H03a：迟到结果不能再次结算

- 9 条反例全部先红：重试重新 claim 后、截断后，分别送达旧成功、失败、非法值、异常；另验成功后的重复非法值。
- 修法：apply/fail 的共同前置条件是 attempt 仍为 RUNNING，检查早于读消息、清 driving、写观测。仅检查 generation 和 CLAIMED 不能区分同一消息的两次 attempt。
- 兼容变化：迟到结果仍返回作废失败，但已结算记录保留原来的 SETTLED / termination，不再被迟到结果改成 VOIDED；三条旧测试同步改为检查这个更严格的保持性质。
- 验证：kernel 294/294、state 65/65，两个包 typecheck 通过。新 attempt 的 driving 和 CLAIMED 不变，合法新结果仍能消费消息。

### H03b：CLI 独占驱动权

- 真实双进程反例先红：子进程已 claim、等待屏障期间，父进程的第二次 drain 仍成功。修复后第二次被拒，同一条消息只启动一次。
- 修法：复用文件原子排他的 StateLock，新增固定用途 `driver.lock`，覆盖整个 drain；`head.lock` 仍按每步释放。恢复前改走 `control.reconcile`，先授权再操作。
- 验证：包含并发、挂起 agent、状态命令及工作流的 56 条测试通过；state/CLI typecheck 通过。跨进程 send/truncate 可提交、完成及授权失败都释放驱动锁，无权恢复不改遗留记录。
- 复审边界：这是本地 CLI 的单驱动约束，不是执行租约。崩溃后与既有 head.lock 一样保守拒绝，需确认旧持有者已结束再清理；不自动抢锁。直接嵌入内核的宿主仍负责驱动归属。两个锁保护不同寿命的事实，合用 head.lock 会重新阻断截断命令。

### H04：全局操作按根授权

- 10 条反例先红，证实 run/runAgents 执行兄弟任务、settleAll 结算兄弟、reconcile 修改兄弟 attempt，以及 causesOf 返回兄弟消息因果。
- 审核选用较小的封闭方案：五个操作共享根授权检查；即使调用者有根权限，也明确拒绝子树 scope，避免默默扩大操作范围。没有把真正的子树调度夹带进本批。
- 验证：kernel 305/305、typecheck 通过。拒绝后 runtime/registry/store 不变，根权限的完整执行与子树读取仍可用。

### H05：MCP advance 失败后的持久状态

- 复审发现 writable 把 `isError` 当作“不应保存”的标志；同步推进失败是已经发生的状态转移，应保存 attempt 和 FAILED 消息。
- 反例先红：advance 返回失败后重开目录，msg-1 仍为 QUEUED。修复后 FAILED 与失败原因均保存，再次 advance 提交 0 次。
- 修法：正常返回表示操作已完成处理，应落盘；抛异常的路径仍不提交。`isError` 是呈现给调用方的业务结果，不是事务回滚标志。
- 验证：MCP 17/17、typecheck 通过，原有权限拒绝和非法模板不落版本的断言继续通过。

## 本轮收尾（2026-09-06）

| 批次 | 提交 |
|---|---|
| H01 Windows 观察器 | `a6259db` |
| H02 注册校验 | `c9b64fc` |
| H03a 迟到结果 | `83d93b0` |
| H03b 驱动排他 | `b2f95eb` |
| H04 根作用域授权 | `212002f` |
| H05 MCP 失败持久化 | `045472b` |

完整验证在以上六批修复之后运行，三个命令均退出 0：

- `corepack pnpm test`：806 passed / 0 failed / 7 skipped，共 813 条（新增 34 条）。contracts 68、kernel 305、sandbox 146 passed + 7 skipped、state 65、CLI 153、MCP 17、scene 52。
- `corepack pnpm typecheck`：全部 7 个包通过。
- `corepack pnpm reachability`：193 个导出符号，无孤儿。

测试包括真实 WSL 执行与真实双进程的 CLI 排他；Docker daemon 未运行的 7 条测试未宣称通过。原始输出在本机 `%TEMP%/hertaloy-bugfix-full.log`，旧实验结果保留，不用修复后数据覆盖历史复现。

本轮结论限定为 H01–H05 的修复，不代表旧文档漂移表全部清零。后续建议先核实对象/head 崩溃窗口与执行面配置条目，再设计执行归属、物理取消和子树调度；模板目录、人工回复和完整溯源保持独立议题。

工作区原有的 `package.json` 覆盖率依赖、`pnpm-lock.yaml` 对应改动、sandbox 测试入口路径修正，以及未跟踪的 ONESHOT/vitest workspace 配置均保留。MCP 新增 sandbox 依赖的三行锁文件变动单独入提交。

## 续轮（基线 023785c）

### H06：节点保留策略实际生效

- P1 / bug：`capabilities.retain` 写进诊断，finally 却始终按 backend 默认值清理；会误删显式要求保留的工作区，也会留下要求删除的工作区。
- 先行审核：采纳。解析规格后只计算一次有效策略，正常结果和异常清理共用；不改变保留策略的既有语义。
- 反例先红：8 个真实本地执行用例中，6 个节点覆盖用例失败，2 个默认值对照通过。断言诊断与磁盘目录的实际存在性。
- 修复后：8/8 通过，sandbox typecheck 通过；覆盖 always / never / on-failure、成功与失败、缺省回退。

### H07：对象与 head 的提交边界

- P1 / bug：先刷对象再写 head，中断后全部对象被加载，数量超出旧 head，状态无法打开；同一对象版本重放为不同正文时，现有文件又会被误当作已经写好。
- 先行审核：采纳。head 增加每个对象的已提交版本上限，作为加载清单；未提交文件不参与读取，也不能随总游标增长混入。对象文件用临时文件加 rename 发布，内存刷盘游标在 head 成功后推进。
- 兼容边界：新 head 格式升级，继续读取格式 1；旧格式须先通过既有完整性检查，首次保存先发布旧状态的版本清单，再刷新增对象。对已经损坏、无法判定提交集合的旧目录拒绝猜测。
- 验收：刷对象后中断、重放为不同正文、长期遗留无关对象、旧格式升级中断、保存失败后的同进程重试，以及已提交文件缺失仍须拒绝。只承诺进程中断恢复，不把它等同于断电 fsync 保证或自动抢占遗留锁。
- 反例先红：首批 6 个用例中 5 个失败，证实无法打开、重放正文错误和游标提前推进；旧损坏目录拒绝的对照通过。
- 复审补充：只读或已关闭的 RunState 原来也能 persist，2 个反例先红；保存现在检查该实例仍持有写锁，避免旧快照反向覆盖提交。
- 验证：state 80/80、typecheck 通过。新增 15 个用例，包括真实子进程分别在写半截对象临时文件、替换 head 前被强制结束，父进程读取旧提交并成功继续保存。清单缺失/计数非法、对象版本号不符和既有缺文件用例继续拒绝。
- 取舍：用 head 内每对象一个版本上限表达提交集合，不引入独立日志、序号账本或清理事务；head 空间随对象数量增长。未提交候选保留在磁盘，可能在同一路径重放时替换，不做后台回收。旧目录中已经无法分清提交集合的数据不自动修复，格式升级后旧程序须使用升级前副本回退。
- 收尾复审 H07b：读者已读到格式 1 时，另一个写者可能完成升级，导致全盘扫描误报数量不符。反例先红后，限定仅在确认 head 已升级为格式 2 时丢弃不完整装载并重新打开；新格式损坏不会循环重试。新增该并发升级用例后，state 81/81、typecheck 通过。

### 后续待核实与设计项

- Docker：同名网络存在即接受，未验证 `Internal`；默认网络名和单次执行覆盖也需一起核实。当前 daemon 未运行，不能用参数测试冒充隔离验证。
- 执行身份：`safeId` 把多个字符折叠为 `-`，存在目录命名碰撞；修法须同时处理已有保留工作区的定位与交接兼容，不能只换名字。
- 物理取消、跨 run 执行归属、usage 计量与真正子树驱动继续保留为独立议题。本批不扩展产品 API 或重做前端。

### 续轮收尾（2026-09-06）

| 批次 | 提交 |
|---|---|
| H06 节点保留策略 | `f6c8650` |
| H07 对象提交边界与恢复 | `061b427` |
| H07b 升级中的并发读取 | `284d732` |

最终代码的三个完整验证命令均退出 0：

- `corepack pnpm test`：830 passed / 0 failed / 7 skipped，共 837 条，本轮新增 24 条。contracts 68、kernel 305、sandbox 154 passed + 7 skipped、state 81、CLI 153、MCP 17、scene 52。
- `corepack pnpm typecheck`：7 个包通过。
- `corepack pnpm reachability`：193 个导出符号，无孤儿。

包含真实 WSL、CLI 双进程驱动排他和两个强制结束写进程的持久化用例。Docker daemon 未运行，7 条集成测试维持跳过。最终测试原始输出为本机 `%TEMP%/hertaloy-bugfix-next-final.log`；用户原有覆盖率依赖、锁文件及 sandbox 测试路径改动保持原样，未跟踪文档、实验和配置也未纳入提交。

## 第三轮（基线 4455e49；每步验证后提交）

### H08a：验证 Docker 内网属性

- P1 / bug：`network inspect` 成功就视为内网，未检查 `Internal`；同名普通 bridge 或并发创建的错误网络会被接受。
- 先行审核：采纳。首次 inspect、创建成功、创建竞争失败三条路径均须检查实际网络名和 `Internal === true`；错误数据不触发重建，也不删除已有网络。
- 反例先红：8 个拒绝用例失败，涵盖属性缺失/错误、错误名称、空结果、坏 JSON 和两条创建路径。修复时调整测试参数封装，确保检查的是 Docker 返回的数组。
- 验证：网络校验和原 Docker 单元测试 20 passed / 7 skipped，sandbox typecheck 通过。旧成功用例改为真实 inspect 的响应形状；daemon 仍不可用，跳过真实容器测试。

### 后续切片审核

- H08b：节点覆盖 `internal` 未建网，全局默认名导致不同运行混网。采纳：按分配身份与工作根隔开默认网络，在实际 run 时按生效策略准备内网；显式 networkName 仍表示调用方主动共享。
- H09：backend 交给 DockerRunner 的子目录一律名为 `box`，容器名因此恒为 `hertaloy-box`。采纳：每次 run 使用独立容器身份，启动与取消引用同一身份，验证并行取消不碰兄弟容器。
- H10：safeId 的字符折叠及 Windows 大小写折叠会造成工作区覆盖。先核实旧 request.json 能否证明工作区归属，再决定兼容读取；不盲目删除或迁移旧目录。

### H08b：网络按实际执行策略和运行组生效

- 5 个执行边界反例先红：缺省 none 覆盖 internal 不建网、缺省 internal 覆盖 none/open 仍建网、不同根混网、显式共享网络未验证、外网仍启动 agent。
- 修法：allocate 只登记挂载与网络归属，run 根据最终策略准备并验证内网。默认网络名由工作根、原始根 trace 的完整 SHA-256 摘要生成；未给身份的分配各自组网。显式 networkName 保留主动共享语义。
- 验证：新增 6 个 runner 用例，相关测试 26 passed / 7 skipped，sandbox typecheck 通过。通过模拟 Docker CLI/进程观察真实 runner 的准备顺序、启动参数和拒绝路径，不宣称实际隔离已测。
- 兼容：默认不再连接旧的共享 `hertaloy-default`，不自动删除旧网络；同工作根且同根 trace 仍视为同一组。跨宿主/多租户全局运行身份需另行设计。

### H09：容器身份属于一次 run 调用

- 两条反例先红：不同沙箱的 box 目录并行运行、同一目录连续运行，原容器名都为 `hertaloy-box`。
- 修法：由实际分配根的名字加每次调用的 UUID 生成容器名；启动与该调用的超时/取消继续共用同一个局部 name。
- 验证：Docker 生命周期与现有 Docker 用例 20 passed / 7 skipped，sandbox typecheck 通过。取消第一个模拟执行只发对应的 docker kill，第二个仍挂起并可正常完成；不把它描述成跨进程物理取消。

### H10：工作区身份、旧布局定位与排他分配

- 首批 14 个反例先红：斜杠/冒号/空格/Unicode/大小写折叠、过长名字、Local/Docker 覆盖旧文件、WSL 路径重名，以及旧布局错误归属未拒绝。
- 修法：目录名用有界可读前缀加原始身份 JSON 的完整 SHA-256 摘要；三个 runner 共用定位规则。新增目录原子排他创建，写入 box 外的身份标记；同一身份重复分配直接拒绝，不读取旧 emit，也不删除旧现场。
- 兼容：新布局优先；旧布局只有 request.json 的 traceid/nodeId/executionId 与所求身份吻合才返回。缺失、损坏、归属不符均拒绝并保留目录；新分配不在旧路径上清空或迁移。身份标记只用于目录归属，不是授权或执行租约。
- 跨层验证：新增共 18 个用例，包括旧布局经新 backend 的 workspace.from 完成真实 Node 执行、旧文件保持不变，以及重复分配和新标记错误的拒绝。sandbox 188 passed / 7 skipped（含真实 WSL），typecheck 通过。
- 复审修正：profile 的两条旧测试使用固定全局临时路径，第二次跑时被新的排他规则拒绝。改为测试私有临时工作根并清理；再跑 profile、身份与 Docker 生命周期 34/34，通过类型检查。
- 边界：同一工作根中完全相同的执行身份仍是冲突，只做保护性拒绝；尤其多个 CLI WSL run 仍可能共用 `/tmp`。全局 run 身份和 WSL 按状态目录命名空间需连同旧运行兼容单独设计。
- 全仓首轮发现一个旧 CLI 断言仍要求目录名包含完整 exec-1，而新名字只保留短前缀。改为核对完整身份标记，并由新 runner 定位同一目录；目录归属保证未放宽。CLI agent-run 18/18、typecheck 通过，测试调整单独提交。

### 第三轮收尾（2026-09-06）

| 步骤 | 提交 |
|---|---|
| H08a 内网属性校验 | `0be7fbf` |
| H08b 实际策略与运行组网络 | `dec289e` |
| H09 每次调用的容器身份 | `0a2249d` |
| H10 目录身份、旧布局兼容与排他创建 | `4458f10` |
| CLI 身份读取与定位断言 | `43e0dde` |

每步均在相关测试及类型检查通过后提交。最终完整验证：

- `corepack pnpm test` 退出 0：864 passed / 0 failed / 7 skipped，共 871 条，本轮新增 34 条。contracts 68、kernel 305、sandbox 188 passed + 7 skipped、state 81、CLI 153、MCP 17、scene 52。
- `corepack pnpm typecheck`：全部 7 个包通过。
- `corepack pnpm reachability`：194 个导出符号，无孤儿。

最终日志：本机 `%TEMP%/hertaloy-bugfix-third-verified.log`。真实 WSL、Node 执行、旧工作区继承和 CLI 场景均通过；Docker daemon 未运行的 7 个集成用例保持跳过，网络与容器行为仅验证到 CLI/进程调用边界。用户原有三个文件改动及未跟踪文档、实验、配置保持原样。

## 第四轮（2026-09-07）：驱动锁运维缺口 + 外部审核 R01–R05

基线 `75b8a89` 之前先补一处自查缺口，其余按 `experiments/2026-09-07/README.md`
的建议顺序（R01、R02 → R03、R04 → R05）逐条处理。

### D01：驱动锁被信号打断后残留

- **触发**：`b2f95eb` 的 `driver.lock` 跨越整个 agent 执行（分钟级），而
  `finally` 挡不住信号 —— Node 收到无监听器的 SIGINT 直接终止进程。
- **影响**：Ctrl-C 恰好最可能发生在持锁最久那段；残留的锁让之后每次 drain
  都失败，且 `isLocked()` 只认 `head.lock`，`status` 报不出来，无内建清理出路。
- **反例先红**：`× 中断后驱动锁被放掉 → expected 13 to be 130`。
- **修法**：`state/lock.ts` 加本进程持锁索引与 `releaseHeldLocks()`（只负责放，
  不定进程策略）；`drain` 持锁期间挂 SIGINT/SIGTERM，放锁后按 130/143 退出，
  `finally` 摘掉处理器。`lockHolders(root)` 给 `status` 单列一节。
- **环境限制**：子进程自发 `process.emit("SIGINT")` 触发处理器；Windows 上
  `subprocess.kill()` 会忽略信号名直接终止，真 OS 递送测不到，如实记在夹具注释里。
- 提交 `75b8a89`。

### R01：WSL 取消按命令行匹配（P1）

- **反例先红**：`× 同命令并发时取消只打到本次执行 → expected 9 to be +0`。
- **审核之外新发现**：`pkill -f` 的模式是**正则**。argv 带 `{}` 时
  `pkill: regex error: Invalid content of \{\}` —— 什么都没杀，而宿主机侧
  wsl.exe 被杀了，**外面报 CANCELLED，里面的 Linux 进程还活着**。
  第一版反例正好写了带 `{}` 的命令，因此在未修代码上通过，把 R01 掩盖了。
- **修法**：`setsid --wait sh <沙箱根>/run.sh`，脚本写 `$$` 到 `pgid` 再 `exec`；
  取消时宿主机侧读 pgid，`kill -9 -<组号>`。
- **路上两次同一个坑**：`wsl.exe` 把 argv 拼成命令行再让 Linux 侧重新解析，
  嵌套引号过不去 —— 启动侧 `exec "$@"` 的 `$@` 是空的，取消侧
  `sh -c "p=$(cat …)"` 同样失效。两处都改成扁平参数。
- 提交 `119c3d5`。

### R02：产物文件名到对象身份的映射（P2）

- **反例先红**：`['answer','answer']`（碰撞）、`['']`（空 object_id）。
- **修法**：去掉去扩展名那一步 —— `ASSET_SEGMENT` 本来就允许点号，那一步没换来
  任何东西，只是把文件身份弄丢了。首字符也放开点号（危险的是相对段 `.` 与 `..`，
  两者单独拒），`.gitignore` 这类文件因此能当产物。
- **兼容**：已存对象 id 不动；按精确 ref 引用不受影响，按名字 collect 的用户模板
  需改成带扩展名，且只对新产物生效。
- 提交 `84ac45b`。

### R03：进度投影串台（P2）

- **反例先红**：`× 两条执行记录各带自己的进度 → expected 9 to be 1`。
- **修法**：按 `$exec` 正文里已有的 `execution_id` 建索引（整棵子树扫一遍，
  不是每条记录各扫一遍）；没有对应观测的记录不带进度，不拿别人的顶上。
- 提交 `cd1c427`。

### R04：模板缓存集合不补齐（P2）+ 页面读接线

- **真浏览器验证**：先加载页面再从另一进程 spawn。补齐关掉时子节点端口为 `[]`，
  打开后为 `["in","out"]`。
- **修法**：已有 ref 不重取，出现不认识的就整份重拉一次。顺带三处静态检查项：
  请求检查 HTTP 状态、详情按 id 每帧重取（原来点开即冻）、流断退避重连。
- 提交 `b24e8f1`。

### R05：本地信任边界（P2）——只改说法，不改模型

- 审核结论是"未来接写操作前处理"，本轮**不改安全模型**，只让代码说真话：
  原注释"挡住同机的其他进程"是假的 —— 首页把 token 交给浏览器，本机任何进程
  GET `/` 就能拿到。用例把真实边界钉住（首页 200 且含 token，拿去读 `/scene` 也是 200）。
- **待决定**：写操作落地前必须重新定这条边界（token 不再从首页发、由人转交，
  或走真正的本地认证）。这是设计题，不在本轮范围。

### 仍然欠着

- `objectHeads` 随实例数增长，而头每次全量重写 —— 与 `AUDIT_KEEP`、
  `keepConsumedMessages` 同病，只是常数小。需要定清单的规模上界。
- 审核列出的其余能力缺口（模板目录、人工回复、跨进程物理取消、消息正文长期回放、
  各渠道结构化结果统一）未动，不包装成"修几个按钮"。

## 第五轮（2026-09-07）：前端反馈复审 F01–F07

依据 `experiments/2026-09-07-feedback/README.md` 的切片顺序 S1 → S2 → S3。
S4–S6（运行摘要与详情查询、语义进度采集链、模板依赖查询）是接口设计题，本轮未动。

### S1 / F01：流先授权再写头，失败要收口

- **反例先红**：`× 无权主体的流也是 403 → expected 200 to be 403`，同时
  `Unhandled Rejection: AuthorizationError`。
- **两个错叠在一起**：`writeHead(200)` 排在授权之前（头出去就改不了状态码）；
  `void watchScene(...)` 只有 `.finally()` 没有 `.catch()`，抛出把进程带走 ——
  **一次被拒的读取打死了服务**。
- **修法**：先算一帧做授权前置；流中途失败发一帧 `{error}` 再收口。
  页面这侧同步接上：见到 `error` 就抛给重连，不当差量合并。
- 提交 `e80ccd6`。

### S1 / F06：可选观测坏掉不该毁整张图

- **反例先红**：`× backend 报了坏进度，scene 仍然出得来 → Error: 快照格式不符`。
- **分工**：结构事实（实例/消息/执行状态）严格，**观测宽容**。`diagnostics` 是
  执行面塞进来的普通 JSON，导出这一层是唯一能挡住它的地方。
- 不合法就不带，并标 `progressUnavailable` ——「没上报」与「报了但坏」是两回事。
- 两侧各验一半：state 验导出形状，cli 验整条链（state 不为一条用例反向依赖 scene）。
- 提交 `4068b97`（含下面两条附带）。

### S1 附带：上一轮我留下的两处

- **测试自证不足**：`progress-projection` 里"没有观测的记录"那条在队列已空时
  `claimAgent()`，注释说的记录根本没造出来，断言却通过。改成先送第二条消息、
  claim 并断言 RUNNING，再验它没有进度。
- **topUpTemplates 每帧空转**：把子槽的 `identity` 也算进"缺的"，而 `/templates`
  只返回已有实例的 —— 每帧发现缺、每帧重拉、每帧仍然缺。改成只问实例用的模板，
  `asked` 再兜一层。「已声明依赖」是另一个查询范围，接口尚不存在。

### S2：F02 + F03 + F07（同批，因为共用同一组用例数据）

- **F02**：相位与进度各自 `records.find(...)` 取第一条 —— 重试之后那几乎一定
  不是当前那条，而且两处可能取到**不同**的记录。收成一个 `currentRecord()`：
  在跑的优先，否则最后一条非作废，VOIDED 永不当当前。投影带上 `executionId`，
  Cell 带上 `execution`。导出侧把"记录按执行创建顺序"写成明文承诺。
- **F03**：tether 的身份被两处各自手写（`a b c` vs `a|b|c`），`removed` 永远
  匹配不到。给 Tether 一个由 scene 一处给出的 `id`；四个集合键法收成一种，
  页面不再自己拼任何键。
- **F07**：产物归属从 object_id 切段推 —— `job/reports/result.md` 推成
  `job/reports`，那个实例不存在。改读 `provenance.traceid`；没有归属的旧对象
  不上画布。
- 夹具随导出格式重跑（第二次；定格夹具会与导出端各自演化）。
- 提交 `367f14c`。

### S3：F04 + F05（真浏览器验证）

- **F04**：每条连接的首帧是**基线**不是增量，跨连接继续合并会让旧流永久残留。
  `consume()` 开头清空本地场景。验法：spawn 子实例 → 制造断流 → 把 head 回退到
  spawn 之前 → 重连后该实例确实消失。
- **F05**：同端口重启换 token，而页面里的 `TOKEN` 是加载时内嵌的常量，退避是
  纯空转。401/403 识别成 `Expired`，停止重连并提示刷新。验法：同端口重启后
  状态栏变成"凭据已失效 —— 服务可能重启过，请刷新页面"。
- 提交 `fe390ea`。

### 本轮未动（审核已说明是设计题）

S4 运行摘要与执行/消息/产物详情查询、S5 语义进度与日志采集链、S6 模板依赖与
操作反馈。另外 `objectHeads` 规模上界仍欠着（第四轮已登记）。

## 第六轮（2026-09-07）：S5 复审与 S6

### S5 复审：现场反馈的缺席与身份

- 四个反例先红：沙箱缺席被说成空现场；CLI 提前摘掉 `--runner` 后又在余下参数里查它；切换节点收到旧响应；节点离开视口仍留旧现场。
- 修复：观察侧先确认日志目录可读，CLI 传递已解析的 runner，页面按请求的 execution 身份收响应并清掉失效现场。
- 验证：现场查询与页面异步逻辑 7/7，CLI typecheck 通过。页面用例执行页面脚本与 DOM 替身，不作为浏览器布局验证。

### S6a：声明依赖可查询、可消费

- 新增 `definitions <dir> [--scope]` / `GET /definitions?scope=`，从获准子树的固定版本展开子模板、端口契约与 overlay 基定义。
- 每个精确 ref 返回 kind、body、usedBy 和带字段位置的 dependencies；未实例化模板的 usedBy 为空。未使用资产及后来注册的新版本不混进来。
- 页面子槽详情消费同一出口；网络失败不再把缺失 ref 永久标记成已查过。
- 验证：模板查询、HTTP 授权和页面消费 6/6，CLI/kernel typecheck 通过；包含深层未实例化依赖、子树权限与运行 pin 不变。

### S6b：校验与注册的结构化反馈

- 抽出注册前的纯准备阶段，干跑与注册共用结构、连接、子模板、契约、别名、执行规格及 overlay 物化校验；错误保留 `where/code/message/severity`。
- CLI 新增 `validate-definition` 与 `define`；HTTP 新增仅计算、不落盘的 `POST /validate-definition`（256 KiB 上限，依然要求 token）。完整干跑解析任意已有定义引用，因此要求全库 DQL；注册仍按定义 id 的 DDL 判定。
- MCP `validate_template` 给 id 时完整校验，不给时保留本地校验并明示 unchecked；注册、校验与新增 `get_definitions` 返回 structuredContent。旧 `validate --json` 也有机器结果。
- 注册返回实际 ref，干跑不预测或预留版本；正式注册仍重跑全部检查。HTTP 的读取异常收口到当前请求。
- 验证：kernel 310/310，相关 CLI 41/41，MCP 19/19；CLI/kernel/MCP 类型检查通过。含四种非法草稿与注册拒绝一致、overlay、实际 CLI、HTTP 错误/超限/无 token、head 不变。

### S6c：操作条件与通道反馈

- CLI `operations`、HTTP `/operations`、MCP `get_operations` 返回同一份操作条件，明确 permission、available、reasons 与 requires。权限仍由 ControlPlane 判定。
- 根作用域、终态、空端口/子槽、CLI 驱动锁与通道缺口分别编码；HTTP 写操作始终标为不可用。可用性只是当前条件预览，正式操作重新授权、检查参数及获取锁。
- 实验页面显示所选实例的操作条件，保留模板与运行分离；现场/操作查询遇到凭据失效停止轮询，避免场景流停了侧栏仍空转。
- 验证：CLI 模板/页面反馈 17/17，MCP 19/19，CLI/MCP typecheck 通过。覆盖 DQL-only 预览与拒绝注册、终态/子树/通道限制，以及 HTTP 配置损坏后恢复读取。

### S4/S5 消费闭环复审

- 新增带对象权限检查的 `GET /object?ref=`；页面保留结束后的执行详情，可从 `$exec` / 产物精确引用读取正文，并展示语义进度及 note。
- 修正仅有子树权限时整条消息详情被根因果查询拒绝的问题：消息仍可读，完整因果单独返回 `causesUnavailable`，不伪装成零前因。
- 补齐异步反例：终态到达时旧现场请求未返回，会主动补查结算详情；快速切换对象引用时忽略迟到的正文。
- 验证：CLI 对象/消息/模板/页面/服务相关 82/82，CLI typecheck 通过。对象出口按精确 ref 读取，范围外已存在/不存在对象都返回 403。

### 最终展示语义复审

- 浏览器观察到运行中的实例被旧相位映射显示为 idle；新增原始 `Cell.lifecycle` 并让实例标签显示 OPEN/TERMINAL。生命周期不作为执行成功/失败结论，覆盖率标签明确写“覆盖”。
- state 已导出 `progressUnavailable`，但 buildScene 丢掉了它；补齐 Cell 字段及透传，区分没报进度与坏采集。
- 两个反例先红后绿，scene 60/60，scene/CLI typecheck 通过。

- 真实执行实验还发现 `$exec` 被重复计入用户产物；查询现在排除该执行观测对象。新增反例先红后绿，现场/结果查询 6/6，CLI typecheck 通过。

### 整体复验与前端讨论入口

- 最终实现基线 `36fe19c`：全量 929 passed / 7 skipped，7 个包 typecheck 通过，reachability 203 个导出无孤儿。Docker daemon 未运行，7 个真实 Docker 集成用例跳过。
- 新增可重复执行的 [可见性实验](./experiments/2026-09-07-s6/README.md)，通过真实 CLI 子进程与 LocalRunner 验证运行现场、自动重试、历史失败、当前进度、精确产物正文、固定模板依赖、操作限制、重启后的旧 token 和内核不变量；不调用模型。
- 经用户明确允许，使用 Codex 内置浏览器验证日志自动追加、未实例化子槽定义、终态详情与产物正文、凭据失效提示及刷新恢复。最终页面另核实生命周期、覆盖率和观测/产物分离。实验监听已关闭，临时 run 留作排查证据。
- S4/S5 复审与 S6 已完成。在本机只读观测及现有 CLI/MCP 操作范围内，基础可见性满足进入前端信息结构与交互设计讨论的要求；接口约定汇总到 [DEVELOPING.md 第 8 节](./DEVELOPING.md#8-前端信息反馈接口s4s6)。
- 后续设计仍需明确 HTTP 写入与认证、全局模板目录和草稿、完整历史/日志回放，以及数据规模与保留上界；跨进程物理取消仍无承诺。旧页面只作为消费接口的实验载体，本轮不冻结前端设计。

## 第十轮：内核复审 —— 一个真 bug、两套并存机制、一处二次成本

通读 kernel 包（22 个文件 4858 行）之后逐条落地。基线 `0944dd2`。

### 一、请求方被截断，代价落在服务方身上（`b574fc3`）

`#truncate` 第 3 步删掉请求方名下的 `#pending`，而服务方还是 OPEN、入站请求
还在队列里；它出货时 `lookupRequest` 拿到 undefined，排期整批判失败。归因错成
"拒绝重复回复"，而且 **agent 服务方按 INVALID_OUTPUT 重跑三次** —— 对一个
永远不会变好的条件付三次模型钱。

那条拒绝里塞着两种读法，只有"已作废"到得了；"已回复"不可构造（一条 requestId
只挂一条消息，commit 成功即 CONSUMED，重试意味着上次没 commit、条目还在）。
改成 `dangling`，与本函数里"PUBLISH 零订阅者"同一个判法。对称的那半（服务方
被截断→代发 `unavailable`）早就修好了，这次补的是反方向。

### 二、同步 handler 的相位不再永远 idle（`b28ae6c`）

`ExecutionRecord` 只覆盖 agent 节点，那是内核对的地方；错的是把"没有记录"
读成 idle —— idle 是一句正面断言。事实一直在 `$run`（成功）与 FAILED 消息
（失败）里，两处都耐久。新增 `RunSnapshot.commits`（每个节点最后一次提交），
`phaseOfNode` 按投递顺序判定。`Phase` 一个值都没加。

### 三、删掉没有读者的字段与重复实现（`3faa172`）

`Message.inReplyTo`（§3.2 拒绝过的形状，换个名字活了下来）、
`ContextOutcome.tokens`、`StagedRequest.generation` + `StageContext.generation`、
`ControlPlane.snapshots`（`history(trace+"/$run")` 的薄别名）、
`Runtime.record()` 的线性扫描、`#claim` 的死局部、四处 `#busy` 陈迹。

未删并说明理由：`StepResult.dangling`（在第一条里成了"回复没有接收方"的唯一
痕迹）、`drivingCount()`（我先前报成死方法是错的，测试里四处用到）、
`CommitEvent`（注入缝，不是投影）。

### 四、`Lock` 收进 `Obligation`（`5e026b4`）

锁账本第八轮就删了，但**展示投影本身还是第二套词汇**，且已爬进机器协议：
`status --json` 里 `blockers` 与 `locks` 是同一批事实的两种形状。全仓真读到的
字段只有 `kind/holder/key/waitingOn`——`Obligation` 的真子集；`Lock.id` 与
`since` 全链路无人读。删 `locks.ts`（115 行，生产价值 = 一个过滤谓词）。

快照线上 `locks[]` → `obligations[]`，四种 kind 全给。`build.ts` 的筛法本来
就是 `waitingOn === undefined` 就跳过 —— 一直在按字段有无判，那段一行没改。
「阻塞锁」留作给人看的词，落在渲染层。

顺带补上 `ControlPlane.deadlocks(actor, scope?)`：此前 `status` 直连
`runtime.locks.deadlocks()`，不授权也不裁剪，子树主体能读到整棵树的等待环。

### 五、drain 的二次成本（`634f5d0`）

原题目是"事务内记一次义务派生"。先量了再改，量出来的不一样：
`#template(ref)` 每次调用都全量 zod 解析，而 `#pickWork` 对每一步的每一条
排队消息都调它 ⇒ M²/2 次解析，**1600 条消息 27 秒**。按 `ObjectVersion`
对象记一份（键是内容本身，过期在结构上不可能）后 **36–42 倍**。

一个被推翻的中间结论：同进程连跑两组互相污染，据此得出的"生产默认清理更慢"
不成立，照它改的 `prune()` 门槛已撤回（而且那改动本身是错的）。
数字、复现程序与这段更正在 [experiments/2026-09-07-perf](./experiments/2026-09-07-perf/README.md)。

### 验收

全量 **937 passed / 7 skipped**，7 个包 typecheck 通过，reachability 202 无孤儿。

### 留着没做

- `#pickWork` 每步扫一遍 `queued()`，drain 仍是二次（常数已小一个量级）。
  压掉它要建 QUEUED 索引 —— 那是要维护的第二份状态。
- `settleAll` 在 N 上二次（N=801 约 196ms），本轮没动。
- `objectHeads` 规模上界（第四轮登记）。
- 页面「执行现场与结果」仍以 `cell.execution` 为门，handler 节点进不去。

### 本轮埋下、下一轮被抓到的两个 bug（修复见第十一轮）

登记在这里而不是只记在下一轮，因为它们是**本轮改动引入的**。

**一、模板解析缓存共享了一个没冻结的对象。**注释里"版本是深冻结的"说的是
**输入**；`ContainerTemplate.safeParse` 造的是新对象，它没被冻结。改之前每个
调用方各拿一份，改之后共享一份可变对象 —— 而 `tx.ts` 的整个回滚模型正建立在
"内核里所有可变容器装的都是冻结对象"这条前提上。**为性能加的一层缓存悄悄破掉了
支撑回滚正确性的前提，还把"版本是深冻结的"当成它安全的论据。**论据本身没错，
只是论的不是那个对象。

**二、`phaseOfNode` 两处。**（1）`commit === undefined` 时早返回，于是**第一条
消息就失败**的节点显示 idle —— 而"idle 是正面断言"正是本轮要消灭的东西，
在一处赶走、在另一处重造。（2）FAILED / DISCARDED 从不回收，所以现存的失败
可能比已回收的成功**更老**，"已回收的比现存的都老"这条打底随后被循环覆盖。
**这个反例在设计时自己列举过**，然后用一个并不解决它的办法搪塞了过去。

**最该记的一条**：注释里明确拒绝解析 `msg-N`（"会把发号格式变成渲染层的隐藏
依赖"），而 `seqOf()` 就定义在**同一个文件上方 90 行**，已被用在四处 —— 它就是
这个投影自己的时间刻度。**发明了一条这个文件早就回答过的约束，为绕开它写了个错的
算法，还把绕法写成注释当成设计理由。**

> 纪律：在一个文件里编辑时，先查这个文件对我正要发明的约束有没有已有答案。

## 第十一轮（2026-09-07）：外部改动后的可见性复审

基线 `858d389`，复审第十轮改动并复跑上一轮真实执行实验。

### 模板缓存的内容不能被读者改写

- 反例先红：通过 `registry.template()` 修改嵌套端口方向，后续读取变成 emit，磁盘固定版本仍是 receive。冻结版本对象没有冻结 zod 新生成的解析结果。
- 缓存前复用 ObjectStore 的深冻结实现，保留按版本对象缓存与回滚换键的性能优化。
- 验证：模板缓存 4/4，kernel typecheck 通过。

### handler 的首次失败与回收后的当前状态

- 三个反例先红：无 `$run` 时首次 FAILED / DISCARDED 都显示 idle；旧失败保留而后一次成功消息回收后，节点误回 failed。
- 成功提交与终结消息沿用场景已有的 `msg-N` 投递序号比较。已回收不等于更老：FAILED / DISCARDED 本来就不回收。此处表达投递顺序下的最近结果，不声称是任意自定义调度器的完成时间线。
- 验证：scene 66/66，scene typecheck 通过。

### 同步节点也能从状态追到正文

- `$run` 投影带精确 ref；`Cell.result` 将当前相位关联到对应消息与成功提交，消息是否仍保留单独给出。失败不挂上一次成功的提交。
- 页面复用 `/message` 与 `/object`：读失败原因、输入与因果，点击成功提交读正文；已回收的消息明确提示。没有虚构 execution ID，也没有增加写接口。
- 反例先红后绿：实际处理首次失败→成功→其它节点 405 条提交触发回收，重新从磁盘查询仍为 done，消息不可读但 `$run@1` 正文可读。页面同时覆盖旧失败请求迟到与精确引用读取。
- 验证：CLI 页面/同步结果/HTTP 27/27，scene 66/66，state 进度与提交投影 6/6；7 个包 typecheck 通过。

### 整体门检

- 最终实现基线 `f15b272`，全量 **944 passed / 7 skipped**，7 个包 typecheck 通过，reachability 203 无孤儿。跳过的 7 项依然是 Docker daemon 未运行。
- 复用 S6 的真实 Node/LocalRunner/CLI 子进程实验，验证自动重试、语义进度、精确产物、固定依赖与重启鉴权；新增同步 handler 实验验证首次失败与回收后的正文入口。实验结果保存在 [visibility-review](./experiments/2026-09-07-visibility-review/README.md)，旧结果未覆盖。
- 内置浏览器读到了首次失败的 value 提取原因、回收提示与 `$run@1` 正文，以及 agent `exec-2` 的进度和实际 Markdown 产物；检查时控制台无 error/warn。实验服务正常退出。
- 在本机观察与现有 CLI/MCP 操作范围内，可见性足够进入前端准备。仍不承诺网页写操作、全局模板/运行目录、完整历史回放或跨进程物理取消。

## 第十二轮（2026-09-08）：V6 重构落地（分支 `v6/phase1-sync-execution`）

依据 [V6_MODEL.md](./V6_MODEL.md) §13 的分阶段路线。本轮落三块，**没有一块是新功能** ——
全部是"把一个补丁换成它补的那个洞"。

### 阶段 1a：同步节点也留执行记录

同步 commit 路径原来不铸执行 id、不结算，于是"这个节点跑过没有"在同步节点上无据可查。
下游因此长出三块补偿：`RunSnapshot.commits`、`phaseOfNode` 的重建、`Cell.result`。

改成每条终局路径都 `settle`，三块补偿一并退场。**观测从"靠排在最前面"变成"由路径覆盖保证"**
—— 原来 `#recordExecution` 排在 `#apply` 开头，注释写明"失败时的观测更值钱所以要第一件事做"，
而那个位置曾被一条提前 return 绕过去过（注释里自己记着）。现在观测跟着收口走。

`$exec` 同时从实例挪到节点名下（`<traceid>/<node>/$exec`）—— 那是 §1.1 列的四个缺口之一
（没有对象命名空间 ⇒ 产物挂容器上，`node_id` 降格成 provenance 的一个字段）。

### 阶段 5（记录那半）：终态执行归对象库

量出阶段 1a 的后果：head 随历史线性增长。查下去发现**一次终态执行被记了两遍**，
账本与 `$exec` 四个字段重叠，`termination` 是语义最重的那个。与本轮删掉的
`Lock`/`Obligation`、`inReplyTo`/`causesOf` 完全同形，只是这一处**两边都在写**，
所以一直没显形 —— 漂移要两边不同步才暴露。

收口判据来自 §10：**终态记录不参与任何控制决策**。义务、孤儿、冲突域全都只看 RUNNING。

| M | 之前 head.json | 现在 | 记录仍可查 |
|---|---|---|---|
| 200 | 126.3 KiB | 63.5 KiB | 200 条 |
| 800 | 378.9 KiB | 126.9 KiB | 800 条 |
| 2000 | 761.5 KiB | **128.1 KiB** | 2000 条 |

800 → 2000 几乎不动：**头由在途工作量决定，与历史无关**。

如实记下：`VOIDED` 似乎在公开 API 上构造不出来 —— `truncate` 与 `reconcile` 都先结算在途记录，
迟到的 apply 撞在 `#closedResult` 上而不是冲突域复核上。用例改成直接往对象库放一版并写明理由，
没动产品代码。

### 阶段 5（消息那半）：终态消息也归对象库

`keepConsumedMessages` 让队列自己决定丢谁 —— 而它丢的是**只有队列里有**的东西，
所以它只能在"头无界增长"与"历史消失"之间选一个，两边都不对。用例也只能钉住
"早期消息已被清掉"这种**把损失当成规格**的断言。

终态消息先落进 `<traceid>/<node>/$msg` 再离队，选择就不存在了。四个出口
（CONSUMED 两处、FAILED、截断 DISCARDED）收进一个 `#settleMessage`，与执行那半同形。

| M | 阶段 1a | 记录那半 | 现在 | 消息历史仍可查 |
|---|---|---|---|---|
| 200 | 126.3 KiB | 63.5 KiB | **0.7 KiB** | 200 条 |
| 2000 | 761.5 KiB | 128.1 KiB | **0.8 KiB** | 2000 条 |
| 5000 | — | — | **0.8 KiB** | 5000 条 |

顺带两件：

**一、一处没人发现的耦合。**场景的染色窗口原来"恰好"等于头里保留的那 200 条
已消费消息 —— 文件头注释把它写成"巧合般的合拍"。那是真耦合：一个持久化 GC 旋钮
在暗中决定渲染语义，调小它画面就变。现在窗口只由 `build.ts` 的 `WINDOW` 说了算。

**二、一个用例抓不到的排序 bug。**落库那半按「实例 × 节点 × 版本」取回来，
是按节点分组而非投递序，而下游 `slice(-WINDOW)` 取的是"最后 N 条" ——
多节点时会取成"最后一个节点的 N 条"。全仓用例全绿，因为夹具都只有一两个节点。
补了一条交替投递两个节点的用例，撤掉排序当场变红。

> 这个 bug 是推出来的不是测出来的：改完读点之后回头问"下游对这个返回值的顺序
> 有没有要求"。**新的读点要问旧的消费方要什么，绿灯不代表问过了。**

### 阶段 1 前置：节点 id 收成合法路径段

节点 id 原来自带字符集 `/^[A-Za-z_][A-Za-z0-9_-]*$/`，比 traceid 段宽。今天不打架，
是因为 spawn 的路径段**由调用方给**（`slot` 命名声明、`segment` 命名实例），节点 id 从不进 traceid。
阶段 1 一落地就打架：节点是默认实例化的，段只能是 id 自己。

两套并一套，宽的不能留 —— 判据是**实例身份必须存得下**：`Coder` 与 `coder` 在
Windows / macOS 上同目录，`objects.ts` 的碰撞检测会拒写，一棵合法的容器树变成写不进去的树。
那个检测是给对象 id 兜的诊断，不该升格成实例身份的准入。实测代价为零。

> 写这条用例时对照组当场救了一次：`{ nodes: { Coder: node } }` 拒收，但同一份定义
> 换成 `coder` **也拒收** —— 端口方向和执行体两处都写错了，那条"绿"绿在别的理由上。
> **纪律：断言"因为 X 所以拒收"时，必须同时钉住"去掉 X 就通过"。**

### §10.7：节点实例不需要新字段（推导修正）

原打算加 `ContainerInstance.entry?: string` 指向节点定义，理由是
`templateRef === parent.templateRef` 判不出线程还是子进程 —— **递归容器会撞**。

那一步对，下一步错了。判定可以直接派生：

```
「job-1/coder 是线程吗」= parentTemplate(job-1).nodes["coder"] !== undefined
```

因为默认实例化不经过调用方，**声明名与路径段被钉成同一个东西**。递归容器那个反例仍然成立，
只是它反的是 **ref 相等**，不是**可派生性**。差点让一个正确的反例给一个错误的结论背书。

### 阶段 1b（地址那半）：`{traceid, node, port}` → `{instance, port}`

两段地址是"节点没有身份"留下的：只能用 `(容器, 节点名)` 这个对儿指它。
节点 id 成为合法路径段之后，地址就能收成一段。

同形的四处一起收：`Endpoint`、`MessageSource`（三个字段 → 两个，而三种情形的
判别方式一字未改，还是靠字段有无）、`StagedRequest`、`RequestFact`、`StageContext`。
CLI `hertaloy send <dir> <instance> <port>`、场景文件 `send:`、MCP `send_message`
也一起 —— 否则"地址是一段"在用户真正打字的地方就不成立。

顺带分开一处**本来就不该并**的：scene 的线上 schema 用
`Endpoint.partial({ traceid: true })` 当模板内部引用。实例地址与模板引用同型
只是巧合，contracts 那边本来就是 `PortRef` 与 `Endpoint` 两个类型。

#### 阶段 0 那条纪律兑现了一半

> 「阶段 1 必须给字段改名，不许复用 `traceid`。这样每一处读都报错，编译器就是那份清单。」

改名确实让 40 处读点全部报错。**但它只覆盖「读字段」，不覆盖「把字段传给别的函数」**
—— 后者两个都是 `TraceId`，类型上完全合法。本轮踩了三脚：

1. `#settleRequest` 的 `registry.has(req.requester)` —— 节点路径不是注册实例，
   永远 false，请求方永远等不到了结通知
2. `#truncate` 的 `req.requester === trace` —— 一条 pending 都删不掉
3. `waitingOn: targets[0].instance` —— `deadlocks()` 建的是 `holder → waitingOn`
   的图而 holder 是容器，两边不同域则**环永远找不到，而且不报错**

前两个被现有用例抓到了。**第三个是靠别处一条断言的字面值对不上才暴露的** ——
那是运气：如果那条断言当初写成"有就行"，这个 bug 会带着全绿的套件活下去。

补了一条钉**域**而不是钉字面值的用例：每个 `waitingOn` 都必须是注册实例。
写它的时候自己又犯了一次同样的错 —— 第一版取 `rt.obligations("job-1")`，
那里带 `waitingOn` 的只有 `child` 义务（本来就指注册实例），于是
`expect(waits.length).toBeGreaterThan(0)` 被它满足、循环里一次都没碰到 request。
**断言全绿而没走到要测的东西。** 把 bug 打回去验证才发现它不红。

> 纪律：新补的用例，**必须把它要防的那个 bug 打回去看它变红**。
> 「加了断言」和「断言走到了」是两回事。

### 阶段 1b（执行地址那半）：执行位点也收成一段

消息地址收完之后仓库处在一个不该久留的中间态：消息 `{instance, port}` 一段，
执行 `{traceid, nodeId}` 两段。同一个概念两种写法并存，正是一路在删的形状。

```
ExecutionRecord / ExecutionFact / ExecutionRequest / HandlerContext
StepResult / StepFailure / execLog / ExecutionLedger 的 driving 键
```

**收成一段的形式早就在代码里**：`ExecutionLedger` 有一个私有的
`slot(traceid, nodeId)`，返回 `traceid/nodeId`，而 `#driving` 正是按它索引的。
只是它没被当成"地址"。这一步做完，那个函数整个消失。

删掉两处**纯冗余**（不是改名，是删）：

- `Candidate.{traceid, nodeId}` —— `candidate.message.target.instance` 是同一个事实
- `$exec` 正文里的 `node` —— 对象 id 就是 `<执行位点>/$exec`

`HandlerContext.{traceid, nodeId}` 也一并收：全仓统计下来 `ctx.nodeId` 只被用过
**一次**，`ctx.traceid` **零次**。两个字段几乎纯粹是接口面上的摆设。

#### 一个编译器完全看不见的坑

`packages/state/fixture-gen.mts` 不在任何 tsconfig 里。它的 backend 靠
`req.nodeId === "review"` 分派"永不返回"：

```ts
if (req.nodeId === "review") return await new Promise(() => {});
```

字段没了之后这个比较恒为 false，**生成器一声不吭地产出了一份语义不同的夹具** ——
`review` 从 RUNNING 变成两条 FAILED，`audit` 整个消失。而那份夹具的存在理由
正是"刻意造出四种不同的命运"，落差没了它就不再测任何东西。

是 scene 的三条用例把它抓住的（`expected 'failed' to be 'running'`）。

> 纪律：改公共形状时，**tsconfig 之外的脚本要单独扫一遍**。
> 那里的"绿"不是编译器给的，是没人问过。

#### 顺带

- `MessageQueue.liveFor` 删除 —— 阶段 0 勘察时就标记"只有自己的单测在用"，
  而这一步它正好要改语义。没有生产消费方的东西，不迁移，删掉。
- scene 的夹具是 `fixture-gen.mts` 生成的（文件头写着"手编夹具会编成我以为的形状"），
  所以重跑脚本而不是手改 25 处。
- 那道 schema 缝的运行期保险如约生效：夹具没跟上时 `Snapshot.safeParse`
  当场指着 `messages.0.target.instance：Required` 报错，不是画面少半张。

### 地址收完之后的自审

两次很宽的机械改动之后回头看，抓到三处**类型合法但语义不对**的残留：

**一、`#recordOf` 先填空串再回头补地址。**签名返回 `ExecutionRecord`，而
`instance: ""` 是句谎话 —— 只因为唯一的调用方会覆盖它才成立。改成把地址当参数传，
一条地址是假的记录就**构造不出来**。判据是这个项目自己的「半状态不可表达」，
不是"记得补"。（`#messageOf` 当初就写对了，这处是漏的那半。）

**二、"这个容器有哪些执行位点"被五处各自算了一遍。**kernel 两处、state 一处、
cli 两处，每处都是 `Object.keys(template(t).nodes)` 之后自己拼 `${t}/${n}`。
地址收成一段之后这件事**终于有名字了**（位点就是 `instance`），
所以它成了 `InstanceRegistry.sites(trace)` 一处。

> 拼法写歪一处的后果特别难查：`$exec` / `$msg` 会去查一批不存在的对象 id，
> 而那**不报错**，只是安静地少一批历史。补了一条钉"写入方与枚举方给出同一个字符串"的用例。

**三、`instances.ts` 文件头那段寻址说明两句都错了。**它写着"节点用
`(容器 traceid, node_id)` 寻址，不产生更深的 traceid 段，所以 node_id 的字符集
不受 traceid 段规则约束"—— 这两句正是这一阶段推翻的东西。**注释不会自己失效，
只会变成误导。**

### 门检

- **960 passed / 7 skipped**（contracts 71 / kernel 327 / scene 66 / state 87 / cli 198 / mcp 19 / sandbox 192+7），
  7 个包 typecheck 通过，可达性 210 无孤儿。跳过的 7 项仍是 Docker daemon 未运行。
- 地址收完之后全仓**一处两段执行地址都不剩**：`grep -rn "\.nodeId"` 只剩
  模板遍历里的循环变量（`for (const nodeId of Object.keys(template.nodes))`），
  那是模板内部的声明名，本来就不是地址。
- 基准见 [2026-09-07-perf](./experiments/2026-09-07-perf/README.md)。

## 第十三轮（2026-09-15）：第十一次归约落地 —— 待办

基线 `10f1c22`。依据 [MODEL.md](./MODEL.md) §12。流程照本文开头「每批的流程」，
一个待办一批、一个根因一提交。状态：☐ 未开始 · ◐ 进行中 · ☑ 完成 · ⏸ 等定案。

**排序原则**：不依赖定案、且挡在节点库前面的先做（PA0、PA1）；
定案先于 contracts 重写；轨 B 与轨 A 并行不冲突。

### 阶段 0：设计定案（先讨论，不写代码）

拆待办时发现 **MODEL.md §3.1 字段表漏了执行体**：`NodeDefinition` 上的
`handler | agent`、`bind`、`budget`、`ports` 在表里没有落点 —— 它们不会消失，
要上移。"7 → 3"的计数因此不对。下面几条定了之后一并修正 MODEL / ONESHOT 的 §3。

| # | 待定 | 建议 | Linux 根据 | 状态 |
|---|---|---|---|---|
| Q1 | 执行体字段归属 | `handler?`/`agent?`（二选一）、`bind?`、`budget?` 上移到 `ContainerTemplate`；纯组合容器可以没有执行体 | 每个进程都有映像；纯组合的容器相当于只做 fork/wait 的 shell | ⏸ |
| Q2 | 默认起的子实例：内联模板还是引用 | 两者都允许。内联共享父的 `templateRef`，实例侧不加字段（按 `parent.children[段名]` 派生） | `pthread_create` 共享映像 vs `execve` 换映像 —— 映像共享与否和生命周期无关 | ⏸ |
| Q3 | `entry` 退场后 spawn 的载荷投哪 | 调用方给端口名，校验必须是子模板**已声明的 receive 端口**；不加字段 | `execve(argv)` / stdin：调用方决定喂什么，但只能喂进已有的口 | ⏸ |
| Q4 | `exit` 退场后终态通知怎么表达 | 子实例保留位点 `$exit` 的一条路由指向父端口 —— 复用 routes 与保留名，不加字段。备选：子实例声明条目里留一个父端口名 | `SIGCHLD` + 父进程声明自己在哪 `wait` | ⏸ |
| Q5 | `routes` 的形状 | 统一"别名出口"与"本地环回"两种条目；可见性三种放置（整树 / 仅自己 / 仅某一支）先核 `selfBindings` 在 4 个测试文件里的真实用途，用不上就删一种 | 路由表按前缀最长匹配，可见性来自路由装在哪张表上，不来自条目字段 | ⏸ |
| Q6 | 能力单调要求校验器看到父模板 | `ExecutionSpecValidator` 签名加一个**不透明**的父 spec 参数；内核只转交，不解读 | `no_new_privs` 由内核在 exec 时对照父进程的位判定 —— 判定方需要父的上下文 | ⏸ |
| Q7 | scene 快照注入的依赖方向 | sandbox 只依赖 contracts，不能依赖 scene；快照由 cli 组装、经 `ExecutionRequest` 过界 | 环境变量由父进程在 exec 前组装，被 exec 的程序不去读父的内存 | ⏸ |

### 轨 A：结构

| # | 内容 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| PA0 | 基线：`test` / `typecheck` / `reachability` 全量跑一遍记数字 | — | 数字登记到本节 | ☑ 960 / 7 skipped |
| PA1 | **`ctx` 读裁剪**（M1）：`read` / `collect` 与 `put` / `history` 同一个根，段边界判定 | — | 变红的用例逐条判定，判定结果登记 | ☑ 零条变红，见批次记录 |
| PA2 | `contracts/template.ts` + `port.ts` 重写：删 `nodes`/`edges`/`bindings`/`selfBindings`/`NodeDefinition`/`EdgeDefinition`/`PortRef`/`ChildSlot.entry`/`exit`/`bindings`；加 `ports`/`routes` 与上移的执行体 | Q1…Q5 | contracts 自身测试绿；其余包编译报错即清单 | ⏸ |
| PA3 | `Provenance` 的 `traceid`+`node_id` → `instance` | PA2 | 已落库对象读回兼容与否写明（破坏性，按"重建不热恢复"） | ☐ |
| PA4 | `kernel/instances.ts`（21 处）—— 调整过大可重写 | PA2 | 注册期校验全部迁入；`validateSignalPayloads`（M4）整个删除，信号用例不改仍绿 | ☐ |
| PA5 | `kernel/aliases/check.ts` + `materialize.ts`（12 处）—— routes 并入，可重写 | PA2、Q5 | 别名用例不改语义仍绿 | ☐ |
| PA6 | `kernel/runtime.ts`（10 处）+ `routing.ts`：`stageOutputs` 三分支收成"解析 + 排期" | PA4、PA5 | 内网边不再是独立分支；`#handlerContext.spawn` 按 Q3 投递 | ☐ |
| PA7 | `kernel/control.ts`、`authz-log.ts` 余量 | PA6 | typecheck 绿 | ☐ |
| PA8 | `state`（2 处）+ **`fixture-gen.mts`**（tsconfig 之外） | PA6 | 重跑生成器而不是手改夹具；scene 用例对"四种命运"的断言仍成立 | ☐ |
| PA9 | `cli`（15 处）+ `mcp` 的 `spawn_child` 参数 | PA6、Q3 | JSON 契约用例更新；CLI 场景文件语法随之改 | ☐ |
| PA10 | `scene`（13 处）：`Cell.kind` 3 → 1，删 `phaseOfNode` | PA6 | 可见性用例一条不改仍绿（`RunSnapshot.commits`、`Cell.result` 已在阶段 1a 删除，核实无残留） | ☐ |
| PA11 | 测试机械更新：kernel 26 / cli 15 / state 5 / scene 2 / 其余 3 个文件 | 随各包 | **机械更新不重写**；失败即真断裂，单独登记 | ☐ |
| PA12 | 编译器看不到的：`examples/aggregate*.json` 迁移；`experiments/*.mts` 能迁则迁、不能迁在文件头标"基于旧模型"；`results*.json` **不改**（历史证据） | PA2 | `grep` 旧字段在 `examples/` 与 `packages/` 零命中 | ☐ |
| PA13 | 队列按端口分（原阶段 6） | PA6 | drain 每条成本不随 M 增长（今天 M=200→1600 是 0.108→0.472 ms） | ☐ |
| PA14 | 收尾门检 + MODEL.md §12.3 验收表逐条过；修正 MODEL/ONESHOT §3 | 全部 | 三条命令退出 0；§4.5 边界判据零命中 | ☐ |

### 轨 B：预算与可观测（不依赖轨 A）

| # | 内容 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| PB1 | 不变量 B1 更名"变量袋预算"：文档已改；核对报错文案里是否还写"上下文预算" | — | 文案与 MODEL 一致 | ☐ |
| PB2 | usage 补测（漂移 A-4）：自家 agent 从响应取；外部 CLI 解析输出，取不到**用字段缺省表达"不可得"**，不写 0 | — | `$exec` 里 usage 非零或明确缺省；**不新增字段**（`usage?` 已可选） | ☐ |
| PB3 | 预绑句柄：核实 `ExecutionRequest` 的变量袋已含注入 ref 的正文；agent 侧若有读工具，按引用比对 | — | 读未预绑的 ref 被拒，有反例用例 | ☐ |
| PB4 | scene 快照注入 `.hertaloy/context/` | Q7 | sandbox 的依赖清单不出现 scene | ⏸ |
| PB5 | 资源监控：runner 报事实进 `$exec` diagnostics，失败不影响执行（⑦ 观测期） | — | 监控抛异常时执行照常收口 | ☐ |
| PB6 | 能力单调不增（`checkAgentSpec` 新规则） | Q6 | 父 `network:none`、子 `open` 在注册期被拒；kernel 非注释代码不出现 `capabilities` | ⏸ |

### 清账（不挡设计，可穿插）

| # | 内容 | 验收 | 状态 |
|---|---|---|---|
| PC1 | fiat 自述（MODEL D-3）：`reconcile` / `settleAll` / `reclaim` 各有独立操作类 | 授权表能单独授予/拒绝；有反例 | ☐ |
| PC2 | scope 限范围（MODEL D-4）：H04 已封了"只接受根 scope"，核实是否已闭合 | 结论登记；未闭合则补 | ☐ |
| PC3 | `CommitHook` 载荷收窄或钉用例（MODEL D-5） | 挂一个因策略抛错的钩子会被识别/拒绝 | ☐ |
| PC4 | §4.5 内核零知识判据写成脚本，接进 `reachability` 或独立 `check` | 脚本在 CI 可跑 | ☐ |

### 批次记录

#### PA0 基线（2026-09-15，`ece0273`）

`typecheck` 退出 0；`reachability` 210 个导出无孤儿；`test` 退出 0 ——
contracts 71 / kernel 327 / scene 66 / state 87 / cli 198 / mcp 19 / sandbox 192+7 skipped，
合计 **960 passed / 7 skipped**，与第十二轮收尾门检一致。跳过的 7 项仍是 Docker daemon 未运行。

#### PA1 `ctx` 读裁剪

**登记**：能力缺口（安全）。`#handlerContext` 里写那半 chroot 了（`put` / `history`
走 `namespacedId`），读那半是全局的 —— `read` 直接 `store.resolve`、`collect` 直接
`store.collect(prefix)`，不问调用方在哪棵树上。撑着它的只有"handler 都是自己写的"，
节点库一开放即失效。

**先行审核**：
- 裁剪的根用什么？**与写同一个根**（`#handlerContext` 的 `traceid`）。原计划写的是
  "以自己为前缀"，但"自己"在节点尚未成实例的今天是容器、成实例之后是位点 ——
  绑死"与 put 同根"，两半将来随阶段一起移动，不会再出现一半一半。
- 原计划的"(b) 注入进来的 ref 可读"**不采纳**：核实 `context.ts` 的 `dereference`，
  `type: "ref"` 变量在 prepare 时已被替换成正文，handler 从头到尾拿不到需要自己
  `read` 的外部引用。白名单没有消费方，按 YAGNI 不做；MODEL / ONESHOT §7.2 已同步改写。
- 判定函数不放 `instances.ts`：`index.ts` 对它 `export *`，会平白多一个公开符号。
  放 `runtime.ts` 模块私有。复用 contracts 已有的 `isDescendantOf`（段边界），不另写前缀判断。

**反例先红**：`patterns.test.ts`「ctx 的边界」加四条 —— 跨树 `read`、跨段边界 `collect`
（`job-1` 取 `job-10`）、跨段边界 `read`、本树与子树照常可读可汇聚。前三条修复前
**全部失败**（读取成功，泄露是真的），第四条修复前后都绿。

**修复**：`read` 先 `parseRef`（非精确引用照旧在此拒）再判对象 id；`collect` 判 prefix；
不在子树内抛 `InvariantError`，文案指向正确做法（造实例去那边 / 声明 servo `type: "ref"`）。

**验证**：kernel 331 passed（+4）；全量 **964 passed / 7 skipped**；typecheck 退出 0；
可达性 210 无孤儿（未增加导出）。**既有用例零条变红** —— 全仓 src 里没有一处 handler
调 `read` / `collect`，测试里的三处（`fanout-merge` 一处、`patterns` 两处）都在本树内。
tsconfig 之外的 `experiments/*.mts` 与 `fixture-gen.mts` 已扫，无调用。

**一处核实后撤回的怀疑**：写反例时怀疑既有用例把 `expect` 写在 handler 内部，
失败的断言会被吞成 step 失败。核实同步路径：`step` → `transact` → `#commitSync` →
handler 调用之间**没有 catch**，任何异常（含断言失败）都穿出 `drain`，
「保留 kind」那条用例正是靠这一点断言 `drain` 抛错。怀疑不成立，既有写法没问题。


---

# 漂移登记表（自 ONESHOT.md §8 迁入，2026-09-12）

> ONESHOT.md 于本日重写为自包含的架构规格，原 §8 这本账没有落点了 ——
> 而它是**活账**不是历史，所以迁到这里继续挂。三类原样带过来：
>
> - **A 类 = 改代码**（声明了没走通）。12 条，全在沙箱侧，未动。
> - **B 类 = 改文档**（代码对了文档旧了）。B-1…B-6 指向 `FOUNDATION_V5.md`，
>   而它已降为设计史，这几条随之作废；**B-7 是真缺口**（默认镜像无 node），
>   留着。
> - **C 类 = 欠账**（设计上就还没做）。其中 C-4（队头阻塞）归 MODEL.md §12 轨 A
>   的"队列按端口分"，C-5（`runtime.ts` 超 800 行）今天已是 1831 行，
>   C-10（agent 侧读工具）按 MODEL.md §8.4 改为"注入期预绑"解决，不补工具。
>
> 每条处置后从表中划掉。

### A 类：声明 ↔ 事实漂移（改代码，先于 API 冻结）

| # | 漂移 | 位置 | 修法 |
|---|---|---|---|
| A-1 | `capabilities.retain` 不生效且两处判定矛盾：diagnostics 用 `caps?.retain ?? #retain`，finally 里真正删除只用 `#retain`。声明 "always" 会被删 → 下游 `workspace.from` 当场炸，而 `$exec` 还指着已删路径 | sandbox/backend.ts:388 vs :425 | finally 改为同一条 `caps?.retain ?? this.#retain` |
| A-2 | docker `internal` 网络双线断裂：(a) 设计说内网名按根 traceid，实现 CLI 从不传 `networkName`，全部 run 共享 `hertaloy-default`，跨 run 隔离不成立；(b) 节点 `capabilities.network:"internal"` 覆盖而 runner 缺省 "none" 时从不 `ensureInternalNetwork`，docker run 直接失败 | cli/main.ts:251, sandbox/docker.ts:97,107 | backend 按根 traceid 传名；run() 遇 internal 时 ensure |
| A-3 | WSL 超时/取消 `pkill -9 -f <argv>` 全发行版模式匹配：并行同命令沙箱互相误杀；argv 未正则转义 | sandbox/wsl.ts:128 | 记录子进程 PGID 按组杀，或写 PID 文件 |
| A-4 | usage 恒零：`inTokens/outTokens/costUsd/toolCalls` 硬编码 0。token 预算对 agent 路径无测量，B1 的运行期一半对 agent 真空；成本失控在观测上隐形 | sandbox/backend.ts:412 | 至少自家 agent 从 OpenAI 响应捞 usage；外部 CLI 解析其输出或如实标"不可得" |
| A-5 | 无默认墙钟上限 + cancel best effort：编排进程崩溃后容器照跑，未声明 wallClock 的执行永久烧钱 | sandbox/backend.ts:348 | backend 构造参数给默认上限；节点声明可覆盖 |
| A-6 | 配置错误落可重试档：别名配错/agentSpec 非法是确定错，却只能落 FAILED/INVALID_OUTPUT（都按 maxAttempts 重试）。§14.6 第三类"不重试·确定错"在枚举里没落点 | sandbox/backend.ts:240 | Termination 加 `CONFIG`（NON_RETRYABLE），或注册期更严 |
| A-7 | 产物名去扩展名边角：`.gitignore`→空名整次 INVALID_OUTPUT；`a.txt`/`a.md` 撞名静默合并版本 | sandbox/backend.ts:371 | 空名当场拒并说明；保留扩展名或撞名报警 |
| A-8 | `safeId` 把非 `[A-Za-z0-9_.-]` 全压成 `-`：`a/b` 与 `a-b` 撞名，确定性路径互相顶掉 | sandbox/runner.ts:113 | 编码改成可逆转义（如 `_x2F_`） |
| A-9 | 同步 `execFileSync`（git 基线/diff/docker CLI）阻塞单进程事件循环：大仓基线冻结全部在途 agent 的超时定时器 | sandbox/runner.ts:236, docker.ts:254, observe.ts | 改 execFile async，或文档明示单进程边界 |
| A-10 | Windows 上 local runner 起不了外部 CLI：`spawn(cmd,{shell:false})` 不能执行 `.cmd` shim（Node ≥20.12 限制），claude/codex 在 Windows 正是 .cmd | sandbox/runner.ts:249 | Windows 下 local 对 `.cmd` 走 `cmd /c` 或 doctor 明示用 wsl |
| A-11 | emit.json 与 journal 混用时 emit.json 整体被忽略，丢端口不报警 | sandbox/backend.ts:369 | 两源并集 + 冲突报警，或文档明示互斥 |
| A-12 | `vars.json` 被 writeContext 与 profile render 写两遍（后者覆盖前者） | sandbox/backend.ts:267, profile.ts | 收归 profile 一处产出 |

### B 类：文档 ↔ 代码漂移（改文档，以代码为准）

| # | 漂移 | 位置 |
|---|---|---|
| B-1 | §14.1–14.4 标 📋（未实现），实际 sandbox 包已全部完成并有测试 | FOUNDATION_V5.md §14 |
| B-2 | §12「观察」标 📋，`observe.ts` 已实现 | FOUNDATION_V5.md §12 |
| B-3 | §17.16 reclaim 标"需要"，`state-commands.ts:520` 已实现 | FOUNDATION_V5.md §17.16 |
| B-4 | 剧本帧 9 标"agent 侧待沙箱"，沙箱已落地 | FOUNDATION_V5.md §2 |
| B-5 | §16 表"首要不变量：内核工具未做"，toolkit 已有 emit/progress（仍缺 read_artifact 类，如实改标 🚧） | FOUNDATION_V5.md §16 |
| B-6 | §14.5 docker 行标 ✅，但 internal 网络实际断裂（A-2）——✅ 标记本身失真 | FOUNDATION_V5.md §14.5 |
| B-7 | `hertaloy agent` 默认 docker 镜像 `alpine/git` 无 node：toolkit 与自家 agent 在默认镜像下全死，文档未声明镜像要求 | sandbox/docker.ts:54 |

### C 类：欠账（设计已认，未做）

| # | 项 | 出处 | 建议归宿 |
|---|---|---|---|
| C-1 | 执行租约（孤儿判定窗口只是关小未关闭；跨进程驱动与工作区继承的内存记账矛盾） | §21.2/§21.4 | 阶段 2（见 §9） |
| C-2 | 帧 14 有测量无强制 | §21.6 | 等真实膨胀案例 |
| C-3 | `run`/`settleAll` 的 scope 只授权不限范围 | §21.4 | 阶段 1 |
| C-4 | `#pickWork` 队头阻塞（busy 节点不跳过） | §21.4 | 阶段 2 |
| C-5 | `runtime.ts` 1497 行超 800 约定 | §21.4 | 阶段 1（封装时拆） |
| C-6 | 真 kill -9 的耐久验证 | §18 | 阶段 2 验收 |
| C-7 | executionId 每 Runtime 从 exec-1 起（非全局唯一，靠 traceid 拼接补救） | sandbox/runner.ts:126 注释 | 阶段 2 改 ULID/UUID |
| C-8 | ExecutionLimits.wallClockSeconds 与 capabilities.wallClockSeconds 双旋钮语义重叠 | contracts/execution.ts, sandbox/agent-spec.ts | 阶段 2 归并 |
| C-9 | 单镜像 backend：一个 run 内异构节点环境无法共存；AgentSpec 无 image 字段 | sandbox/docker.ts:95 | 外展期按需 |
| C-10 | agent 侧内核工具只有 emit/progress（read_artifact 等未做） | sandbox/toolkit.ts | 外展期 |

---
