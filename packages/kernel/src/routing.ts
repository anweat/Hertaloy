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
  type NodeDefinition,
  type Port,
  type TraceId,
  allowedEmitPorts,
} from "@nodeflow/contracts";
import { InvariantError } from "./errors.js";
import type { AcquireInput } from "./locks.js";

export interface StagedMessage {
  readonly target: Endpoint;
  readonly payload: Json;
  readonly tunnel?: string;
  readonly requestId?: string;
  readonly inReplyTo?: string;
}

export interface StagedRequest {
  readonly requestId: string;
  readonly requester: TraceId;
  readonly node: string;
  readonly callbackPort: string;
  readonly generation: number;
}

export interface StagePlan {
  readonly messages: readonly StagedMessage[];
  readonly locks: readonly AcquireInput[];
  readonly requests: readonly StagedRequest[];
  /** 有输出但无人接走的端口 —— 观测用，不是错误。 */
  readonly dangling: readonly string[];
  /** 本次要销账的 request（handler 走了 reply 端口）。 */
  readonly resolved: readonly string[];
}

export interface StageContext {
  readonly template: ContainerTemplate;
  readonly node: NodeDefinition;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly generation: number;
  /** 本次消费的消息若是 REQUEST，其 id；否则 undefined。 */
  readonly inboundRequestId?: string;
  readonly inboundMessageId: string;
  /** 隧道 → 订阅端点。由调用方按 M2 算好（隧道 ∩ traceid 前缀）。 */
  readonly subscribers: (tunnel: string) => readonly Endpoint[];
  /** 查一个 pending request；返回 undefined 表示不存在或已作废。 */
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
  const locks: AcquireInput[] = [];
  const requests: StagedRequest[] = [];
  const dangling: string[] = [];
  const resolved: string[] = [];

  for (const [portName, value] of Object.entries(outputs)) {
    const port = ctx.node.ports[portName] as Port;
    if (port === undefined || port.direction !== "emit") {
      return { ok: false, reason: `端口 \`${portName}\` 不是 emit 端口` };
    }

    // 网关回复
    if (port.reply === true) {
      if (ctx.inboundRequestId === undefined) {
        return { ok: false, reason: "本次消息不是 REQUEST，无法从 `reply` 端口回复" };
      }
      const req = ctx.lookupRequest(ctx.inboundRequestId);
      if (req === undefined) {
        return {
          ok: false,
          reason: `请求 ${ctx.inboundRequestId} 已回复或已作废，拒绝重复回复`,
        };
      }
      resolved.push(ctx.inboundRequestId);
      messages.push({
        target: { traceid: req.requester, node: req.node, port: req.callbackPort },
        payload: structuredClone(value) as Json,
        inReplyTo: ctx.inboundMessageId,
      });
      continue;
    }

    // 网关出隧道
    if (port.tunnel !== undefined) {
      const targets = ctx.subscribers(port.tunnel);
      if (port.callback === undefined) {
        // PUBLISH：0..N 订阅者，不记锁
        if (targets.length === 0) dangling.push(portName);
        for (const target of targets) {
          messages.push({
            target,
            payload: structuredClone(value) as Json,
            tunnel: port.tunnel,
          });
        }
        continue;
      }
      // REQUEST：恰好 1 个订阅者
      if (targets.length !== 1) {
        return {
          ok: false,
          reason: `隧道 \`${port.tunnel}\` 的 REQUEST 要求恰好 1 个订阅者，实际 ${targets.length} 个`,
        };
      }
      const requestId = ctx.nextRequestId();
      locks.push({
        holder: ctx.traceid,
        kind: "request",
        key: requestId,
        originNode: ctx.nodeId,
        // ★ 必须记 waitingOn：反向清账完全靠它。不记的话，**服务方**被截断时
        //    请求方的 request 锁不会释放，会永久等一个已死的服务。
        waitingOn: (targets[0] as Endpoint).traceid,
      });
      requests.push({
        requestId,
        requester: ctx.traceid,
        node: ctx.nodeId,
        callbackPort: port.callback,
        generation: ctx.generation,
      });
      messages.push({
        target: targets[0] as Endpoint,
        payload: structuredClone(value) as Json,
        tunnel: port.tunnel,
        requestId,
      });
      continue;
    }

    // 内网边
    const edges = Object.values(ctx.template.edges).filter(
      (e) => e.from.node === ctx.nodeId && e.from.port === portName,
    );
    if (edges.length === 0) {
      dangling.push(portName);
      continue;
    }
    for (const edge of edges) {
      // 每条边独立一份副本：兄弟分支互不污染
      messages.push({
        target: { traceid: ctx.traceid, node: edge.to.node, port: edge.to.port },
        payload: structuredClone(value) as Json,
      });
    }
  }

  return {
    ok: true,
    plan: { messages, locks, requests, dangling: dangling.sort(), resolved },
  };
}
