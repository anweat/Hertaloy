/**
 * ObjectStore —— 版本分配的唯一权威。
 *
 * 对应 FOUNDATION_V5.md 不变量 V1–V4：
 *   V1 版本号只由 store 分配，单调，per object_id
 *   V2 ObjectVersion 独立于实例
 *   V3 内容寻址 + 幂等：同内容重复提交返回同一版本
 *   V4 引用永远精确
 *
 * 承载全部定义与产物：卡片 / 契约 / 策略 / 容器模板 / 提案 / 产物 / 标注 / run 快照 / layout。
 * 不再有 V4 那 14 张平行注册表。
 */

import { createHash } from "node:crypto";
import {
  type Json,
  type JsonObject,
  type ObjectVersion,
  type Provenance,
  type Ref,
  parseRef,
} from "@nodeflow/contracts";
import { InvariantError } from "./errors.js";
import type { Snapshotable } from "./tx.js";

const EMPTY_PROVENANCE: Provenance = { at_seq: 0, derived_from: [] };

/** 规范化序列化：键排序，保证同内容跨进程逐字节相同。 */
export function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, Json>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * 内容哈希。
 *
 * 取全量 sha256 —— 截断到 16 位十六进制只有 64 位，作为长期内容权威太窄
 * （生日界约 2^32 就有碰撞风险，而这里的碰撞会让两份不同内容共用一个版本，
 * 直接破坏 V3 幂等的正确性方向）。
 */
export function contentHash(body: JsonObject): string {
  return createHash("sha256").update(stableStringify(body), "utf8").digest("hex");
}

/**
 * 深冻结 —— `Object.freeze` 只冻一层，嵌套字段仍可改。
 *
 * 不做这一步，调用方入库后修改 `body.tasks[0]` 就能让**已存版本的内容变化而
 * content_hash 不变**，V2（独立于实例）与 V3（内容寻址）同时破防。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** 入库快照：先深克隆切断与调用方的引用，再深冻结。 */
function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * 去重键。NUL 做分隔符是因为它不可能出现在 object_id 或十六进制哈希里。
 * 抽成函数是因为 `put` 与 `load` 必须用**同一条**规则 —— 两处各写一遍就会漂移。
 */
function dedupeKey(objectId: string, hash: string): string {
  return `${objectId}\u0000${hash}`;
}

interface StoreSnapshot {
  readonly lengths: ReadonlyMap<string, number>;
  readonly hashKeys: ReadonlySet<string>;
  readonly logLength: number;
}

export class ObjectStore implements Snapshotable {
  readonly #byObject = new Map<string, ObjectVersion[]>();
  readonly #byHash = new Map<string, ObjectVersion>();
  /**
   * 入库顺序的追加日志 —— **增量刷盘的游标**（§17.4）。
   *
   * `#byObject` 只有"每个对象的版本序列"，没有跨对象的先后，所以答不出
   * "上次刷盘之后新增了哪些版本"。没有它，每次落盘就得重写整个对象库。
   *
   * 不额外占空间：装的是与 `#byObject` 同一批冻结对象的引用。
   */
  readonly #log: ObjectVersion[] = [];

