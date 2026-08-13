# Nodeflow 统一 JSON 协议工作台 V3

> 状态：**协议讨论工作台 / 未冻结**。
>
> 本文用于收束 Container、NodeInstance、Queue、Edge、Servo 之间的通信语义。所有 JSON、字段名、默认策略和错误码均为讨论候选；本文不代表 `runtime_v2.py` 已经实现 V3，也不构成兼容性承诺。

## 1. 目标与边界

当前设计可以压缩成一句话：

> Runtime 接收受约束的 JSON 操作，在受保护的状态 JSON 上完成校验、选择、变换、提交和传递。

统一协议需要回答五个问题：

1. 消息精确发给哪个 ContainerInstance、NodeInstance 或公开 Endpoint？
2. 这次交互是单向 PUSH、等待业务结果的 CALL，还是某个 CALL 的 REPLY？
3. 哪些字段由 Runtime 保护，哪些 JSON 允许 Node、Agent 或 Servo 生成？
4. 同容器 Edge、跨容器 Endpoint、Queue 投递能否使用同一套语义？
5. 失败发生在“接受前”还是“接受后”，由技术 receipt、业务 REPLY，还是运行策略表达？

本工作台暂不冻结：

- broker ACK、lease、retry、timeout 和 dead-letter；
- Checkpoint seal、上下文压缩、文件 Manifest 与版本提交的完整协议；
- 跨 Container 的事务协议；
- 模板热迁移和运行期拓扑修改——后者当前仍明确禁止。

## 2. 协议不变量候选

以下规则建议作为后续协议讨论的底线：

1. **Definition 提供约束，Instance 承担生命周期。** NodeDefinition 在 ContainerInstance 中物化为唯一 NodeInstance；循环执行不会创建新的 NodeInstance。
2. **需要独立生命周期、权限或外部地址的重复单元应建模为 Child ContainerInstance。** 普通 NodeInstance 不兼任可独立创建的子容器。
3. **运行消息只能固定到具体实例。** Definition 中的 child slot 地址必须先解析成具体 ContainerInstance 地址，才可创建运行消息。
4. **Container 公开地址与 Node 内部地址不是同一种权限。** 外部调用者不能因为知道 `nodeId` 就绕过 Container 的公开 Endpoint。
5. **Runtime 保护 envelope。** Node、Agent 与 Strategy 只能生成业务 payload 或受约束的输出提案，Servo/Adapter 只能转换 payload draft；它们都不能自行伪造路由、回调、cycle、trace authority 或控制权限。
6. **CALL 的技术接受与业务完成分离。** receipt 只说明边界是否接受消息，REPLY 才表示业务调用结果。
7. **REPLY 精确关联一个 CALL Message。** 不按节点名、队列顺序或“最近一次调用”推断回调。
8. **Trace 是观测投影，不是运行真相。** 调度、去重、恢复和 CROSS 窗口不能依赖 Trace 是否完整。
9. **Edge 和 Servo 不修改拓扑。** Servo 读取已选择连接的只读元数据，只返回转换后的 payload。

## 3. 地址模型

地址分三种。它们可以共享 JSON 风格，但不能混用。

### 3.1 Container 公开地址

公开地址用于外部系统、其他 ContainerInstance、Queue 或上层控制器：

```json
{
  "kind": "CONTAINER_ENDPOINT",
  "containerInstanceId": "graph-17",
  "endpointId": "task.in"
}
```

含义：调用 `graph-17` 明确公开的 `task.in`。Runtime 根据该 ContainerInstance 固定的 TemplateVersion 查找 EndpointDefinition，再解析到内部处理目标。

公开地址不包含内部 `nodeId`。Container 可以在不改变外部契约的情况下调整公开 Endpoint 到内部 Node Endpoint 的静态映射，但必须通过新的 TemplateVersion 完成。

### 3.2 Node 内部地址

