/**
 * 容器模板契约。
 *
 * 对应 FOUNDATION_V5.md §5（容器八部分）与 §6（节点只有一类）。
 * 本文件目前覆盖第 1 部分（实例创建模板）与第 4 部分（内网）；
 * 网关 / 工具 / 版本 / 权限 / 生命周期 / 观测随后续 Task 增量加入。
 *
 * **判别式：`kind: "handler"`**，只有一个值。
 * agent 由 `agent` 段的**存在性**判别，不引入枚举。
 *
 * 策略节点已删除（FOUNDATION §6.1）：它原本要干的活——循环计数、汇聚、择优——
 * 全部由「版本历史即状态」承担（C5），条件与路由由受信 handler 代码承担。
 */

import { z } from "zod";
import { Json } from "./json.js";
import { Ref, TraceId, Tunnel, isDescendantOf } from "./identity.js";
import { BindBlock, declaredBudget } from "./variable.js";
import { PortMap, allowedEmitPorts } from "./port.js";
import { NodeId } from "./message.js";

export const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const Ident = z.string().regex(IDENT_PATTERN, "标识符必须以字母或下划线起头");

/** 有 `agent` 段 = 走执行面 backend；没有 = 走内核内置 handler。 */
/**
 * agent 节点的声明 —— **一条命令行**（第五次归约，§14）。
 *
 * 之前这里是 `{ model: string }`，那是归约之前"内核挑后端、内核中介工具调用"
 * 时代的形状。归约之后执行面收成了"在沙箱里跑一条命令行"，`SandboxBackend`
 * 要的是 `argv`，而这个 schema 还在要 `model` 且 `.strict()` ——
 * 于是**任何声明了沙箱 agent 的模板都注册不进去**，整个执行面从编排面够不着。
 * 契约与实现各自演进却没人对过账，正是这种断裂的典型来源。
 *
 * `env` 只放**取值方式**，不放值本身：模板是对象，对象不可变、内容寻址、
 * 按前缀可读，密钥写进去就撤不回来（§17.7）。
 */
export const AgentSpec = z
  .object({
    argv: z.array(z.string()).nonempty(),
    /** 卡片渲染成谁认识的文件（`claude-code` / `codex` / `hertaloy-agent`）。 */
    profile: z.string().optional(),
    /** 注入到 `.hertaloy/context/` 的文件：相对路径 → 内容。 */
    context: z.record(z.string()).optional(),
    /** 环境变量。**不得写入密钥值** —— 见上。 */
    env: z.record(z.string()).optional(),
    /**
     * 工作区：把一个**具名**仓库物化成工作树。
     *
     * `source` 是别名，不是路径或 URL —— 具体指向哪个仓库由 backend 配置决定。
     * 模板因此可移植：同一份模板在不同机器上跑不同的仓库，而 agent 始终
     * 拿不到真实位置。
     */
    workspace: z
      .object({ source: Ident, base: z.string().min(1).optional() })
      .strict()
      .optional(),
    /**
     * 参考资料：别名 → 具名资源。落在 `.hertaloy/resources/<别名>/`。
     *
     * 不落 `workspace/`：工作树是被观察的，参考资料混进去会被算成 agent 的改动。
     */
    resources: z.record(Ident, Ident).optional(),
  })
  .strict();

export type AgentSpec = z.infer<typeof AgentSpec>;

const HandlerNodeShape = z
  .object({
    kind: z.literal("handler"),
    /** 内置 handler 名。与 `agent` 二选一。 */
    handler: Ident.optional(),
    agent: AgentSpec.optional(),
    bind: BindBlock.optional(),
    ports: PortMap,
    /**
     * 本节点的上下文预算（不变量 B1 的阈值）。
     * 声明了 `long` / `ref` 变量的节点**必须**给出预算，否则注册期无从求和。
     */
    budget: z.object({ tokens: z.number().int().positive() }).strict().optional(),
  })
  .strict();

function checkExecutionBody(
  v: { readonly handler?: unknown; readonly agent?: unknown },
  ctx: z.RefinementCtx,
): void {
  const declared = [v.handler !== undefined, v.agent !== undefined].filter(Boolean).length;
  if (declared !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "节点必须恰好声明一个执行体：内置 `handler` 或 `agent` 段",
    });
  }
}

export const HandlerNode = HandlerNodeShape.superRefine(checkExecutionBody);

/** 只有一种节点。判别式保留 `kind` 字段是为了将来可扩展，但当前只接受 `"handler"`。 */
export const NodeDefinition = HandlerNode;

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

