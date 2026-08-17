/**
 * 容器模板契约。
 *
 * 对应 FOUNDATION_V5.md §5（容器八部分）与 §6（节点两类）。
 * 本文件目前覆盖第 1 部分（实例创建模板）与第 4 部分（内网）；
 * 网关 / 工具 / 版本 / 权限 / 生命周期 / 观测随后续 Task 增量加入。
 *
 * **判别式冻结（设计门 8）**：`kind ∈ {"handler","strategy"}`，只有两个值。
 * agent 不是第三个 kind —— 由 `agent` 段的**存在性**判别，不引入 `runtime` 枚举。
 */

import { z } from "zod";
import { Ref, TraceId, Tunnel } from "./identity.js";
import { BindBlock } from "./variable.js";
import { PortMap, allowedEmitPorts } from "./port.js";
import { NodeId } from "./message.js";

export const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const Ident = z.string().regex(IDENT_PATTERN, "标识符必须以字母或下划线起头");

/** 有 `agent` 段 = 走执行面 backend；没有 = 走内核内置 handler。 */
export const AgentSpec = z.object({ model: z.string().min(1) }).strict();

const HandlerNodeShape = z
  .object({
    kind: z.literal("handler"),
    /** 内置 handler 名。与 `agent` 二选一。 */
    handler: Ident.optional(),
    agent: AgentSpec.optional(),
    bind: BindBlock.optional(),
    ports: PortMap,
  })
  .strict();

/** 策略节点是唯一有控制流的地方（不变量 S2）。语句表随后续 Task 加入。 */
const StrategyNodeShape = z
  .object({
    kind: z.literal("strategy"),
    ports: PortMap,
  })
  .strict();

function checkExecutionBody(
  v: { readonly kind: string; readonly handler?: unknown; readonly agent?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (v.kind !== "handler") return;
  const declared = [v.handler !== undefined, v.agent !== undefined].filter(Boolean).length;
  if (declared !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "handler 节点必须恰好声明一个执行体：内置 `handler` 或 `agent` 段",
    });
  }
}

export const HandlerNode = HandlerNodeShape.superRefine(checkExecutionBody);
export const StrategyNode = StrategyNodeShape;

export const NodeDefinition = z
  .discriminatedUnion("kind", [HandlerNodeShape, StrategyNodeShape])
  .superRefine(checkExecutionBody);

export type NodeDefinition = z.infer<typeof NodeDefinition>;

export const PortRef = z.object({ node: NodeId, port: Ident }).strict();
export type PortRef = z.infer<typeof PortRef>;

/**
 * 内网边 —— 就是一条转发。
 *
 * 没有 `operation`（只有一种传递）、没有 `servo`（servo 在目标端口上）、
 * 没有 `contract`（契约在端口上）。边只回答"从哪个端口送到哪个端口"。
 */
export const EdgeDefinition = z.object({ from: PortRef, to: PortRef }).strict();
export type EdgeDefinition = z.infer<typeof EdgeDefinition>;

/** 声明本容器可以创建哪些子容器（第一不变量：只能选不能构造）。 */
export const ChildSlot = z.object({ template: Ref }).strict();
export type ChildSlot = z.infer<typeof ChildSlot>;

/**
 * 网关入口：本容器订阅哪条隧道，投到哪个端点。
 *
 * `scope` 是 traceid 前缀 —— 省略表示不限作用域。
 * 声明 `scope: "job-1"` 表示**只收 job-1 这棵子树里发出的消息**（不变量 M2）。
 */
export const SubscriptionDeclaration = z
  .object({ tunnel: Tunnel, scope: TraceId.optional(), to: PortRef })
  .strict();

export type SubscriptionDeclaration = z.infer<typeof SubscriptionDeclaration>;

export const ContainerTemplate = z
  .object({
    nodes: z.record(NodeId, NodeDefinition).default({}),
    edges: z.record(Ident, EdgeDefinition).default({}),
    children: z.record(Ident, ChildSlot).default({}),
    subscriptions: z.record(Ident, SubscriptionDeclaration).default({}),
  })
  .strict();