内部地址供同一 Container 的 Edge、调度器和受信 Runtime 使用：

```json
{
  "kind": "NODE_ENDPOINT",
  "containerInstanceId": "graph-17",
  "nodeId": "planner",
  "endpointId": "result"
}
```

在一个 ContainerInstance 内，`nodeId` 对应一个长期 NodeInstance。因此 `(containerInstanceId, nodeId, endpointId)` 足以派生 NodeInstance Endpoint 地址，首版不必额外生成全局 `nodeInstanceId`。

该地址默认不属于外部 API。只有 Runtime 内部路由，或 ContainerTemplate 通过公开 Endpoint 显式暴露后，外部消息才能到达它。

### 3.3 Child slot 定义地址

Template 内不能提前写死尚未创建的 child instance ID，因此使用未解析的定义地址：

```json
{
  "kind": "CHILD_SLOT_ENDPOINT",
  "childSlotId": "code-worker",
  "endpointId": "task.in"
}
```

它只存在于 Definition、Edge 或 binding 声明中，不是最终 Message target。运行时解析步骤为：

```text
parent ContainerInstance
  -> childBindings[childSlotId]
  -> concrete child ContainerInstance
  -> child public EndpointDefinition
  -> CONTAINER_ENDPOINT runtime address
```

如果 slot 允许多个 child，Definition 还必须给出确定的选择策略，例如显式 instance key、round-robin、按字段选择或由 Strategy 返回选择结果。不能在没有策略时任取一个 child。

### 3.4 地址解析失败

以下情况必须在创建下游 Message 之前失败：

- ContainerInstance 不存在或已 CLOSED；
- EndpointDefinition 不存在；
- 外部调用试图使用 NODE_ENDPOINT；
- child slot 尚未绑定，或多例 slot 无法唯一选择；
- Endpoint 不接受本次 operation；
- 调用者缺少目标 Endpoint 所要求的 capability。

是否允许运行中的 child binding 热切换仍未确定。首版更稳妥的候选是：一次节点提交在同一 Container revision 下完成解析并固定具体目标，已经创建的 Message 永不跟随后续 binding 改变。

## 4. EndpointDefinition

Endpoint 是统一交互点，不永久分成 input/output 两套类型。同一个 Endpoint 可以分别声明接收和发出能力；方向来自本次 operation 和已定义连接。

最小候选：

```json
{
  "endpointId": "task.in",
  "visibility": "PUBLIC",
  "plane": "DATA",
  "receive": {
    "PUSH": {
      "messageContractRef": "CodeTask@3"
    },
    "CALL": {
      "requestContractRef": "CodeTask@3",
      "replyContractRef": "CodeResult@2"
    }
  },
  "emit": {
    "REPLY": {
      "contractPolicy": "FROM_ACTIVE_CALL"
    }
  },
  "binding": {
    "kind": "NODE_ENDPOINT",
    "nodeId": "coder",
    "endpointId": "task",
    "forwardTransformRef": "public-task-to-node@2",
    "replyTransformRef": "node-result-to-public@1"
  },
  "requiredCapabilities": ["graph.task.submit"]
}
```

字段职责：

| 字段 | 作用 | 不应承担的责任 |
|---|---|---|
| `visibility` | `PUBLIC` 或 `INTERNAL` | 不代替 capability 校验 |
| `plane` | 决定 DATA、CONTROL、OBSERVE 或 RUNTIME 处理面 | 不接受调用者自行声明 |
| `receive` | 声明该 Endpoint 可接收的 operation 和精确契约 | 不代表它只能作为 input |
| `emit` | 声明该 Endpoint 可发出的 operation 和精确契约 | 不代表它只能作为 output |
| `binding` | 将公开 Endpoint 映射到静态内部目标；可选绑定 forward/reply adapter | 不在运行中创建 Node |
| `requiredCapabilities` | 声明访问要求 | 不保存调用者自报身份 |

