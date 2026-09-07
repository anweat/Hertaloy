# 开发指南

写 handler、写模板、接 agent 的人看这一份。概念在 [FOUNDATION_V5.md](./FOUNDATION_V5.md)，
这里只讲**怎么写才不会踩坑**——每一条都对应一次真踩过的坑。

---

## 0. 五分钟跑通

```bash
pnpm install
pnpm hertaloy doctor            # 环境自检
pnpm -r test                    # 当前测试数量与环境边界见 ITERATION.md
```

建一个 run 并跑完：

```bash
hertaloy init   ./run flow.json
hertaloy send   ./run job-1 gate in '{"score":92}'
hertaloy drain  ./run
hertaloy status ./run
```

要跑 agent 节点得显式给执行面：`hertaloy drain ./run --runner local|wsl|docker`。
**不给就不跑 agent** ——起进程、可能出网、可能花钱，不该是某个 flag 忘写就悄悄发生的。

同一状态目录一次只允许一个 `drain`。`driver.lock` 覆盖整个推进过程，
`head.lock` 只保护读改写，因此等待 agent 时仍可 `status`、`send`、`truncate`。
遇到占用错误，先按报错中的 PID 检查持有进程；确认其已结束且没有后继持有者后
才清理报错指向的锁文件。直接嵌入 Runtime/RunState 的宿主同样需要保证独占驱动权，
尤其不能仅凭拿到了 `head.lock` 就把 RUNNING 执行认作孤儿。

持久化现在写 `head.json` 格式 2：`objectHeads` 记录每个对象已提交到哪一版，
只有清单内的版本可见。对象写入和 head 发布之间进程中断，可以读取上一份提交并继续执行；
留下的未提交文件不会自动成为历史。格式 1 仍可读取，首次保存先建立旧状态的提交清单再升级。
已损坏、无法判定提交集合的旧目录仍拒绝装载；升级后的目录不能交给只识别格式 1 的旧程序写入。
`RunState.persist()` 必须持有写锁，只读或已关闭的实例不能保存。这些保证针对进程中断，
不包含断电刷盘保证，也不替代上述遗留锁检查。升级前需要保留旧程序回退能力时，请保留完整目录副本。

ControlPlane 的 `run`、`runAgents`、`settleAll`、`reconcile`、`causesOf` 目前
作用于整棵运行树，只接受真实根 traceid 并检查根权限。传子树会被明确拒绝；
`subtree`、`messages` 等查询与定点 `send`、`truncate` 仍按目标授权。

Docker 内网按实际执行策略准备：节点覆盖为 `internal` 时才建网，并检查 Docker 返回的
网络名称和 `Internal=true`。默认按工作根与根 trace 分组；显式 `networkName` 表示主动共享。
旧的共享默认网络不会自动删除。每次 Docker 执行使用独立容器名，取消只引用该次调用的名字。

沙箱目录使用带身份摘要的新名称。已保留的旧目录可通过其中的 `request.json` 核对后供
`workspace.from` 继承；无法确认归属时拒绝并保留现场。同一身份重复 allocate 会报错，
重试须使用新的执行身份，不再自动清空旧目录。直接使用 runner 时需要为独立运行配置独立
workRoot/innerRoot；相同工作根与相同执行身份仍会冲突，WSL 的默认 `/tmp` 尤其需要注意。

---

## 1. 写 handler

handler 是**受信的服务端代码**，注册在 `BUILTIN_HANDLERS` 里。它拿得到 `ctx`，
agent 拿不到。

```ts
myHandler: (vars, ctx) => {
  const all = ctx.collect("job-1", "result");
  if (all.length < 3) return {};              // 还没齐，什么都不发
  return { done: { parts: all.map((o) => o.body) } };
}
```

### 必须确定性

同样的输入变量 + 同样的对象库状态 → 同样的输出。**不许 `Date.now()`、
`Math.random()`、不许读进程外的可变状态。**

理由是重放：从检查点恢复时 handler 会被重跑，靠内容寻址去重保证幂等
（同 id 同内容不产生新版本）。不确定的 handler 重放会写出不同内容 →
版本号涨 → 状态与恢复前不一致。

