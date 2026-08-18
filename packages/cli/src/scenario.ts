/**
 * 场景文件 —— CLI 的输入格式。
 *
 * 因为**还没有持久化**，CLI 不能跨进程保持状态：`define` 完再 `run` 是两个进程，
 * 第二个不记得第一个做了什么。所以这一版走"一次性场景"：定义 + 实例化 + 投递
 * 全写在一个文件里，一条命令跑完。等持久化落地再拆成有状态的子命令。
 *
 * 这是个诚实的限制，不是设计选择 —— 写在这里免得后来的人以为一次性是有意为之。
 */

import { z } from "zod";
import { Json } from "@nodeflow/contracts";

export const SendSpec = z
  .object({
    traceid: z.string(),
    node: z.string(),
    port: z.string(),
    payload: Json.default({}),
  })
  .strict();

export const Scenario = z
  .object({
    /** 按声明顺序注册；后面的可以 `extends` 前面的（覆盖层）。 */
    templates: z.array(
      z.object({ id: z.string(), kind: z.string().optional(), spec: z.unknown() }).strict(),
    ),
    /** 根容器：用哪个模板 id、叫什么。 */
    root: z.object({ template: z.string(), id: z.string().default("root") }).strict(),
    /** 入站消息，按顺序投递后统一 drain。 */
    send: z.array(SendSpec).default([]),
  })
  .strict();

export type Scenario = z.infer<typeof Scenario>;