export type ContainerTemplate = z.infer<typeof ContainerTemplate>;

// ---------------------------------------------------------------------------
// 连接期校验（注册期跑，不是运行期）
// ---------------------------------------------------------------------------

export interface TemplateIssue {
  readonly where: string;
  readonly message: string;
}

/**
 * 校验内网边的两端真实存在且方向正确。
 *
 * 错误信息面向 LLM 与画布：说清缺什么、有什么可用（FOUNDATION §7"错误可读"）。
 */
export function validateContainerTemplate(
  tpl: ContainerTemplate,
): readonly TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  for (const [edgeId, edge] of Object.entries(tpl.edges)) {
    for (const [end, side] of [
      ["from", edge.from],
      ["to", edge.to],
    ] as const) {
      const node = tpl.nodes[side.node];
      if (node === undefined) {
        issues.push({
          where: `edges.${edgeId}.${end}`,
          message:
            `节点 \`${side.node}\` 不存在。可用节点：` +
            `${Object.keys(tpl.nodes).sort().join(", ") || "（无）"}`,
        });
        continue;
      }
      const port = node.ports[side.port];
      if (port === undefined) {
        issues.push({
          where: `edges.${edgeId}.${end}`,
          message:
            `节点 \`${side.node}\` 未声明端口 \`${side.port}\`。可用端口：` +
            `${Object.keys(node.ports).sort().join(", ") || "（无）"}`,
        });
        continue;
      }
      const wanted = end === "from" ? "emit" : "receive";
      if (port.direction !== wanted) {
        issues.push({
          where: `edges.${edgeId}.${end}`,
          message:
            `端口 \`${side.node}.${side.port}\` 方向是 ${port.direction}，` +
            `边的 ${end} 端要求 ${wanted}。` +
            (wanted === "emit"
              ? `本节点可用的 emit 端口：${allowedEmitPorts(node.ports).join(", ") || "（无）"}`
              : `本节点可用的 receive 端口：${
                  Object.entries(node.ports)
                    .filter(([, p]) => p.direction === "receive")
                    .map(([n]) => n)
                    .sort()
                    .join(", ") || "（无）"
                }`),
        });
      }
    }
  }

  // 网关请求端口的 callback 必须落在**本节点已声明的 receive 端口**（不变量 M3）
  for (const [nodeId, node] of Object.entries(tpl.nodes)) {
    for (const [portName, port] of Object.entries(node.ports)) {
      if (port.direction !== "emit" || port.callback === undefined) continue;
      const target = node.ports[port.callback];
      if (target === undefined || target.direction !== "receive") {
        issues.push({
          where: `nodes.${nodeId}.ports.${portName}.callback`,
          message:
            `回复落点 \`${port.callback}\` 必须是本节点已声明的 receive 端口。可用：` +
            `${
              Object.entries(node.ports)
                .filter(([, p]) => p.direction === "receive")
                .map(([n]) => n)
                .sort()
                .join(", ") || "（无）"
            }`,
        });
      }
    }
  }

  // 订阅投递点必须是已声明的 receive 端口
  for (const [subId, sub] of Object.entries(tpl.subscriptions)) {
    const node = tpl.nodes[sub.to.node];
    if (node === undefined) {
      issues.push({
        where: `subscriptions.${subId}.to`,
        message:
          `节点 \`${sub.to.node}\` 不存在。可用节点：` +
          `${Object.keys(tpl.nodes).sort().join(", ") || "（无）"}`,
      });
      continue;
    }
    const port = node.ports[sub.to.port];
    if (port === undefined || port.direction !== "receive") {
      issues.push({
        where: `subscriptions.${subId}.to`,
        message: `\`${sub.to.node}.${sub.to.port}\` 必须是已声明的 receive 端口`,
      });
    }
  }

  return issues;
}