真需要不确定性（取随机数、读当前时间、调外部服务）的，**它就不是 handler 而是
agent** ——走沙箱那条路，由 claim 保护。

### 计数类写法必须把序号写进 body

这是 C5（版本历史即状态）与内容寻址去重的交界处，**两个内置 handler 都在这里塌过**：

```ts
// ✗ 错：三个子容器给出相同答案时只留一份，汇聚永远等不齐
ctx.put("parts", "part", { value: vars.value });

// ✓ 对：序号来自 history 长度，既单调又确定
ctx.put("parts", "part", { index: ctx.history("parts").length + 1, value: vars.value });
```

也别拿时间戳或随机数凑唯一——那违反上一条。曾经的 `loop` 写
`{ at: Date.now() % 1 }`，而这一项**恒等于 0**（毫秒数是整数），
于是每轮内容相同、被去重吞掉、`rounds > 1` 的循环永不退出。

### 输出必须是合法 JSON

`ctx.put` 与返回的载荷都会过运行期校验。`undefined`、`NaN`、`Date`、`Map`、
类实例、循环引用**全都会被拦下**——因为它们的失败方式是静默损坏：
`undefined` 的键被丢弃、`NaN` 变 `null`、`Date` 变 `{}`。

---

## 2. 写模板

### 用构造器，别手写 JSON

```ts
import { scenario, template, handlerNode, edges } from "@nodeflow/cli";

scenario({ id: "review", spec: template({
  nodes: {
    gate: handlerNode("branch", { vars: ["cond", "score"] }, ["then", "else"]),
    sink: handlerNode("collect", { vars: ["value", "expect"] }, ["done"]),
  },
  edges: edges("gate.then -> sink.got", "gate.else -> sink.got"),
})});
```

`vars: ["cond"]` 是 `$.cond` 的简写，**只在变量名与载荷字段同名时成立**。
不同名就写全：`{ vars: { cond: { type: "short", from: "$.pass" } } }`。
构造器不猜——猜错的 servo 比多写几行糟得多。

### 条件不在边上，在节点选哪个端口上

「条件边」这个东西不存在。边永远是纯前向的（M1：边是唯一的地址权威）。

```
条件边 = 一个多出端口的 handler + 每个端口一条普通边
```

这样拆不是美学：`allowedEmitPorts` 由拓扑推导，所以 agent 与 handler 都只能在
**声明过的**分支里选。条件写在边上的话，表达式就成了新的地址来源，
第一不变量当场就破了。

### 跨容器发消息：写别名，不写地址

容器之间不连边（边只在容器内）。要往外发，emit 端口声明一个**别名**，
目标由**绑定表**解析：

```jsonc
// 发的一方：只写名字，不知道也不需要知道对面是谁
"report": { "direction": "emit", "alias": "progress" }

// 接的一方（某个祖先容器）：把名字绑到端点
"bindings": [{ "alias": "progress", "node": "metrics", "port": "in" }]
```

**可见性靠放在哪，不靠写字段：**

| 放哪 | 谁看得见 |
|---|---|
| `bindings` | 自己 + 整棵子树 |
| `selfBindings` | 只有自己 |
| `children.<槽>.bindings` | 只有那个子槽的子树 |

解析**沿 traceid 向上**走，所以"只收自己子树发的"是免费的 —— 子树外的实例
根本解析不到你的别名。**没有 scope 这种字段**，别去找。

绑定的三种目标：

```jsonc
{ "alias": "a", "node": "n", "port": "in" }                  // 本容器的节点
{ "alias": "a", "slot": "workers", "node": "n", "port": "in" } // 该槽下每个活实例各一份（0..N 扇出）
{ "alias": "a", "external": "other-tenant", "node": "n", "port": "in" } // 跨租户，不枚举对面
```

### 会咬人的：用了别名却没人绑，注册期直接拒

```
模板 root 连接期校验失败：
  root 的别名 `progress`：没有任何绑定 —— 用到它的节点发出去没人接
```