例如调用端的同一 Endpoint 可以声明 `emit.CALL` 与 `receive.REPLY`，被调用端可以声明 `receive.CALL` 与 `emit.REPLY`。这满足回调执行，又不需要两套端口类型。

REPLY 不是任意“向某 Endpoint 发送结果”。发出端必须持有 active CALL 上下文；接收端必须存在对应 pending CALL。Runtime 根据 `replyToMessageId` 校验 reply contract 和固定 reply target，REPLY 不重新选择普通 Edge。

Interface 的 EndpointBinding 可以分别声明请求向内转发的 `forwardTransformRef` 和结果向外返回的 `replyTransformRef`。创建 CALL 时，Runtime 必须把精确 reply contract 与精确 reply transform 版本一起固定到 pending CALL；后续 Definition 发布不能改变在途 CALL 的返回变换。

尚未决定 Endpoint 是否可以独立启停。首版建议 Endpoint 生命周期随 ContainerInstance，不增加 EndpointInstance。

## 5. 统一消息信封

### 5.1 候选结构

```json
{
  "protocolVersion": 3,
  "messageId": "msg-00017",
  "operation": "CALL",
  "source": {"kind": "NODE_ENDPOINT", "containerInstanceId": "graph-plan-1", "nodeId": "planner", "endpointId": "result"},
  "target": {"kind": "CONTAINER_ENDPOINT", "containerInstanceId": "queue-code-1", "endpointId": "in"},
  "contractRef": "CodeTask@3",
  "callback": {
    "replyTarget": {"kind": "NODE_ENDPOINT", "containerInstanceId": "graph-plan-1", "nodeId": "planner", "endpointId": "result"},
    "replyContractRef": "CodeResult@2",
    "replyTransformRef": "code-result-to-planner@1"
  },
  "correlation": {"conversationId": "job-42"},
  "causationIds": ["msg-00012"],
  "cyclePath": [{"checkpointNodeId": "implementation-loop", "epoch": 4}],
  "traceContext": {"traceId": "8f1b...", "parentSpanId": "3c20..."},
  "payload": {"specRef": "spec@6"}
}
```

`callback` 只对 CALL 有意义。CALL 的 `callbackState=WAITING|RESOLVED` 属于 Runtime 保存的 MessageInstance 状态，不建议让发送者写入传输信封。

REPLY 使用同一信封，但必须写入精确关联：

```json
{
  "messageId": "msg-00031",
  "operation": "REPLY",
  "contractRef": "CodeResult@2",
  "correlation": {"replyToMessageId": "msg-00017", "conversationId": "job-42"},
  "causationIds": ["msg-00017"],
  "payload": {"resultRef": "code-result@9"}
}
```

其余 source、target、cyclePath 和 traceContext 仍存在，但 target 必须从原 CALL 保存的 callback 取得并验证；调用者提供的 target 最多只能是待校验副本。

上例的 `replyTarget` 是 Runtime 保存的权威内部形式，不是允许不可信接收者随意复用的普通地址。若 CALL 穿过外部信任边界，候选做法是由 Gateway 保存真实 target，对外只传不可伪造的 `replyHandle`；外部系统仍通过 Gateway/Adapter Container 回送 REPLY。是否所有跨 Container CALL 都统一使用 handle，留待下一轮确认。

### 5.2 受保护 envelope 与可变 payload

