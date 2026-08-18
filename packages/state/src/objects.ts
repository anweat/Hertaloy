/**
 * 对象库落盘 —— 写一次的那一半（§17.2 / §17.3）。
 *
 * 每个版本一个文件，文件名就是版本号。写一次之后永不重写，所以：
 *   - 不需要加锁，不需要事务
 *   - 崩溃时最坏留下一个半截文件，读的时候 JSON 解析失败即发现
 *   - 增量刷盘只写 `store.appended(cursor)` 那一段
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ObjectVersion } from "@nodeflow/contracts";
import type { ObjectStore } from "@nodeflow/kernel";
import { decodeObjectDir, objectDir, objectPath, parseVersionFile, versionFile } from "./paths.js";

/**
 * 把游标之后的新版本写进 `<root>/objects/`，返回新游标。
 *
 * **大小写碰撞检测在这里**（§17.3）：编码层保证可逆，但保证不了文件系统。
 * 在不区分大小写的盘上，`result` 与 `Result` 会落到同一个文件 —— 后写的
 * 静默覆盖先写的，两个对象的历史合并成一个，且读的时候完全看不出来。
 * 所以写之前如果文件已存在，就读回来比对 object_id：不同即当场炸。
 */
export function flushObjects(root: string, store: ObjectStore, cursor: number): number {
  for (const version of store.appended(cursor)) {
    const file = join(root, "objects", objectPath(version.object_id, version.version));
    if (existsSync(file)) {
      const found = (JSON.parse(readFileSync(file, "utf8")) as ObjectVersion).object_id;
      if (found !== version.object_id) {
        throw new Error(
          `文件系统不区分大小写：对象 ${version.object_id} 与 ${found} 落到同一个文件 ` +
            `${file}。state-root 必须放在区分大小写的文件系统上（§17.3）。`,
        );
      }
      continue; // 同一个对象的同一版，已经写过了
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(version, null, 2)}\n`, "utf8");
  }
  return store.appendCount;
}

/**
 * 把整棵 `objects/` 装回内存。
 *
 * 每个对象的版本按号升序装 —— `ObjectStore.load` 会校验连续性，
 * 缺文件当场炸而不是等到某次 `read(ref)`。
 */
export function loadObjects(root: string, store: ObjectStore): number {
  const base = join(root, "objects");
  if (!existsSync(base)) return 0;

  for (const [objectId, dir] of walk(base, "")) {
    const versions: ObjectVersion[] = [];
    for (const name of readdirSync(dir)) {
      const n = parseVersionFile(name);
      if (n === null) continue;
      versions.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ObjectVersion);
    }
    if (versions.length === 0) continue;
    versions.sort((a, b) => a.version - b.version);
    for (const v of versions) {
      if (v.object_id !== objectId) {
        throw new Error(`${dir} 下的对象自称 ${v.object_id}，与目录路径 ${objectId} 不符`);
      }
    }
    store.load(versions);
  }
  return store.appendCount;
}

/** 深度优先找出所有"含版本文件的目录" —— 那才是一个对象。 */
function* walk(base: string, rel: string): Generator<readonly [string, string]> {
  const dir = rel === "" ? base : join(base, rel);
  const entries = readdirSync(dir, { withFileTypes: true });

  // 对象目录可以同时是别的对象的父目录（`a` 与 `a/b` 都是对象），所以
  // "有版本文件"与"继续往下走"两件事都要做，不能二选一
  if (entries.some((e) => e.isFile() && parseVersionFile(e.name) !== null)) {
    yield [decodeObjectDir(rel), dir];
  }
  for (const e of entries) {
    if (e.isDirectory()) yield* walk(base, rel === "" ? e.name : `${rel}/${e.name}`);
  }
}

/** 某个对象在磁盘上的版本数 —— 给 CLI 与测试用，不必装载整库。 */
export function versionsOnDisk(root: string, objectId: string): readonly number[] {
  const dir = join(root, "objects", objectDir(objectId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(parseVersionFile)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

export { versionFile };
