/**
 * 资源别名的契约 —— **名字 → 真实位置** 的映射规则。
 *
 * 与 `Grant` 同例：配置文件的 schema 归 contracts，因为它是**跨包共享的约定**
 * （state 负责读、sandbox 负责用），不该由任何一端私有。
 *
 * 三条不变的性质：
 *
 * - **模板只写名字。**`workspace: { source: "primary" }` 里的 `primary` 是别名，
 *   agent 拿不到它指向哪个仓库、在宿主机哪个盘。与密钥同构：放取值方式，不放值。
 * - **注册表不进对象库。**它是"这台机器上有什么"的配置，跟着对象库走会连带获得
 *   不可变 + 内容寻址 + 按前缀可读 —— 那三条对配置有害（撤不回来）。
 * - **默认空表。**没配就是没有任何资源可用，声明了 `workspace` 的模板会失败
 *   并说清已配置哪些名字。这是第一不变量的同一条纪律：**能用的必须是显式给的**。
 */

import { z } from "zod";

/**
 * 资源种类决定**怎么物化**、以及**落在 agent 视野的哪里**。
 *
 * 后两种（`skill` / `mcp`）是"别名当宏"的落点：同一个名字，
 * 在 claude-code 下落 `.claude/skills/`，在我们自己的 agent 下落
 * `.hertaloy/skills/` —— **一个名字展开成各家认识的形态**，
 * 而模板里只写那个名字。放哪由 profile 决定，不由模板决定。
 */
export const RESOURCE_KINDS = ["git", "dir", "skill", "mcp"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const ResourceKind = z.enum(RESOURCE_KINDS);

export const ResourceSource = z
  .object({
    kind: ResourceKind,
    /** 宿主机路径。**agent 永远看不到这个值。** */
    path: z.string().min(1),
    /** 仅 `git`：不指定 base 时用哪个 ref。 */
    defaultBase: z.string().min(1).optional(),
    /** 给人看的一句话。会出现在 agent 的环境交代里，帮它判断该不该用。 */
    note: z.string().optional(),
  })
  .strict();

export type ResourceSource = z.infer<typeof ResourceSource>;

/** 别名 → 来源。别名是 `Ident`，与端口、子槽同一套命名规则。 */
export const ResourceRegistry = z.record(ResourceSource);
export type ResourceRegistry = z.infer<typeof ResourceRegistry>;

export const RESOURCES_FORMAT = 1;

export const ResourcesFile = z
  .object({
    format: z.literal(RESOURCES_FORMAT),
    resources: ResourceRegistry,
  })
  .strict();

export type ResourcesFile = z.infer<typeof ResourcesFile>;

/** `git` 源才能当工作区 —— 工作树需要历史，普通目录没有。 */
export function canBeWorkspace(source: ResourceSource): boolean {
  return source.kind === "git";
}