| 区域 | 写入者 | 规则 |
|---|---|---|
| `protocolVersion`、`messageId` | Runtime / 可信边界适配器 | 不允许业务代码覆盖 |
| `operation` | 已验证的 Node output、Edge 或外部 Endpoint 请求 | 必须被目标 Endpoint 接受 |
| `source`、`target` | Runtime 解析并规范化 | 外部不能伪造内部 Node 地址 |
| `contractRef` | Endpoint/Edge 与 Runtime 协商后固定 | 运行消息必须使用精确版本 |
| `callback`、`correlation` | Runtime 根据 CALL/REPLY 规则生成或校验 | Agent 不得手工解析任意 CALL |
| `causationIds` | Runtime 根据输入批次生成 | fan-in 可以有多个直接原因 |
| `cyclePath` | Checkpoint/Runtime 的受控状态变换 | 普通 Servo 和 Agent 不得改写 epoch |
| `traceContext` | 可信网关与 Runtime | 只用于观测，不授予权限 |
| `payload` | Node、Agent、Strategy 产生；Servo/Adapter 只转换 draft | 最终值必须通过目标 MessageContract 校验 |

认证主体、capability 判定和接入来源应属于不可伪造的 Runtime metadata。即使为了审计把 `principalRef` 序列化进 envelope，它也必须由网关写入，不能从 payload 复制。

## 6. PUSH、CALL、REPLY 与 technical receipt

### 6.1 三种业务操作

| operation | 发送者承诺 | Runtime 状态 | 完成含义 |
|---|---|---|---|
| `PUSH` | 不等待业务结果 | 创建并投递普通 Message | 目标是否最终处理由投递策略决定 |
| `CALL` | 等待一个相关业务结果 | 原 CALL 保存 pending callback | 收到并提交合法 REPLY 后 RESOLVED |
| `REPLY` | 回复一个精确 CALL | 引用 `replyToMessageId` | 解析该 CALL，而不是创建另一种等待对象 |

CALL 是异步请求—回复语义，不要求阻塞整个 Container 或线程。其他 NodeInstance 可以继续执行。

Queue 接收 CALL 时，“消息成功进入 Queue”不等于业务完成。CALL 应随 QueueEntry 保留 callback 信息，直到实际消费者产生业务 REPLY，或者未来定义的 timeout/cancel policy 终止它。

### 6.2 technical receipt

receipt 表示协议边界对一次提交请求的技术处理结果，不是业务 Message 的 REPLY：

```json
{
  "receiptId": "rcpt-008",
  "requestMessageId": "msg-00017",
  "status": "ACCEPTED",
  "acceptedMessageId": "msg-00017",
  "acceptedAtRevision": 43
}
```

`status` 候选为 `ACCEPTED | REJECTED | DUPLICATE`；拒绝时附带结构化 `error`。receipt 只回答地址、权限、operation、入站 contract 和是否已接受为 Message/QueueEntry；它不回答 handler、Agent、业务 CALL 或下游 fan-out 是否完成。

首版可以把 receipt 作为本地 API/transport 返回值，而不是 MessageInstance。异步 transport 是否需要把 receipt 再投递到专用 Endpoint，仍是开放决定。

## 7. MessageContract 与版本

MessageContract 是不可变 JSON Schema 定义，运行消息必须引用精确版本，例如：

```json
{
  "contractId": "CodeTask",
  "version": 3,
  "schema": {"type": "object", "required": ["specRef"]}
}
```

建议规则：

1. Template 发布时校验 Edge、EndpointBinding、ChildSlot、Queue/Connector 两端 contract 与 transform 引用是否完整。
2. 每次变换先按 source contract 校验输入，变换后再按 target contract 校验输出。
3. Validator 只接受或拒绝，不暗中补字段或改写 payload；规范化和跨版本适配必须是显式 transform。
4. CALL 同时固定 request contract 和 reply contract。
5. REPLY 必须使用原 CALL 固定的 reply contract 与 reply transform，不能改用目标当前的“最新版”。
6. 已创建的 ContainerInstance 固定 TemplateVersion；已有 Message 不因 Definition 更新而漂移。

是否支持兼容版本范围、schema adapter 或协议协商尚未确定。首版建议只接受精确版本，跨版本转换由显式 Servo/adapter 定义表达。

## 8. correlation、causation、cyclePath 与 traceContext

这四组字段不能互相替代。