  /**
   * append-only ⇒ 快照只需记住每个 object 的长度和已有的 hash 键；
   * 回滚就是把多出来的版本截掉。不需要拷贝 body。
   */
  snapshot(): StoreSnapshot {
    const lengths = new Map<string, number>();
    for (const [id, versions] of this.#byObject) lengths.set(id, versions.length);
    return { lengths, hashKeys: new Set(this.#byHash.keys()), logLength: this.#log.length };
  }

  restore(snap: unknown): void {
    const { lengths, hashKeys, logLength } = snap as StoreSnapshot;
    this.#log.length = logLength;
    for (const [id, versions] of [...this.#byObject]) {
      const keep = lengths.get(id) ?? 0;
      if (keep === 0) this.#byObject.delete(id);
      else if (versions.length > keep) versions.length = keep;
    }
    for (const key of [...this.#byHash.keys()]) {
      if (!hashKeys.has(key)) this.#byHash.delete(key);
    }
  }

  /** 唯一写入口。同内容重复提交返回既有版本（V3 幂等）。 */
  put(
    objectId: string,
    kind: string,
    body: JsonObject,
    provenance: Provenance = EMPTY_PROVENANCE,
  ): ObjectVersion {
    if (objectId.includes("@")) {
      throw new InvariantError(`object_id 不得含 '@'（版本由内核追加）：${objectId}`);
    }
    const hash = contentHash(body);
    const key = dedupeKey(objectId, hash);
    const existing = this.#byHash.get(key);
    if (existing !== undefined) return existing;

    const versions = this.#byObject.get(objectId) ?? [];
    const version: ObjectVersion = deepFreeze({
      object_id: objectId,
      version: versions.length + 1,
      kind,
      content_hash: hash,
      // 深克隆 + 深冻结：入库后调用方再改原对象，已存版本不受影响
      body: snapshot(body),
      provenance: snapshot(provenance),
    });
    versions.push(version);
    this.#byObject.set(objectId, versions);
    this.#byHash.set(key, version);
    this.#log.push(version);
    return version;
  }

  /** 已入库的版本总数 —— 刷盘游标就是这个数（§17.4）。 */
  get appendCount(): number {
    return this.#log.length;
  }

  /** 第 `since` 个之后新增的版本，按入库顺序。刷盘只写这一段。 */
  appended(since: number): readonly ObjectVersion[] {
    return this.#log.slice(since);
  }

  /**
   * 从磁盘装回版本 —— **逐字节原样**，不重新分配版本号。
   *
   * 与 `put` 的区别正在这里：`put` 是"提交一份新内容"，版本号由内核给；
   * `load` 是"把已经发生过的事实读回来"，版本号是事实的一部分。
   * 走 `put` 装载会在任何一次去重命中时把后续版本号全体前移 —— 于是
   * 磁盘上的 `@3` 变成内存里的 `@2`，所有 `Ref` 集体失效。
   *
   * 顺带做**完整性校验**：版本号必须从 1 起连续。磁盘上缺一个文件
   * （拷贝拷漏了、GC 删错了）在这里当场炸，而不是等某个 `read(ref)` 才炸。
   */
  load(versions: readonly ObjectVersion[]): void {
    for (const version of versions) {
      const existing = this.#byObject.get(version.object_id) ?? [];
      if (version.version !== existing.length + 1) {
        throw new InvariantError(
          `对象 ${version.object_id} 的版本不连续：装到第 ${existing.length + 1} 版时读到 @${version.version}`,
        );
      }
      const frozen = deepFreeze(version);
      existing.push(frozen);
      this.#byObject.set(version.object_id, existing);
      this.#byHash.set(dedupeKey(version.object_id, version.content_hash), frozen);
      this.#log.push(frozen);
    }
  }

  get(objectId: string, version: number): ObjectVersion {
    const found = this.#byObject.get(objectId)?.[version - 1];
    if (found === undefined) {
      throw new InvariantError(`未知版本 ${objectId}@${version}`);
    }
    return found;
  }

  /** 只接受精确引用 `object_id@version`（不变量 V4）。 */
  resolve(ref: Ref): ObjectVersion {
    const { objectId, version } = parseRef(ref);
    return this.get(objectId, version);
  }

  head(objectId: string): ObjectVersion {
    const versions = this.#byObject.get(objectId);
    const last = versions?.[versions.length - 1];
    if (last === undefined) throw new InvariantError(`未知对象 ${objectId}`);
    return last;
  }

  history(objectId: string): readonly ObjectVersion[] {
    return [...(this.#byObject.get(objectId) ?? [])];
  }

  has(objectId: string): boolean {
    return this.#byObject.has(objectId);
  }

  /**
   * 按 **traceid 前缀 + 名字** 收集 —— 跨实例汇聚靠它（剧本帧 12）。
   *
   * object_id 是路径：`job-1/coder-1/results`。最后一段是名字，
   * 前面是拥有者的 traceid。前缀匹配落在**段边界**上，
   * 所以 `job-1` 不会捞到 `job-10/...`。
   *
   * 返回**每个匹配对象的最新版本**（而不是全部版本）：
   * 汇聚问的是"有几个生产者交货了"，不是"一共写了多少次"。
   */
  collect(prefix: string, name: string): readonly ObjectVersion[] {
    const suffix = `/${name}`;
    const out: ObjectVersion[] = [];
    for (const [objectId, versions] of this.#byObject) {
      if (!objectId.endsWith(suffix)) continue;
      const owner = objectId.slice(0, -suffix.length);
      if (owner !== prefix && !owner.startsWith(`${prefix}/`)) continue;
      const head = versions[versions.length - 1];
      if (head !== undefined) out.push(head);
    }
    return out.sort((a, b) => (a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0));
  }

  /** 回溯版本 DAG：`{ref: [上游 ref, ...]}`。 */
  lineage(ref: Ref): ReadonlyMap<string, readonly Ref[]> {
    const out = new Map<string, readonly Ref[]>();
    const frontier: Ref[] = [ref];
    while (frontier.length > 0) {
      const current = frontier.pop() as Ref;
      if (out.has(current)) continue;
      let parents: readonly Ref[] = [];
      try {
        parents = this.resolve(current).provenance.derived_from;
      } catch {
        parents = [];
      }
      out.set(current, parents);
      frontier.push(...parents);
    }
    return out;
  }
}

export function refOf(version: ObjectVersion): Ref {
  return `${version.object_id}@${version.version}`;
}
