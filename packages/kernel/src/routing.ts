/**
 * 输出排期 —— 把 handler / agent 返回的 `{端口: 载荷}` 变成待提交的下游。
 *
 * 抽成独立模块的理由：同步 handler 路径与 agent 三段式路径**必须**共用同一套
 * 路由语义，否则两条路会各自漂移。这里只排期，不提交 —— 调用方拿到 `StagePlan`
 * 后一次性落，这就是"零部分提交"的实现方式。
 *
 * 不变量：
 *   M1  走内网还是走网关由**端口声明**决定，不由 handler 选
 *   M3  callback 落回已声明端点
 *   首要 输出端口必须在 allowed_emit_ports 内
 */

import {
  type ContainerTemplate,
  type Endpoint,
  type Json,
  type MessageSource,
  type NodeDefinition,
  type Port,
  type TraceId,
  allowedEmitPorts,
  containerOf,
  endpointAt,
  lastSegment,
} from "@nodeflow/contracts";
import { InvariantError } from "./errors.js";

export interface StagedMessage {
  readonly target: Endpoint;
  readonly payload: Json;
  /** 谁发的 —— 观测用。见 contracts 里 MessageSource 的说明。 */
  readonly source?: MessageSource;
  /** 经哪个别名出的网关。观测用。 */
  readonly alias?: string;
  readonly requestId?: string;
}

export interface StagedRequest {
  readonly requestId: string;
  /**
   * 请求方声明的「等不到回复时当作收到什么」。
   *
   * 形状归**请求方**：一个服务方会被多个请求方调用，而它们的 callback servo
   * 各不相同，服务方声明一份满足不了所有人。写在请求方这边，注册期本地就能
   * 校验它过得了自己 callback 端口的契约与 servo。
   */
  readonly unavailable: Json;
  /** 请求方**节点自己的**实例路径（见 `facts.ts` 的 `RequestFact`）。 */
  readonly requester: TraceId;
  readonly callbackPort: string;
  /**
   * 服务方**容器** traceid —— 与 `Obligation.holder` 同域（见排期处的说明）。
   *
   * 此前这件事只存在**锁**里（`Lock.waitingOn`），而它是排期时就知道的
   * （`targets[0].traceid`）—— 于是同一个事实有两份拷贝，且只有一份会随
   * 请求一起落盘。放回请求记录里，锁那一份就成了可派生的。
   */
  readonly waitingOn: TraceId;
}

export interface StagePlan {
  readonly messages: readonly StagedMessage[];
  readonly requests: readonly StagedRequest[];
  /** 有输出但无人接走的端口 —— 观测用，不是错误。 */
  readonly dangling: readonly string[];
  /** 本次要销账的 request（handler 走了 reply 端口）。 */
  readonly resolved: readonly string[];
}

export interface StageContext {
  readonly template: ContainerTemplate;
  readonly node: NodeDefinition;
  /**
   * 本次执行位点 —— **节点自己的**实例路径。
   *
   * 原来是 `{ traceid, nodeId }` 两段。容器由 `parentTrace` 派生，
   * 节点在模板里的声明名由 `lastSegment` 派生（内网边要拿它匹配 `edge.from.node`）。
   */
  readonly instance: TraceId;
  /** 本次消费的消息若是 REQUEST，其 id；否则 undefined。 */
  readonly inboundRequestId?: string;
  readonly inboundMessageId: string;
  /**
   * 别名 → 端点。用**本实例自己的**绑定表解析（`aliases.ts`）。
   *
   * 这里原本还有一个 `subscribers(tunnel)`：扫全树找匹配订阅、逐订阅方求
   * scope。别名版只读实例自带的表 —— 于是解析是局部的，租户之间不共享名字空间。
   */
  readonly resolve: (alias: string) => readonly Endpoint[];
  /**
   * 查一个 pending request。
   *
   * **undefined 只有一种含义：请求方已经不在了**（被截断，或随父级联截断）。
   * "已被回复过"到不了这里 —— 理由写在 `stageOutputs` 的 reply 分支上。
   */
  readonly lookupRequest: (requestId: string) => StagedRequest | undefined;
  readonly nextRequestId: () => string;
}

export type StageOutcome =
  | { readonly ok: true; readonly plan: StagePlan }
  | { readonly ok: false; readonly reason: string };

/** 越界的输出端口。空数组表示全部合法。 */
export function undeclaredPorts(
  node: NodeDefinition,
  outputs: Readonly<Record<string, Json>>,
): readonly string[] {
  const allowed = new Set(allowedEmitPorts(node.ports));
  return Object.keys(outputs).filter((p) => !allowed.has(p)).sort();
}