| 字段 | 回答的问题 | 是否影响执行真相 |
|---|---|---|
| `correlation.replyToMessageId` | 这个 REPLY 在回复哪个 CALL？ | 是 |
| `correlation.conversationId` | 哪些消息属于用户定义的业务会话？ | 可选；不能替代精确 CALL 关联 |
| `causationIds` | 哪些直接输入导致了这条消息？ | 是；用于可追溯 fan-in/fan-out |
| `cyclePath` | 消息处于哪些 Checkpoint 循环及 epoch？ | 是；可参与窗口和版本判定 |
| `traceContext` | 观测 span 如何连接？ | 否；丢失后不应改变业务结果 |

`cyclePath` 使用数组是为了以后表达嵌套循环：

```json
[
  {"checkpointNodeId": "outer-loop", "epoch": 2},
  {"checkpointNodeId": "inner-loop", "epoch": 7}
]
```

但嵌套 epoch 的推进、继承和关闭尚未冻结。普通 Node 默认继承；Checkpoint 负责受控推进；Servo 不得更改。

Trace 系统可以记录 messageId、commit revision、cyclePath、contractRef、Edge/Servo 版本和参与的 causationIds，但调度器不能查询 Trace 来决定消息是否已消费或组合是否已产生。

## 9. 四个处理分面

统一 JSON 信封只统一“如何表达交互”，不要求四个分面共用同一个业务调度器。

| 分面 | 示例 Endpoint | 是否进入业务调度 | 权限要求 |
|---|---|---|---|
| `DATA` | `task.in`、`queue.in` | 通常是 | 业务 capability |
| `CONTROL` | `@control/instantiate`、`@control/close` | 可成为受保护控制 Message，也可由 Kernel 直接处理 | owner/controller capability |
| `OBSERVE` | `@observe/describe`、`@observe/trace` | 通常否 | 只读 capability；不得改变 revision |
| `RUNTIME` | `@runtime/claim`、`@runtime/commit` | Runtime 内部 | 永不向普通 Agent 或外部开放 |

`plane` 来自目标 EndpointDefinition。调用者在 JSON 中写 `"plane": "CONTROL"` 不能获得控制权限。

建议的边界：

- DATA 和经批准的 CONTROL 操作可以物化 MessageInstance；
- OBSERVE 可以复用 CALL/REPLY 形状，但查询不进入业务 Queue，也不推进业务 Container revision；
- RUNTIME 操作是内部函数或私有 Endpoint，不进入公开 EndpointDirectory；
- 对 CONTROL/OBSERVE 的审计记录属于 Record/Trace，不应伪装成业务 payload。

## 10. 通信完备性矩阵

| 场景 | 定义时目标 | 运行时目标 | operation | 关键校验 |
|---|---|---|---|---|
| 同 Container 的 Node → Node 新交互 | `NODE_ENDPOINT` Edge | 同一 instance 的内部 Node 地址 | PUSH/CALL | Edge 固定、Endpoint emit/receive、Servo 后 contract |
| 同 Container 的 CALL → REPLY | 原 CALL callback | pending CALL 固定的 Node Endpoint | REPLY | 不重选 Edge、精确 `replyToMessageId`、单次解析 |
| Container 公开入口 → 内部 Node | Container Endpoint binding | 公开地址解析为内部地址 | PUSH/CALL；REPLY 受限 | visibility、capability、forward/reply adapter |
| Parent → 单例 child | `CHILD_SLOT_ENDPOINT` | 已绑定 child 的公开地址 | PUSH/CALL | slot 类型、child OPEN、slot transform、Endpoint contract |
| Parent → 多例 child | child slot + selection policy | 被选中的具体 child 地址 | PUSH/CALL | 选择必须确定且可追溯 |
| Child → Parent | 公开 parent binding，或原 CALL callback | 具体 parent 地址 | PUSH 或 REPLY | owner 关系不能代替 Endpoint 权限 |
| 无关 Container → Container | 对方公开 Endpoint ref/binding | 具体公开地址 | PUSH/CALL；REPLY 仅沿 callback | 仅 public Endpoint、capability |
| Graph → Queue | Queue public Endpoint | QueueInstance 地址 | PUSH/CALL | Queue ingress transform、MessageContract、接受与业务完成分离 |
| Queue → consumer | consumer binding/subscription | 具体 consumer 公开地址 | PUSH 或传递 CALL | claim/consumer 语义尚未冻结 |
| consumer → queued CALL caller | Queue 保存的 pending CALL | 原 CALL 的 reply target | REPLY | 精确 `replyToMessageId`、单次解析 |
| 外部系统 → Container | Connector + 公开 Endpoint | Gateway 规范化后的公开地址 | PUSH/CALL；REPLY 受限 | Connector transform、身份、capability、contract、receipt |
| Agent → Container 控制面 | 受保护公开 CONTROL Endpoint | 具体 Container | PUSH/CALL | capability，不能靠 payload 自授予 |
| 状态/Trace 查询 | OBSERVE Endpoint | 查询服务/Container 投影 | CALL/REPLY 形状 | 不进入业务调度、不修改状态 |

