/**
 * 模板构造器 —— **只减样板，不加权威**。
 *
 * 一条纪律，比这个模块本身重要：**构造器返回的就是 `ContainerTemplate` 值本身**，
 * 不是另一套中间表示。这个项目被"两处对同一事实各有一套规则"咬过五次
 * （K5 AgentSpec、E1 backend 没接线、MessageContract 注册不进去、
 * Ref 字符集、profile 没接线）。如果构造器有自己的表示再"编译"成模板，
 * 那就是第六次 —— 而返回同一个类型，类型系统就替我们挡住了漂移，
 * 注册期校验也一行都不用改。
 *
 * 所以这里全是**纯函数拼对象**，没有 DSL、没有状态、没有构建器链。
 */

import type { ContainerTemplate, EdgeDefinition, NodeDefinition, PortMap } from "@nodeflow/contracts";

/** `$.name` 的简写：变量名与取值路径同名时不必写两遍。 */
export function vars(...names: readonly string[]): Record<string, { type: "short"; from: string }> {
  return Object.fromEntries(names.map((n) => [n, { type: "short" as const, from: `$.${n}` }]));
}

export interface ReceiveOptions {
  /** 变量声明。给字符串数组就是"同名取值"的简写。 */
  readonly vars?: readonly string[] | Record<string, unknown>;
  /** 载荷 schema 的精确引用（`id@N`）。 */
  readonly contract?: string;
}

function receive(options: ReceiveOptions = {}): Record<string, unknown> {
  const declared = Array.isArray(options.vars)
    ? vars(...(options.vars as readonly string[]))
    : ((options.vars ?? {}) as Record<string, unknown>);
  return {
    direction: "receive",
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    servo: { vars: declared },
  };
}

function ports(inPort: ReceiveOptions, emits: readonly string[]): PortMap {
  const map: Record<string, unknown> = { in: receive(inPort) };
  for (const name of emits) map[name] = { direction: "emit" };
  return map as PortMap;
}

/** 受信 handler 节点。 */
export function handlerNode(
  handler: string,
  inPort: ReceiveOptions,
  emits: readonly string[] = [],
): NodeDefinition {
  return { kind: "handler", handler, ports: ports(inPort, emits) } as NodeDefinition;
}

export interface AgentNodeOptions {
  readonly workspace?: { readonly source: string; readonly base?: string } | { readonly from: string };
  readonly resources?: Record<string, string>;
  readonly profile?: string;
  readonly env?: Record<string, string>;
}

/** agent 节点 —— 一条命令行。 */
export function agentNode(
  argv: readonly string[],
  inPort: ReceiveOptions,
  emits: readonly string[] = ["out"],
  options: AgentNodeOptions = {},
): NodeDefinition {
  return {
    kind: "handler",
    agent: { argv: [...argv], ...options },
    ports: ports(inPort, emits),
  } as NodeDefinition;
}

/**
 * 把一条**普通命令行**包成节点（`hertaloy agent --exec`）。
 *
 * 默认出 `ok` / `err` 两个端口，因为退出码就是这么分的。
 * **`err` 是显式声明的** —— 不声明就意味着"这条流程不打算处理失败"，
 * 那时失败会真的失败。这个默认只是省事，不是替你做决定：
 * 不想要 `err` 分支就传 `["ok"]`。
 */
export function execNode(
  hertaloy: readonly string[],
  command: readonly string[],
  inPort: ReceiveOptions = {},
  options: AgentNodeOptions = {},
  emits: readonly string[] = ["ok", "err"],
): NodeDefinition {
  return agentNode([...hertaloy, "agent", "--exec", ...command], inPort, emits, options);
}

/**
 * 纯转发节点。**这是示例，不是机制。**
 *
 * 边本身永远是纯前向的（M1：边是唯一的地址权威）。这个节点只是让示例图
 * 看起来对称一些 —— 真要转发，一条边就够了，不需要中间节点。
 * 它存在的唯一理由是：有人问"边能不能画成节点"，答案是能，但没必要。
 */
export function forwardNode(inPort: ReceiveOptions = {}): NodeDefinition {
  return handlerNode("echo", inPort, ["out"]);
}

export function edge(from: string, to: string): EdgeDefinition {
  const [fromNode, fromPort] = from.split(".");
  const [toNode, toPort] = to.split(".");
  if (fromPort === undefined || toPort === undefined) {
    throw new Error(`边要写成 \`节点.端口\`，收到 ${JSON.stringify([from, to])}`);
  }
  return {
    from: { node: fromNode as string, port: fromPort },
    to: { node: toNode as string, port: toPort },
  } as EdgeDefinition;
}

/** `["a.out -> b.in", …]` → 边表。名字自动按顺序生成。 */
export function edges(...specs: readonly string[]): Record<string, EdgeDefinition> {
  const out: Record<string, EdgeDefinition> = {};
  specs.forEach((spec, i) => {
    const [from, to] = spec.split("->").map((s) => s.trim());
    if (from === undefined || to === undefined) {
      throw new Error(`边要写成 \`a.out -> b.in\`，收到 ${JSON.stringify(spec)}`);
    }
    out[`e${String(i + 1)}`] = edge(from, to);
  });
  return out;
}

export interface TemplateInput {
  readonly nodes: Record<string, NodeDefinition>;
  readonly edges?: Record<string, EdgeDefinition>;
  readonly children?: Record<string, unknown>;
  readonly subscriptions?: Record<string, unknown>;
}

/**
 * 拼一份容器模板。**返回的就是 `ContainerTemplate`** —— 没有中间表示。
 *
 * 它不做校验：校验归注册期（`define` / `validate_template`），
 * 那里才有 store 能解析引用。在这里再验一遍就是第二处真相。
 */
export function template(input: TemplateInput): ContainerTemplate {
  return {
    nodes: input.nodes,
    edges: input.edges ?? {},
    children: input.children ?? {},
    subscriptions: input.subscriptions ?? {},
  } as ContainerTemplate;
}

/** 场景文件：模板 + 根 + 入站消息。 */
export function scenario(input: {
  readonly id: string;
  readonly spec: ContainerTemplate;
  readonly root?: string;
  readonly send?: readonly { traceid: string; node: string; port: string; payload?: unknown }[];
}): Record<string, unknown> {
  return {
    templates: [{ id: input.id, kind: "root_config", spec: input.spec }],
    root: { template: input.id, id: input.root ?? "job-1" },
    send: input.send ?? [],
  };
}
