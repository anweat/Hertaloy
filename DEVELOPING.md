# 开发指南

写 handler、写模板、接 agent 的人看这一份。概念在 [FOUNDATION_V5.md](./FOUNDATION_V5.md)，
这里只讲**怎么写才不会踩坑**——每一条都对应一次真踩过的坑。

---

## 0. 五分钟跑通

```bash
pnpm install
pnpm hertaloy doctor            # 环境自检
pnpm -r test                    # 493 条
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

### 先干跑再提交

```bash
hertaloy validate ./template.json
```

或 MCP 的 `validate_template`。错误是给模型读的文字，不是栈——
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

`AgentSpec.env` 传的值会在**进对象库之前**被遮蔽（我们清楚知道注入了什么，
所以遮得干净）。另有几条常见格式的模式匹配，但那是**尽力而为**——
黑名单永远漏得掉，真正的保证是"密钥只经 env"。

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