这是**故意收紧的**。以前没人接就是运行期 dangling，于是"我故意不接"与
"我忘了接线"长得一模一样。现在必须表态：要么绑上，要么别用这个别名。

**只有根配置要求一个都不欠。**中间层模板欠着账注册得进去，由更外层来还 ——
所以子模板可以只管声明自己要发什么，不必知道谁会接。

`REQUEST`（`alias` + `callback`）要求解析出**恰好 1 个**目标。绑定存在性注册期
就查了，剩下"这个槽里现在有几个活实例"才是运行期的事 —— 两者分开，报错也分开。

同一个端口还必须写 `unavailable`：**「等不到回复时当作收到这个」**。形状照着
**自己** callback 端口的 servo 写，不是照着服务方写 —— 注册期会当场校验它过得了
自己那两道关（契约 + servo）。忘了写、或者形状对不上，都是注册期报错，不是等到
某次真失败才发现队列里多一条 FAILED 而 handler 从没被叫醒。

### 先干跑再提交

```bash
hertaloy validate ./template.json
hertaloy validate-definition ./run draft ./template.json --json
hertaloy define ./run draft ./template.json --json
```

第一条只做本地校验；跨模板、根别名及 overlay 合并要用带 run 上下文的第二条。
第三条正式注册并返回实际 `id@N`，不会更换既有运行固定的模板。
MCP 的 `validate_template` 给 `id` 时做完整校验，不给时做本地校验。
错误保留字段位置，既有可读文字也有结构化结果——
AI 生成模板 → 拿到错误 → 自己改。这是 G1 自我修正的内循环。

---

## 3. 写 agent 节点

agent 就是**一条命令行**。`claude`、`codex`、`hertaloy agent` 三者平权。

```ts
agentNode(["claude", "-p"], { vars: ["task"] }, ["out", "err"], {
  profile: "claude-code",
  workspace: { source: "primary" },      // 具名仓库，不是路径
  resources: { manual: "handbook" },     // 别名，不是路径
});
```

### 路径一律从 `request.json` 读，一个都别硬编码

沙箱里 cwd 是 `workspace/`，契约目录在 `../.hertaloy/`：

```
../.hertaloy/request.json          本次执行的全部参数
../.hertaloy/context/vars.json     任务变量
../.hertaloy/emit.json             ← 结果写这里（用 request.emitPath）
../.hertaloy/artifacts/            ← 产物写这里（用 request.artifactsDir）
```

**用 `request.emitPath` 而不是照抄上面的路径。** 曾经 `request.json` 里写的是
`.hertaloy/emit.json`，照着做的 agent 会落到 `workspace/.hertaloy/emit.json`，
而内核读的是另一处——**照着契约做反而失败**。现在有一条"逐字照 request.json 做"
的测试盯着它。

### 把普通命令包成节点

```ts
execNode(["hertaloy"], ["git", "commit", "-am", "自动提交"], {}, { workspace: { from: "edit" } });
```

`git commit` / `pnpm test` / `codegraph index` 本身就是命令行，不该为了当节点
先套一个模型。出口按退出码选：`0 → ok`，`非 0 → err`。

**没声明 `err` 端口时失败就是真失败**，不会悄悄路由成"成功走了另一条边"。
想在流程里处理失败就显式声明 `err` ——于是"这条流程怎么处理失败"写在模板里看得见。

### 多步子流程要交接工作区

每次执行一个**独立沙箱**。上游改的东西下游默认看不到：

```ts
edit:   execNode(H, ["sh", "-c", "..."], {}, { workspace: { source: "primary" } }),
check:  execNode(H, ["git", "diff", "--quiet"], {}, { workspace: { from: "edit" } }),
commit: execNode(H, ["git", "commit", "-am", "x"], {}, { workspace: { from: "check" } }),
```

不写 `from` 的话，`check` 会在一个**全新空目录**里跑 `git diff` ——
三步全报成功，一件事没干成。这个坑真踩过，而且从 `drain` 的输出完全看不出来。

`from` 只能写**本容器内的节点名**，于是交接天然被限定在自己的命名空间里：
一个实例接不到兄弟实例的工作区。

---