该矩阵目前能表达同容器、parent/child、无关容器、Queue、外部边界、控制和观察。仍需补充验证的复杂场景包括广播 CALL、多 Queue 订阅、跨 Container 取消、超时后的迟到 REPLY，以及 child 重绑定期间的在途消息。

## 11. Edge 与 Servo 流水线

### 11.1 Edge 的责任

EdgeDefinition 归其所在 GraphDefinition，描述新的 PUSH/CALL 所使用的固定 source、target、operation 和 Servo binding：

```json
{
  "edgeId": "plan-to-code",
  "source": {"kind": "NODE_ENDPOINT", "nodeId": "planner", "endpointId": "result"},
  "target": {"kind": "CHILD_SLOT_ENDPOINT", "childSlotId": "code-worker", "endpointId": "task.in"},
  "operation": "CALL",
  "servoRef": "plan-to-code-servo@2"
}
```

Edge 决定允许存在的连接、operation 和 Servo binding。它不保存本次投递状态，也不产生 EdgeInstance。

REPLY 不作为普通 Edge 的重新路由操作。它使用原 CALL 已固定的 callback；若回调处理后还要继续业务流，回调 Node 再产生一个新的 PUSH/CALL，并由对应 Edge 路由。

### 11.2 Servo 的输入与输出

底层可复用对象候选为不可变、精确版本的 `JsonTransformDefinition`。Graph Edge 上称 Servo；Interface EndpointBinding、ChildSlot、Queue ingress/egress 与外部 Connector 也可引用同类定义，但绑定阶段、source/target contract 和权限各自独立。Container 根上不设置含义模糊的全局 Servo。

Servo 需要读取当前已选择连接和两端 Endpoint 的安全只读投影。候选输入可以压缩为：

```json
{
  "payload": {"planRef": "plan@4"},
  "route": {
    "edgeId": "plan-to-code",
    "operation": "CALL",
    "source": {"address": "graph-17/planner.result", "contractRef": "PlanResult@2"},
    "target": {"address": "code-worker-3/task.in", "contractRef": "CodeTask@3"},
    "edgeConfig": {"includeTests": true}
  }
}
```

示例中的字符串 address 只是为缩短展示；规范运行值仍采用第 3 节的结构化地址。Servo 唯一成功输出候选为：

```json
{"payload": {"planRef": "plan@4", "includeTests": true}}
```

Servo 可读取 route 信息，但不得返回或改写：

- source/target 地址；
- operation；
- contractRef；
- callback/correlation；
- causationIds；
- cyclePath；
- trace authority；
- capability 或 CONTROL tag。

