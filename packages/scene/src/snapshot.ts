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

/**
 * 地址是**一段**（V6 阶段 1b）：`instance` 就是节点自己的实例路径。
 *
 * 原来是 `{traceid, node, port}`。改这里时后端只有映射那一处会报编译错误 ——
 * 前端读点全都编译通过，因为它们读的是这份自己声明的形状。**那道保险就是
 * 文件头说的 parse**：形状对不上，`Snapshot.safeParse` 当场指着字段名失败。
 */
const Endpoint = z.object({
  instance: z.string(),
  port: z.string(),
});

const Source = z.object({
  instance: z.string(),
  port: z.string().optional(),
});

/**
 * **模板内部**的节点引用 —— 与 `Endpoint` 不是一回事。
 *
 * 这里原来写的是 `Endpoint.partial({ traceid: true })`：拿实例地址删掉一个字段
 * 当模板引用用。两者同型只是巧合（都恰好有 `{node, port}`），语义上一个指
 * "运行中的哪个节点"、一个指"这份模板里的哪个节点"。contracts 那边本来就是
 * `PortRef` 与 `Endpoint` 两个类型，只有这份线上 schema 把它们并了 ——
 * 地址收成一段之后并不动了，正好分开。
 */
const PortRef = z.object({
  node: z.string(),
  port: z.string(),
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
  /** 执行位点 —— 节点自己的实例路径，一段（V6 阶段 1b），与 `target.instance` 同形。 */
  instance: z.string(),
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
  edges: z.record(z.object({ from: PortRef, to: PortRef })).default({}),
  children: z
    .record(
      z.object({
        template: z.string(),
        entry: PortRef.optional(),
        exit: PortRef.optional(),
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