/**
 * 声明本容器可以创建哪些子容器（第一不变量：只能选不能构造）。
 *
 * `entry` 是**子容器的入口端点** —— 建完子容器之后活怎么进去，靠它。
 * 没有 entry 就只能建一个收不到任务的空壳；有了它，父容器给
 * coder-1 派 task-1、给 coder-2 派 task-2 才成立（剧本帧 8→9）。
 *
 * 它指向的是**子模板里的**节点与端口，所以校验必须跨模板做 —— 见
 * `registerContainerTemplate`（纯结构校验在 contracts，跨引用校验在 kernel）。
 */
export const ChildSlot = z
  .object({
    template: Ref,
    /** 子容器的入口端点（指向**子模板**里的节点/端口）。 */
    entry: PortRef.optional(),
    /**
     * 回程：子实例进终态时，往**父容器自己**的这个端点投一条通知。
     *
     * 没有它，子干完活父就完全不知道 —— `settle` 只释放锁，不叫醒任何人。
     * 剧本帧 12（三路汇聚）会因此断链：merge 节点永远等不到触发。
     *
     * 载荷只是**通知**（`{slot, traceid, status}`），不带子容器的产出 ——
     * 内容在资产里，父用 `ctx.collect` 取（C5：版本历史即状态）。
     *
     * 与 `entry` 方向相反：`entry` 指子模板，`exit` 指**本模板**。
     */
    exit: PortRef.optional(),
  })
  .strict();
export type ChildSlot = z.infer<typeof ChildSlot>;

/**
 * 订阅作用域（不变量 M2 的一半）。
 *
 * **必须支持相对形式**：模板会被实例化成 `job-1`、`job-2`……，
 * 写死绝对 traceid 的订阅换个实例就失效，与剧本帧 11"订阅自己子树"不符。
 * `$` 不是合法 traceid 字符，所以两个相对标记与绝对前缀不会歧义。
 */
export const RELATIVE_SCOPES = ["$self", "$self_subtree"] as const;
export const SubscriptionScope = z.union([z.enum(RELATIVE_SCOPES), TraceId]);
export type SubscriptionScope = z.infer<typeof SubscriptionScope>;

/** 网关入口：本容器订阅哪条隧道，投到哪个端点。 */
export const SubscriptionDeclaration = z
  .object({ tunnel: Tunnel, scope: SubscriptionScope.optional(), to: PortRef })
  .strict();

export type SubscriptionDeclaration = z.infer<typeof SubscriptionDeclaration>;

/**
 * 作用域是否接受这个发送方。相对标记在**匹配时**按订阅方实例解析成绝对前缀。
 *
 * - 省略        不限作用域
 * - `$self`         只收订阅方自己发的
 * - `$self_subtree` 只收订阅方这棵子树里发的 ← 剧本帧 11
 * - 绝对 traceid    只收该前缀子树里发的
 */