Servo 只能从 payload draft 生成新 payload，必须无持久状态、确定性执行；它不能修改 Container/Node/Queue state、Definition、既有 MessageInstance，也不能访问外部工具来制造副作用。需要状态、等待、Agent 或副作用时，应使用 Strategy、Node 或 Child Container。Runtime 传入的元数据必须是最小只读投影。

InitializerDefinition、VariableProjectionDefinition、MigrationDefinition、ProjectorDefinition 可以复用同一纯 JSON 映射内核，但不是 Servo：Initializer 只写未公开的 InstanceDraft；VariableProjection 只生成 Strategy 判断变量；Migration 由显式版本迁移流程授权；Projector 只读。共享实现不代表共享 Schema、可写目标或 Capability。

### 11.3 候选执行顺序

```text
Node/Strategy 产生受约束的 PUSH/CALL output payload
  -> 根据固定 Definition 选择 Edge
  -> 解析 child slot / public Endpoint 为具体实例地址
  -> 为每条 Edge 复制独立 payload
  -> 校验 source MessageContract
  -> Servo/Adapter 只返回新 payload
  -> 校验 target MessageContract
  -> Runtime 生成受保护 envelope
  -> 在当前提交中原子创建完整 MessageInstance
```

Servo 失败不能通过返回 `null` 暗中成为 drop 策略；是否丢弃、重试或转错误分支应由显式 Strategy/Policy 决定。

### 11.4 Strategy Node 与 Servo 的分工

Strategy 是有 NodeInstance 状态的调度主体，其固定阶段为：`input policy -> variable projection -> evaluator -> trigger policy -> output policy`。

- `input policy`：等待全量、FIFO、选择、交叉或循环窗口，并确定本轮输入集合；
- `variable projection`：由独立 `VariableProjectionDefinition` 把已选输入投影为判断变量；可以复用纯 JSON 映射内核，但不能触发消息或改状态；
- `evaluator`：执行表达式、规则或受控 Agent 判断，产生结构化 decision；
- `trigger policy`：把 decision 映射为 Template 已允许 Edge 的触发提案；
- `output policy`：确定同步/异步、优先级、串行/并行及满足条件后的输出方式。

Servo 只在 Edge 已选择后转换该 Edge 的 payload。Agent-backed Strategy 每轮必须使用新上下文，不能把上轮模型会话隐式留入循环；Agent 只能提出 Template 已允许 Edge 的选择，Runtime 校验后才执行，不能注册策略、创建 Edge 或改 Definition。

### 11.5 多出边默认与 fan-out 原子性

尚未冻结的建议：

- 普通 Node 的一个 Endpoint 有多条匹配 Edge 时，默认广播到全部匹配 Edge；
- Strategy 可以显式选择其中部分 Edge；
- 每条 Edge 使用独立 payload 副本和各自 Servo；
- 首版将同一次 Node commit 的 fan-out 视为原子候选：所有地址解析、Servo 和 contract 校验都成功才一次提交全部下游 Message；任一分支失败则不提交任何分支。

默认广播并非既定结论。仍需比较：

1. 默认广播全部；
2. 多出边必须显式声明 `fanoutPolicy`；
3. 普通 Node 只允许单出边，多出边必须经过 Strategy。

原子 fan-out 也只适用于单 Container 本地提交。跨 Container 发送如果立即产生外部副作用，不能假装存在分布式原子事务；更稳妥的实现方向可能是先原子写入本地 outgoing records，再由投递器分别发送。

## 12. 错误语义候选

错误首先按“是否已被边界接受”分类。