## 4. 资源与密钥

### 资源是别名，不是路径

```bash
hertaloy resources ./run add primary git /repos/app 主仓库
```

模板里写 `primary`，agent 拿不到它指向哪。**注册表不进对象库**——
跟着对象库走会连带获得不可变 + 内容寻址 + 按前缀可读，那三条对配置有害。

同一个别名在不同 profile 下落在不同位置（`skill` 在 claude-code 下进
`.claude/skills/`，在自家 agent 下进 `.hertaloy/skills/`）——**这就是别名当宏**。

### 密钥只经环境变量

**绝不写进模板、注册表或任何配置文件。** 对象库是不可变、内容寻址、按前缀可读的，
密钥写进去就撤不回来：删不掉、改不了、有该前缀读权限的都看得见。

`AgentSpec.env` 里写的是**取值方式，不是值**：

```jsonc
{ "env": { "ANTHROPIC_API_KEY": "$MY_KEY" } }   // 值留在跑它那台机器的环境里
{ "env": { "NODE_ENV": "production" } }         // 非凭据的配置值照旧写字面量
```

`$NAME` 在派发那一刻从宿主环境取；取不到就**报错而不是注入空串**。
像凭据的字面量（`sk-…`、`ghp_…`、`Bearer …`、`AKIA…`、`xox?-…`）在
**注册期**就被拒，理由里会告诉你改写成 `$NAME`。

> 这一段此前写的是"传的值会在进对象库之前被遮蔽"。**那句话是错的**：
> `redact` 只处理 stdout/stderr，模板正文根本不经过它 —— 密钥就那么明文
> 落进对象库了。文档宣称的与代码强制的对不上，是这个项目被咬得最多的一种，
> 而这次是文档在替代码打保票。

stdout/stderr 仍会在进对象库之前遮蔽（我们清楚知道注入了什么，所以遮得干净），
外加几条常见格式的模式匹配 —— 但那是**尽力而为**：黑名单永远漏得掉，
真正的保证是上面那条"模板里只有名字"。

---

## 5. 权限

缺省是**人类全权、agent 无权**。后半条是第一不变量：agent 的每一份权限
都必须是显式给的。

```bash
hertaloy permissions ./run init     # 写出一份可改的
hertaloy status ./run --as agent:planner    # 默认会被拒
```

作用域按**段边界前缀**判定：`job-1` 覆盖 `job-1/coder-1`，不覆盖 `job-10`。

---

## 6. 排查

| 症状 | 先看 |
|---|---|
| 卡住不动 | `hertaloy status` ——阻塞原因、死锁环、在途消息 |
| agent 失败 | `hertaloy show <traceid>/$exec` ——退出码、stderr、git 观察 |
| 不知道这条消息哪来的 | `hertaloy why <message-id>` ——因果反查 |
| 磁盘涨 | `status` 报保留了几个沙箱；`hertaloy reclaim` 回收 |
| 彻底卡死 | `hertaloy truncate <traceid>` ——推栅栏、丢消息、释放锁、级联 |

所有有状态命令都可加 `--json`，输出机器可读的那份。
**流程驱动流程时读它**，别去 parse 人话——那是最脆的接口。

---

## 7. 三条不成文但会咬人的

**「实现在，路不通」出现过五次。** `AgentSpec` 停在归约前、backend 从没接进
`RunState`、`MessageContract` 注册不进去、`Ref` 认不了 `$`、profile 渲染从没调用。
共同特征是**两端各自都绿，中间那截没人走**。

所以：**加了一个能力，就要有一条从最外层入口出发的测试**。
`pnpm reachability` 能抓住"函数/类没有生产调用点"这一类，但它抓不到
"import 了却没调"——那次是写端到端测试才撞出来的。

**测试通过不等于事情做成了。** 那条 git 子流程"三步全 DONE、drain 报失败 0 次"，
而真仓库一行没动。**验收要断言外部世界的状态**，不是断言流程说了什么。

**docker 用例必须门控。** `describe.skipIf(!HAS_DOCKER)` ——忘了加就等于
任何没装 docker 的机器跑这套测试都是红的，而"红"应该只意味着代码坏了。

