/**
 * object_id ⇄ 文件路径。
 *
 * 对应 FOUNDATION_V5.md §17.3。object_id 本来就是 traceid 命名空间
 * （`job-1/coder-1/result`），所以它**本来就是路径** —— 落盘按段展开即可。
 *
 * 但"即可"是错的，有三个坑必须当场处理，否则等于把一批只在特定机器上复现的
 * bug 埋进去：
 *
 * 1. **大小写**。Windows / macOS 默认不区分大小写，而 `result` 与 `Result`
 *    在对象库里是两个对象。编码层解决不了这个（编码是可逆的，冲突是文件系统的），
 *    所以留给写入时的**碰撞检测**（见 objects.ts），这里只保证可逆。
 * 2. **保留名**。`CON` / `PRN` / `AUX` / `NUL` / `COM1` … 在 Windows 上建不出文件。
 * 3. **相对段**。`.` 与 `..` 会逃出目录 —— 这是路径穿越，不是美观问题。
 *
 * 编码规则：段内除 `A-Za-z0-9._-` 外一律百分号转义；保留名与相对段把首字符
 * 转义掉（`CON` → `%43ON`），因为 `%43` 解回来就是 `C`，规则仍然只有一条。
 */

/** 不转义的字符。故意不含 `/` —— 段间分隔由调用方处理。 */
/** `u` 标志不可省：没有它，正则按 UTF-16 码元走，emoji 的代理对会被拆成两半
 *  各自编码，解码时拼出无效 UTF-8（第一次跑测试就撞上了）。 */
const UNSAFE_CHAR = /[^A-Za-z0-9._-]/gu;

/** Windows 保留设备名（不分大小写，且带扩展名也算）。 */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function pct(ch: string): string {
  const bytes = new TextEncoder().encode(ch);
  return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

function isReserved(segment: string): boolean {
  const stem = segment.split(".")[0] ?? "";
  return RESERVED.has(stem.toLowerCase());
}

/** 一段 object_id → 一段安全文件名。可逆。 */
export function encodeSegment(segment: string): string {
  if (segment === "") return "%00";
  const escaped = segment.replace(UNSAFE_CHAR, pct);
  // 相对段与保留名：把首字符转义掉就不再是它们了，而规则仍然是同一条
  const needsHead = segment === "." || segment === ".." || isReserved(escaped);
  if (!needsHead) return escaped;
  const [first, ...rest] = [...escaped];
  return pct(first ?? "") + rest.join("");
}

export function decodeSegment(encoded: string): string {
  if (encoded === "%00") return "";
  return decodeURIComponent(encoded);
}

/**
 * object_id → 相对目录（不含版本文件名）。
 *
 * 空段不会出现：object_id 里连续 `//` 或首尾 `/` 都是非法的，这里当场拒绝，
 * 免得编码出一个能解回多个 id 的路径。
 */
export function objectDir(objectId: string): string {
  if (objectId === "") throw new Error("object_id 不能为空");
  const segments = objectId.split("/");
  if (segments.some((s) => s === "")) {
    throw new Error(`object_id 不得含空段（首尾斜杠或连续斜杠）：${objectId}`);
  }
  return segments.map(encodeSegment).join("/");
}

export function decodeObjectDir(dir: string): string {
  return dir.split("/").map(decodeSegment).join("/");
}

/** 版本文件名。版本号即文件名 —— 目录一列就能看出有几版。 */
export function versionFile(version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`版本号必须是正整数：${String(version)}`);
  }
  return `@${version}.json`;
}

export function parseVersionFile(name: string): number | null {
  const m = /^@([1-9][0-9]*)\.json$/.exec(name);
  return m === null ? null : Number(m[1]);
}

/** 完整相对路径：`<编码目录>/@<n>.json` */
export function objectPath(objectId: string, version: number): string {
  return `${objectDir(objectId)}/${versionFile(version)}`;
}