| 阶段 | 示例 | 候选结果 | 是否产生业务 Message |
|---|---|---|---|
| 接受前 | 地址不存在、Endpoint 不公开、权限不足 | `REJECTED` receipt | 否 |
| 接受前 | operation 不支持、source/入站 contract 不匹配 | `REJECTED` receipt | 否 |
| 接受时 | 幂等键重复 | `DUPLICATE` receipt，返回既有 messageId | 不重复产生；幂等字段尚未冻结 |
| 本地提交前 | slot 无法解析、transform 超限/写禁区、target contract 失败 | 本次 commit 失败；原输入是否重回可选由执行策略决定 | 不产生部分 fan-out |
| 接受后 | handler/Agent 技术失败 | 进入以后定义的 retry/failure policy | 已有输入 Message 保持权威状态 |
| 业务处理 | 业务拒绝或结果为失败 | 由 reply contract 的显式业务结果表达 | 对 CALL 产生合法业务 REPLY |
| REPLY 校验 | CALL 不存在、已解析、target 不符、reply contract 不符 | 拒绝 REPLY 并审计 | 不改变原 CALL |
| 回调后期 | CALL 已 timeout/cancel 后收到 REPLY | 未定：拒绝、隔离或 late-reply Endpoint | 未冻结 |

错误对象至少包含 `code`、`message`、`retryable` 和可选 `details`；其中 `retryable` 只是协议建议，不能替代 Queue/Node 的 retry policy。业务失败是统一采用 `{"ok": false, "error": {}}`，还是完全由 reply contract 定义，尚未确定；较保守的候选是后者。

## 13. 开放决策清单

### 地址与实例

- child slot 的 cardinality、多例选择和运行期重绑如何标准化并固定 binding revision？
- 是否需要独立 `nodeInstanceId`，还是派生地址长期足够？

### Endpoint 与契约

- Endpoint 是否需要独立启停/EndpointInstance；REPLY 是否必须显式声明？
- contract 只允许精确版本还是兼容范围；Endpoint forward/reply adapter 的执行顺序和缺省行为如何固定？

### PUSH、CALL、REPLY 与 receipt

- receipt 是 API 返回值、持久 Record，还是可异步投递对象？
- CALL 是否只允许一个最终 REPLY；cancel、timeout、late REPLY 和幂等作用域如何表达？
- callback 在同一 Runtime 内保存结构化 `replyTarget`，跨信任边界是否必须改用 opaque `replyHandle`？

### 分面与权限

- CONTROL 哪些物化为 Message；OBSERVE 是否支持指定 revision？
- capability 如何由网关注入且不泄漏；RUNTIME 是否只保留函数接口？

### Edge 与 Servo

- 多出边是默认广播、显式 fanoutPolicy，还是必须经 Strategy？
- fan-out 原子性覆盖到哪里；JsonTransformDefinition 用有限 DSL 还是受信代码；资源上限和失败如何路由？
- Container 间需要 EdgeDefinition，还是只使用公开 Endpoint binding？
- ChildSlot、Queue、Connector transform 是直接绑定，还是统一由 EndpointBinding 表达？

### Queue 与回调

- QueueEntry 与 MessageInstance 如何分工；queued CALL callback 归谁？
- competing consumer、pub/sub、batching 下哪些 operation 合法？
- Queue receipt、claim ACK 和业务 REPLY 如何保持分离？

### Checkpoint、版本、上下文与文件

- `cyclePath` 如何原子推进并处理并行消息？
- CheckpointRecord 如何固定 Container revision、Plan/Spec、context summary 和 file Manifest？
- context summary 如何成为版本化 JSON Object；跨 Workspace/Graph 的文件 ChangeSet 要多强的一致性？
- CROSS_RETAIN window 如何与 checkpoint epoch 联动？

## 14. 建议的讨论顺序

依次确认 Runtime Slot 与实例原子物化、地址与 EndpointBinding、MessageContract 与 JsonTransformDefinition、PUSH/CALL/REPLY/receipt、Strategy/Edge/Servo/fan-out、Graph—Queue—Connector CALL 链，再联动 Checkpoint、上下文摘要和文件版本；失败、timeout、retry、lease 与 fallback 最后进入。每一步继续追问：

> 如果删除这个字段、状态或持久对象，哪个已确认的端到端场景会无法正确表达？
