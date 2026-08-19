/**
 * 资源注册表的落盘 —— `<state-root>/resources.json`。
 *
 * 与 `permissions.json` 同一档：**外部配置，不进对象库**（§17.9 的同一条理由）。
 * 它回答的是"这台机器上有什么可用"，而不是"这个 run 发生了什么"。
 *
 * 动态上载就是往这里加一条：`hertaloy resources <dir> add <名> <种类> <路径>`。
 * 加完之后模板里写那个名字即可 —— 模板本身不必改、也不知道路径变了。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESOURCES_FORMAT,
  type ResourceRegistry,
  ResourceSource,
  ResourcesFile,
} from "@nodeflow/contracts";

export const RESOURCES_FILE = "resources.json";

export interface LoadedResources {
  readonly registry: ResourceRegistry;
  readonly source: "file" | "default";
}

export function resourcesPath(dir: string): string {
  return join(dir, RESOURCES_FILE);
}

/**
 * 读注册表。没有文件就是**空表** —— 不是"随便什么路径都行"。
 *
 * 一条写坏就整表拒绝，与权限表同一个理由：跳过坏的用好的，
 * 会让一次手滑的编辑静默改变 agent 能碰到什么。
 */
export function loadResources(dir: string): LoadedResources {
  const path = resourcesPath(dir);
  if (!existsSync(path)) return { registry: {}, source: "default" };

  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = ResourcesFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${path} 非法：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
    );
  }
  return { registry: parsed.data.resources, source: "file" };
}

export function writeResources(dir: string, registry: ResourceRegistry): void {
  writeFileSync(
    resourcesPath(dir),
    `${JSON.stringify({ format: RESOURCES_FORMAT, resources: registry }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 加一条。**同名已存在就拒绝** —— 覆盖一个别名意味着所有引用它的模板
 * 悄悄换了指向，那种改动应该是显式的（先 remove 再 add）。
 */
export function addResource(
  dir: string,
  name: string,
  source: ResourceSource,
): ResourceRegistry {
  const parsed = ResourceSource.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `资源定义非法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`,
    );
  }
  const { registry } = loadResources(dir);
  if (registry[name] !== undefined) {
    throw new Error(
      `资源 \`${name}\` 已存在（${registry[name].kind} → ${registry[name].path}）。` +
        "要改指向就先 remove —— 悄悄换掉一个别名会让所有引用它的模板跟着变。",
    );
  }
  const next = { ...registry, [name]: parsed.data };
  writeResources(dir, next);
  return next;
}

export function removeResource(dir: string, name: string): ResourceRegistry {
  const { registry } = loadResources(dir);
  if (registry[name] === undefined) throw new Error(`没有资源 \`${name}\``);
  const next = { ...registry };
  delete next[name];
  writeResources(dir, next);
  return next;
}