## 8. 前端信息反馈接口（S4–S6）

模板配置与运行状态分开读取，关联键是精确 ref、traceid、executionId、messageId。

| 需要的信息 | CLI | HTTP |
|---|---|---|
| 运行摘要、结构化义务、在途消息/执行 | `status <dir> --json` | `GET /status`（根范围） |
| 场景与实时差量 | `scene <dir> [--scope trace] [--watch]` | `GET /scene`、`GET /scene/stream` |
| 实例固定的模板正文 | `templates <dir> [--scope trace]` | `GET /templates` |
| 声明依赖与版本使用者 | `definitions <dir> [--scope trace]` | `GET /definitions?scope=trace` |
| 执行结论、观测引用、产物、运行现场 | `execution <dir> <id> [--runner local\|wsl\|docker]` | `GET /execution?id=` |
| 消息正文、历史失败、因果 | `message <dir> <id>` | `GET /message?id=` |
| 精确对象正文 | `show <dir> <id@N>` | `GET /object?ref=` |
| 操作条件与通道限制 | `operations <dir> [--scope trace]` | `GET /operations?scope=trace` |
| 完整草稿校验 | `validate-definition <dir> <id> <file> [kind]` | `POST /validate-definition` |

查询参数需要 URL 编码。HTTP 由 `serve <dir> --runner ...` 提供，主体在服务启动时确定，
请求使用 `x-hertaloy-token`。服务仍是本机可信的只读服务；唯一 POST 是不落盘的纯校验，
不提供注册、投消息、推进或截断的 HTTP 写入口。接这些写操作前需明确认证边界。

`definitions` 返回以精确 ref 为键的对象，每项是
`{ref,kind,body,usedBy,dependencies:[{ref,where}]}`。起点是获准子树实际固定的版本，
展开子模板、端口契约和 overlay 基定义；未实例化依赖的 `usedBy` 为空。
这不是全局模板目录，未使用资产和后来注册的版本不会混进来。
MCP 可使用 `get_definitions`、`get_operations`。

校验 POST 正文为 `{id,spec,kind?}`，上限 256 KiB。
完整校验解析任意已有定义，因此要求全库 DQL；正式 `define` 按定义 id 的 DDL 判定。
成功返回 `{valid:true,level:"registration",registered:false,issues:[],definition}`；
失败的 `issues` 保留 `where/code/message/severity`。`where` 是既有模板校验器的字段位置，
执行规格错误至少定位到对应节点的 agent 段。HTTP 非法草稿为 400、无权为 403、
无 token 为 401、超限为 413、读取故障为 500。正式注册仍重验，返回实际 ref，不预留版本。
本地 `validate --json` 返回 `level:"local"` 和 `unchecked`，不能当完整注册校验通过。
MCP 的校验、注册和上述新增查询同时提供 `structuredContent`。

渲染时需要保留这些区别：

- `Cell.lifecycle` 是实例 OPEN/TERMINAL；`phase` 是节点当前执行相位。TERMINAL 不表示执行成功。
- `coverage` 是结构覆盖率；`progress` 是 agent 自报进度，可带 note。`progressUnavailable` 表示采集格式非法。
- 执行 `live.available:false` 表示现场不可读；可读且 entries 为空才是尚无日志。现场给最近 20 条 journal，需配置与执行一致的 runner；它不是任意外部 CLI 的完整 stdout 流。
- 重试成功后 `message.state` 可以是 CONSUMED，同时仍带 `lastFailure`。后者是历史，不是当前失败。
- `causesUnavailable` 表示完整因果无权读取，不可把空 causes 当成零前因。
- `operations` 的 permission、available、reasons、requires 分别表达权限、当前条件、受限原因和待填参数。预览不预留执行权，实际调用仍重新校验。
- 每条新场景连接的首帧都从空场景重建；401/403 停止自动重连并提示刷新。对象与模板正文按精确 ref 查询，保持与所选执行关联。

本轮可复现实验及验收边界见 [S6 可见性实验](./experiments/2026-09-07-s6/README.md)。
