/**
 * 快照 —— 后端送过来的那份普通 JSON，`scene` 唯一的输入。
 *
 * ## 为什么在边界上 parse 而不是直接 as
 *
 * `scene` 不 import 任何后端包（RENDERING.md §8 第 1 条），所以它拿不到内核的
 * `Message` / `ContainerInstance` 类型，只能按**自己需要的形状**声明。
 * 那确实是两处定义，会漂。
 *
 * 分界在于：漂了之后**是响一声还是不响**。这里 parse，于是后端改了形状
 * 前端立刻 parse 失败、指着字段名报错；直接 `as` 的话画面照常渲染，
 * 只是少了半张图或者位置全错 —— 而没人会发现。这个项目被"两端各自都绿"
 * 咬过六次，代价就是多写这一份 schema。
 *
 * 等 `Message` 等纯类型搬进 contracts（RENDERING.md §8），这份 schema 换成
 * 从 contracts 派生，两处定义就合成一处。**在那之前，parse 是那道保险。**
 *
 * ## `$hertaloy$map` 不在这里解
 *
 * head 落盘时把 Map 编码成 `{"$hertaloy$map": [[k,v],...]}`。那是**存储编码**，
 * 不该泄漏到线上：后端在送出快照前解掉，前端看到的就是普通对象。
 * 这不是"双格式"（那是两份各自维护的授权格式），是同一份格式脱掉存储外衣。
 */

import { z } from "zod";

const Endpoint = z.object({
  traceid: z.string(),
  node: z.string(),
  port: z.string(),
});

const Source = z.object({
  traceid: z.string(),
  node: z.string().optional(),
  port: z.string().optional(),
});

export const SnapshotMessage = z.object({
  id: z.string(),
  target: Endpoint,
  state: z.string(),
  /** 观测用来源。省略 = 外部注入（人 / CLI / MCP）。 */
  source: Source.optional(),
  /** 经哪个别名出的网关。省略 = 走内网边。 */
  alias: z.string().optional(),
});

/**
 * 一条**已物化到实例上**的别名绑定。
 *
 * 画布从这里读"声明过的去向"，而不是从模板的订阅块 —— 订阅块随隧道一起删了，
 * 而且它本来也答不出"这一条会投到哪儿"（要扫全树匹配）。绑定表是自足的。
 */
export const SnapshotBinding = z.object({
  alias: z.string(),
  /** 声明它的容器。槽枚举在这个容器名下进行；去重也按它。 */
  container: z.string(),
  slot: z.string().optional(),
  external: z.string().optional(),
  node: z.string(),
  port: z.string(),
});

export type SnapshotBinding = z.infer<typeof SnapshotBinding>;

export const SnapshotInstance = z.object({
  traceid: z.string(),
  templateRef: z.string(),
  status: z.string(),
  slot: z.string().optional(),
  bindings: z.array(SnapshotBinding).default([]),
});

export const SnapshotRecord = z.object({
  /** 执行身份。没有它就只能靠"第几条"猜，而重试之后那是错的。 */
  executionId: z.string().optional(),
  traceid: z.string(),
  nodeId: z.string(),
  status: z.string(),
  termination: z.string().optional(),
  /** agent 自报的语义进度 —— 内核原则上推不出来的那一半。 */
  progress: z
    .object({ done: z.number(), total: z.number(), note: z.string().optional() })
    .optional(),
  /** 报了但格式不合法时的说明 —— 与"没上报"分开表达。 */
  progressUnavailable: z.string().optional(),
});

const PortDecl = z.object({
  direction: z.enum(["receive", "emit"]),
  contract: z.string().optional(),
  alias: z.string().optional(),
});

export const SnapshotTemplate = z.object({
  nodes: z
    .record(
      z.object({
        handler: z.string().optional(),
        agent: z.object({ argv: z.array(z.string()) }).passthrough().optional(),
        ports: z.record(PortDecl).default({}),
      }),
    )
    .default({}),
  edges: z.record(z.object({ from: Endpoint.partial({ traceid: true }), to: Endpoint.partial({ traceid: true }) })).default({}),
  children: z
    .record(
      z.object({
        template: z.string(),
        entry: Endpoint.partial({ traceid: true }).optional(),
        exit: Endpoint.partial({ traceid: true }).optional(),
      }),
    )
    .default({}),
});

export const SnapshotObject = z.object({
  object_id: z.string(),
  kind: z.string(),
  version: z.number(),
  /** 真实归属（`provenance.traceid`）—— 不从 object_id 切段推。 */
  owner: z.string().optional(),
});

/**
 * 一份未了结的义务。
 *
 * `kind` 是**派生描述符**，不是要认的闭集 —— 所以这里是 `z.string()`：
 * 后端加一种等待形态时，这份 schema 一行都不用改。谁挡着谁靠
 * `waitingOn` **有没有**来判（见 `build.ts` 的等待段）。
 */
export const SnapshotObligation = z.object({
  holder: z.string(),
  kind: z.string(),
  key: z.string(),
  /** 在等谁。省略 = 自己还在跑（message / execution）。 */
  waitingOn: z.string().optional(),
  originNode: z.string().optional(),
});

/**
 * 一个节点**最后一次成功提交**消费了哪条消息。
 *
 * 存在的理由：`records` 只有 agent 节点有（见 `phaseOfNode`）。没有这一份，
 * 同步节点的相位只能默认成 idle —— 而那是一句正面断言，说的却是一件
 * 从来没被观测过的事。
 */
export const SnapshotCommit = z.object({
  traceid: z.string(),
  node: z.string(),
  /** 精确提交正文；旧快照可能只有 consumed。 */
  ref: z.string().optional(),
  /** 通常恰好一条（一次提交消费一条消息）。留数组是照抄 `$run` 的形状。 */
  consumed: z.array(z.string()).default([]),
});

/** 后端送来的一整份。 */
export const Snapshot = z.object({
  root: z.string().nullable(),
  instances: z.record(SnapshotInstance),
  /** 模板按 `id@N` 索引 —— 多个实例共用一份，别重复送。 */
  templates: z.record(SnapshotTemplate),
  messages: z.array(SnapshotMessage),
  records: z.array(SnapshotRecord).default([]),
  objects: z.array(SnapshotObject).default([]),
  obligations: z.array(SnapshotObligation).default([]),
  commits: z.array(SnapshotCommit).default([]),
});

export type Snapshot = z.infer<typeof Snapshot>;
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;
export type SnapshotTemplate = z.infer<typeof SnapshotTemplate>;

/** 解析并报清楚是哪个字段坏了 —— 边界上失败要响。 */
export function parseSnapshot(raw: unknown): Snapshot {
  const parsed = Snapshot.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      ["快照格式不符：", ...parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`)].join(
        "\n  ",
      ),
    );
  }
  return parsed.data;
}
