/**
 * 根权限表 —— **外部配置文件，不进对象库**（§17.9）。
 *
 * 自举问题：权限表若是对象，改它就要过 `ControlPlane`，而 `ControlPlane`
 * 要读权限表判断 —— 成环。解法是分层：
 *
 *   根表   来自启动配置（这个文件）。信任的起点，改它要停机改文件 ——
 *          这正是"人有完整权限"该有的形状。
 *   子授权 是对象，走版本历史、可审计、可撤销（发新版本）。
 *
 * 文件放在状态根下、`objects/` **之外**：它不是 run 的状态，是这台机器上
 * 谁能碰这个 run 的配置。跟着对象库走会连带获得"不可变、内容寻址、
 * 按前缀可读"——那三条对密钥有害，对权限表同样有害（撤不回来）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Grant, PermissionTable } from "@nodeflow/contracts";

export const PERMISSIONS_FILE = "permissions.json";
export const PERMISSIONS_FORMAT = 1;

/**
 * 缺省授权：**人类全权，agent 无权**。
 *
 * 这两半各有各的理由，不是一句"方便"：
 *
 *   人类全权 —— G 目标写的就是"人也有完整权限"。默认拒绝会让每条 CLI 命令
 *               开箱即败，而这是本机开发工具。
 *   agent 无权 —— 第一不变量。agent 的每一份权限都必须是**显式给的**，
 *               默认给了就等于没有这条不变量。
 *
 * 缺省是有代价的选择，所以 `source` 会一路报到 `status` 里，让人看得见
 * 现在跑的是缺省表还是配置表。
 */
export const DEFAULT_GRANTS: readonly Grant[] = [
  { principal: "human:*", scope: "*", ops: ["DDL", "DML", "DQL"] },
];

export interface LoadedPermissions {
  readonly table: PermissionTable;
  readonly source: "file" | "default";
  readonly grants: readonly Grant[];
}

export function permissionsPath(dir: string): string {
  return join(dir, PERMISSIONS_FILE);
}

export function loadPermissions(dir: string): LoadedPermissions {
  const path = permissionsPath(dir);
  const grants = existsSync(path) ? parseFile(path) : DEFAULT_GRANTS;
  const table = new PermissionTable();
  for (const g of grants) table.grant(g);
  return { table, source: existsSync(path) ? "file" : "default", grants };
}

function parseFile(path: string): readonly Grant[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    format?: number;
    grants?: readonly unknown[];
  };
  if (raw.format !== PERMISSIONS_FORMAT) {
    throw new Error(
      `${path} 是格式 ${String(raw.format)}，本内核只认 ${PERMISSIONS_FORMAT}。` +
        "权限表读错比读不出更危险，所以对不上就拒绝。",
    );
  }
  if (!Array.isArray(raw.grants)) {
    throw new Error(`${path} 缺 grants 数组`);
  }
  // 逐条过 zod：一条写错就整表拒绝，不是"跳过坏的用好的" ——
  // 那会让一个手滑的编辑静默地扩大或缩小权限
  return raw.grants.map((g, i) => {
    const parsed = Grant.safeParse(g);
    if (!parsed.success) {
      throw new Error(
        `${path} 第 ${i + 1} 条授权非法：` +
          parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("；"),
      );
    }
    return parsed.data;
  });
}

/** 把当前（或给定）授权写成配置文件 —— `hertaloy permissions init` 的落点。 */
export function writePermissions(dir: string, grants: readonly Grant[] = DEFAULT_GRANTS): void {
  writeFileSync(
    permissionsPath(dir),
    `${JSON.stringify({ format: PERMISSIONS_FORMAT, grants }, null, 2)}\n`,
    "utf8",
  );
}
