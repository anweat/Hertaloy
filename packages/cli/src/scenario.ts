/**
 * 场景文件 —— CLI 的输入格式。
 *
 * 一份格式，两个用法：
 *
 *   `hertaloy run <场景>`   一次性跑完，不落盘 —— 快速验证图对不对
 *   `hertaloy init <目录> <场景>`  建一个持久化的 run —— 之后用 status / drain / send
 *
 * 早先只有前者，因为还没有持久化；那条限制现在没有了。
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