export function describeUndeclared(
  node: NodeDefinition,
  nodeId: string,
  offenders: readonly string[],
): string {
  const allowed = allowedEmitPorts(node.ports);
  return (
    `节点 ${nodeId} 输出到未声明的 emit 端口 ${offenders.map((p) => `\`${p}\``).join("、")}。` +
    `可用端口：${allowed.join(", ") || "（无）"}`
  );
}

/**
 * 受信路径（内置 handler）用：越界是**编程错误**，直接抛。
 *
 * agent 路径**不能**用这个 —— backend 跑的是模型输出，属不可信边界，
 * 端口越界是 `INVALID_OUTPUT` 这种正常终止原因，必须走失败通道让状态收口，
 * 抛异常会把消息永久留在 CLAIMED、记录永久留在 RUNNING。
 */
export function assertDeclaredPorts(
  node: NodeDefinition,
  nodeId: string,
  outputs: Readonly<Record<string, Json>>,
): void {
  const offenders = undeclaredPorts(node, outputs);
  if (offenders.length > 0) {
    throw new InvariantError(describeUndeclared(node, nodeId, offenders));
  }
}

export function stageOutputs(
  ctx: StageContext,
  outputs: Readonly<Record<string, Json>>,
): StageOutcome {
  const messages: StagedMessage[] = [];
  const requests: StagedRequest[] = [];
  const dangling: string[] = [];
  const resolved: string[] = [];

  // 地址收成一段之后，容器与声明名都是从执行位点派生的 —— 算一次，别在循环里重算
  const container = containerOf(ctx);
  const selfNode = lastSegment(ctx.instance);

  for (const [portName, value] of Object.entries(outputs)) {
    const port = ctx.node.ports[portName] as Port;
    if (port === undefined || port.direction !== "emit") {
      return { ok: false, reason: `端口 \`${portName}\` 不是 emit 端口` };
    }

    /**
     * 这一轮排出去的消息全都出自同一个 emit 端口，所以来源算一次就够。
     *
     * 每条 push 都显式带上而不是在 #enqueue 里统一补：排期是纯函数，
     * 把"谁发的"留到提交期再猜，就又造出一处"两端各自都绿、中间没人走"。
     */
    const source: MessageSource = { instance: ctx.instance, port: portName };

    // 网关回复
    if (port.reply === true) {
      if (ctx.inboundRequestId === undefined) {
        return { ok: false, reason: "本次消息不是 REQUEST，无法从 `reply` 端口回复" };
      }
      const req = ctx.lookupRequest(ctx.inboundRequestId);
      /**
       * 查不到 = **请求方已经不在了**，不是"回了两次"。
       *
       * 这两种读法原来共用一条拒绝，而只有前一种构造得出来：
       *
       *   一条 requestId 只挂在一条消息上（`nextRequestId` 每次新发）；
       *   那条消息 commit 成功即 CONSUMED，`#pickWork` 只挑 QUEUED；
       *   重试意味着上一次**没有** commit，`plan.resolved` 没生效，条目还在。
       *
       * 所以"已回复"那半是不可构造状态 —— 而唯一到得了这里的路径是
       * `#truncate` 把请求方名下的 pending 直接删掉。判成失败的后果是：
       * 服务方明明干完了活却记一次失败，agent 服务方还要按 INVALID_OUTPUT
       * **重跑三次**，对一个永远不会变好的条件付三次钱。
       *
       * 回复没有接收方就是 `dangling` —— 与本函数里"PUBLISH 零订阅者"
       * 同一个判法，那件事从来不算错误。
       */
      if (req === undefined) {
        dangling.push(portName);
        continue;
      }
      resolved.push(ctx.inboundRequestId);
      messages.push({
        target: { instance: req.requester, port: req.callbackPort },
        payload: structuredClone(value) as Json,
        source,
      });
      continue;
    }

    // 网关出口
    if (port.alias !== undefined) {
      const alias = port.alias;
      const targets = ctx.resolve(alias);
      if (port.callback === undefined) {
        // PUBLISH：0..N 订阅者，不记锁
        if (targets.length === 0) dangling.push(portName);
        for (const target of targets) {
          messages.push({
            target,
            payload: structuredClone(value) as Json,
            source,
            alias,
          });
        }
        continue;
      }
      // REQUEST：恰好 1 个订阅者
      if (targets.length !== 1) {
        return {
          ok: false,
          reason: `别名 \`${alias}\` 的 REQUEST 要求恰好 1 个目标，实际 ${targets.length} 个`,
        };
      }
      const requestId = ctx.nextRequestId();
      requests.push({
        requestId,
        requester: ctx.instance,
        callbackPort: port.callback,
        /**
         * **容器**，不是服务方节点。
         *
         * `waitingOn` 与 `holder` 必须同域：`deadlocks()` 建的是
         * `holder → waitingOn` 的图，而 holder 是容器（L2）。写成节点路径的话
         * 两边对不上，环**永远找不到，而且不报错** —— 死锁检测静默失效。
         */
        waitingOn: containerOf(targets[0] as Endpoint),
        // 「等不到回复时当作收到什么」—— 排期时就钉死，与 C4 的 pin 同一条理由：
        // 了结发生在很久以后，那时再去读模板可能已经不是同一份定义了
        unavailable: structuredClone(port.unavailable) as Json,
      });
      messages.push({
        target: targets[0] as Endpoint,
        payload: structuredClone(value) as Json,
        source,
        alias,
        requestId,
      });
      continue;
    }

    // 内网边
    const edges = Object.values(ctx.template.edges).filter(
      (e) => e.from.node === selfNode && e.from.port === portName,
    );
    if (edges.length === 0) {
      dangling.push(portName);
      continue;
    }
    for (const edge of edges) {
      // 每条边独立一份副本：兄弟分支互不污染
      messages.push({
        target: endpointAt(container, edge.to.node, edge.to.port),
        payload: structuredClone(value) as Json,
        source,
      });
    }
  }

  return {
    ok: true,
    plan: { messages, requests, dangling: dangling.sort(), resolved },
  };
}
