/**
 * 可变头的编解码。
 *
 * 三个部件（实例树 / 锁账本 / 运行时）的 `snapshot()` 装的是 `Map`、`Set`、
 * 数组与冻结的普通对象。`JSON.stringify` 会把 `Map` 变成 `{}` —— **静默**变，
 * 于是恢复出来的运行时看着正常，实则一条消息、一把锁都没有。
 *
 * 所以要一个认识 Map/Set 的编解码器。它只服务可变头：对象库走另一条路
 * （内容寻址、写一次），不经过这里。
 */

import type { Json } from "@nodeflow/contracts";

/**
 * 内部标记。用一个**不可能在用户 JSON 里自然出现**的前缀。
 *
 * 之前是 `$map` / `$set`：消息载荷是用户 JSON，完全可以合法地含有这两个键，
 * 于是重启前后同一份载荷会变成 `Map`，类型和行为都变了 —— 而且只在
 * "恰好有人用了这个字段名"时才发作。
 *
 * 光换个怪名字不够：还要**转义**载荷里恰好以该前缀开头的键，
 * 否则只是把碰撞概率变小，没有消除。
 */
const TAG = "$hertaloy$";
const MAP = `${TAG}map`;
const SET = `${TAG}set`;
const ESCAPED = `${TAG}esc`;

/** 载荷里以标记前缀开头的键 → 包一层，解码时原样还原。 */
function escapeKey(key: string): string {
  return key.startsWith(TAG) ? `${ESCAPED}${key}` : key;
}

function unescapeKey(key: string): string {
  return key.startsWith(ESCAPED) ? key.slice(ESCAPED.length) : key;
}

export function encode(value: unknown): Json {
  if (value === null) return null;
  if (value instanceof Map) {
    return { [MAP]: [...value].map(([k, v]) => [encode(k), encode(v)] as Json) };
  }
  if (value instanceof Set) {
    return { [SET]: [...value].map(encode) };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // undefined 的键在 JSON 里本就不存在；显式跳过，免得编出 `null` 把
      // "没有这个字段"改写成"这个字段是 null"（`slot` 就是这种可选字段）
      if (v === undefined) continue;
      out[escapeKey(k)] = encode(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`可变头里出现 ${String(value)}，无法 JSON 化`);
  }
  return value as Json;
}

export function decode(value: Json): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(decode));

  const obj = value as Record<string, Json>;
  const mapEntries = obj[MAP];
  if (mapEntries !== undefined) {
    const entries = mapEntries as readonly (readonly Json[])[];
    return new Map(entries.map((e) => [decode(e[0] as Json), decode(e[1] as Json)]));
  }
  const setItems = obj[SET];
  if (setItems !== undefined) {
    return new Set((setItems as readonly Json[]).map(decode));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[unescapeKey(k)] = decode(v);
  // 冻结：内核所有可变容器里装的都是冻结对象，`transact` 的浅拷贝快照
  // 正是建立在这个前提上（§10.1）。从磁盘装回来的若是可变对象，
  // 回滚就不再可靠 —— 而且失败方式是"偶尔回滚不干净"，最难查的那种。
  return Object.freeze(out);
}
