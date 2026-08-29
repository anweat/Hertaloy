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
  tunnel: z.string().optional(),
});

export const SnapshotInstance = z.object({
  traceid: z.string(),
  templateRef: z.string(),
  status: z.string(),
  slot: z.string().optional(),
  nodes: z.record(z.object({ nodeId: z.string() })).default({}),
});

export const SnapshotRecord = z.object({
  traceid: z.string(),
  nodeId: z.string(),
  status: z.string(),
  termination: z.string().optional(),
});

const PortDecl = z.object({
  direction: z.enum(["receive", "emit"]),
  contract: z.string().optional(),
  tunnel: z.string().optional(),
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
  subscriptions: z
    .record(z.object({ tunnel: z.string(), to: Endpoint.partial({ traceid: true }) }))
    .default({}),
});

export const SnapshotObject = z.object({
  object_id: z.string(),
  kind: z.string(),
  version: z.number(),
});

export const SnapshotLock = z.object({
  id: z.string(),
  holder: z.string(),
  kind: z.string(),
  key: z.string(),
  /** 等谁 —— 有它才画得出"谁挡着谁"。 */
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
  locks: z.array(SnapshotLock).default([]),
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
