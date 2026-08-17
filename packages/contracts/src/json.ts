/** 通用 JSON 值。payload、literal、body 共用。 */

import { z } from "zod";

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(Json),
    z.record(Json),
  ]),
) as z.ZodType<Json>;

export const JsonObject = z.record(Json);
export type JsonObject = z.infer<typeof JsonObject>;