export function scopeAccepts(
  scope: SubscriptionScope | undefined,
  subscriber: TraceId,
  sender: TraceId,
): boolean {
  if (scope === undefined) return true;
  if (scope === "$self") return sender === subscriber;
  if (scope === "$self_subtree") return isDescendantOf(sender, subscriber);
  return isDescendantOf(sender, scope);
}

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

  // 变量命名冲突 + 预算求和（不变量 B1 的注册期落点）
  for (const [nodeId, node] of Object.entries(tpl.nodes)) {
    const seen = new Map<string, string>();
    const bounded: { type: string; max_tokens?: number | undefined }[] = [];

    for (const [name, decl] of Object.entries(node.bind ?? {})) {
      seen.set(name, "bind");
      bounded.push(decl);
    }
    for (const [portName, port] of Object.entries(node.ports)) {
      if (port.direction !== "receive" || port.servo === undefined) continue;
      for (const [name, decl] of Object.entries(port.servo.vars)) {
        const prior = seen.get(name);
        if (prior !== undefined) {
          issues.push({
            where: `nodes.${nodeId}.ports.${portName}.servo.vars.${name}`,
            message:
              `变量名 \`${name}\` 与 ${prior === "bind" ? "bind 段" : `端口 ${prior}`}冲突。` +
              `同一节点的变量共用一张表，名字必须唯一`,
          });
        }
        seen.set(name, portName);
        bounded.push(decl);
      }
    }

    const total = declaredBudget(bounded as never);
    const declaredBound = bounded.some((v) => v.max_tokens !== undefined);
    if (declaredBound && node.budget === undefined) {
      issues.push({
        where: `nodes.${nodeId}.budget`,
        message:
          `节点声明了 long/ref 变量（合计上界 ${total} tokens），必须给出 ` +
          `\`budget.tokens\` —— 不声明阈值就无法在注册期校验预算（不变量 B1）`,
      });
    } else if (node.budget !== undefined && total > node.budget.tokens) {
      issues.push({
        where: `nodes.${nodeId}.budget`,
        message:
          `变量声明上界合计 ${total} tokens，超出节点预算 ${node.budget.tokens}。` +
          `这说明图切得太粗 —— 拆节点，或调小某个变量的 max_tokens`,
      });
    }
  }

  // 子槽的 exit 指向**本模板**的 receive 端口（与 entry 方向相反）
  for (const [slotId, slot] of Object.entries(tpl.children)) {
    if (slot.exit === undefined) continue;
    const node = tpl.nodes[slot.exit.node];
    const port = node?.ports[slot.exit.port];
    if (node === undefined || port === undefined || port.direction !== "receive") {
      issues.push({
        where: `children.${slotId}.exit`,
        message:
          `回程落点 \`${slot.exit.node}.${slot.exit.port}\` 必须是**本容器**已声明的 receive 端口` +
          `（exit 指本模板，entry 才指子模板）。可用节点：` +
          `${Object.keys(tpl.nodes).sort().join(", ") || "（无）"}`,
      });
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

// ---------------------------------------------------------------------------
// 多层继承：路径覆盖 + eager 物化（§5.1）
// ---------------------------------------------------------------------------

export const OVERRIDE_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*$/;

/**
 * 覆盖层：只声明"基于哪份定义、改哪几条路径"。
 *
 * 容器定义是路径寻址的（`nodes/coder/budget/tokens`），所以子容器不必抄整份，
 * 只覆盖若干路径。这是"版本管理（多层继承）"这一部分的落点。
 */
export const TemplateOverlay = z
  .object({
    extends: Ref,
    override: z.record(z.string(), Json).default({}),
  })
  .strict();

export type TemplateOverlay = z.infer<typeof TemplateOverlay>;

export function isOverlay(spec: unknown): boolean {
  return typeof spec === "object" && spec !== null && "extends" in spec;
}

export type OverlayOutcome =
  | { readonly ok: true; readonly merged: ContainerTemplate }
  | { readonly ok: false; readonly issues: readonly TemplateIssue[] };

/**
 * 把覆盖层施加到基定义上。**纯函数**：不改基，返回新的完整定义。
 *
 * 路径规则：
 *   - 除最后一段外，**中间每一段必须已存在且是对象** —— 否则 `nodes/codr/budget`
 *     这种拼写错误会静默造出一个假节点。宁可报错。
 *   - **最后一段可以是新的** —— 这样才能用覆盖层往基定义里加节点、加边。
 */
export function applyOverlay(base: ContainerTemplate, overlay: TemplateOverlay): OverlayOutcome {
  const issues: TemplateIssue[] = [];
  const merged = structuredClone(base) as unknown as Record<string, unknown>;

  for (const [path, value] of Object.entries(overlay.override)) {
    if (!OVERRIDE_PATH_PATTERN.test(path)) {
      issues.push({
        where: `override.${path}`,
        message: "覆盖路径必须是 `/` 分隔的标识符，如 `nodes/coder/budget/tokens`",
      });
      continue;
    }
    const segments = path.split("/");
    const leaf = segments.pop() as string;
    let cursor: Record<string, unknown> = merged;
    let bad = false;

    for (const [depth, seg] of segments.entries()) {
      const next = cursor[seg];
      if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
        const walked = segments.slice(0, depth).join("/");
        issues.push({
          where: `override.${path}`,
          message:
            `中间路径 \`${segments.slice(0, depth + 1).join("/")}\` 在基定义里不存在或不是对象。` +
            `可用键：${Object.keys(cursor).sort().join(", ") || "（无）"}` +
            (walked === "" ? "" : `（已走到 \`${walked}\`）`),
        });
        bad = true;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (bad) continue;
    cursor[leaf] = value as unknown;
  }

  if (issues.length > 0) return { ok: false, issues };

  const parsed = ContainerTemplate.safeParse(merged);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        where: `merged.${i.path.join(".") || "(根)"}`,
        message: i.message,
      })),
    };
  }
  return { ok: true, merged: parsed.data };
}
