#!/usr/bin/env node
/**
 * 可达性体检 —— 找出「声明了但没人走」的契约。
 *
 * 这个项目被同一种漏法咬过四次：
 *
 *   K5   `AgentSpec` 停在 `{model}`，而 SandboxBackend 要 `{argv}` —— 模板注册不进去
 *   E1   `ExecutionBackend` 从没被 `RunState` 构造过 —— 落盘的 run 跑不了 agent
 *   —    `MessageContract` 没有任何注册路径 —— 端口校验实现了却拿不到 schema
 *   —    `Ref` 的字符集比 object_id 窄 —— `$exec` 存得进去却引用不到
 *
 * 共同形状：**两端各自都绿，中间那截没人走**。四次全靠人碰巧撞上。
 *
 * 这里做的是最简单也最有效的那一档：找出**只在自己文件里出现**的导出符号。
 * 它抓不到全部（#5 那种"两套规则互相不知道"抓不到），但 E1 与契约注册那两类
 * 一抓一个准 —— 那类的特征就是"没有生产侧调用点"。
 *
 * 用法：
 *   node scripts/reachability.mjs          打印报告
 *   node scripts/reachability.mjs --check  有新孤儿就退出码 1（给 CI 用）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PACKAGES = ["contracts", "kernel", "sandbox", "state", "cli"];

/**
 * 已知且**有意**的孤儿。每一条都要写清为什么，否则就是在给漏洞开后门。
 *
 * 新增一条之前先问：它真的不该有调用点吗？还是我又漏接了一根线？
 */
const ALLOWED = new Map([
  // —— 纯函数，由测试直接验；生产侧经由同文件的调用方间接使用 ——
  ["formatRef", "Ref 的格式化，给错误信息与工具用"],
  ["traceSegments", "traceid 拆段，isDescendantOf 的构件"],
  ["isRootTrace", "根判定，给调用方用"],
  ["parsePrincipal", "主体解析，给未来的 MCP 会话注入用"],
  ["isProjection", "路径投影判定，servo 类型校验的构件"],
  ["principalMatches", "PermissionTable.decide 在同文件里调"],
  ["scopeCovers", "同上"],
  ["servoVarNames", "端口变量名，模板校验的构件"],
  ["estimateTokens", "estimateValueTokens 在同文件里调"],
  ["evaluatePath", "extractPortVars 在同文件里调"],
  ["stableStringify", "contentHash 在同文件里调"],
  ["contentHash", "ObjectStore.put 在同文件里调"],
  ["sandboxPaths", "createSandbox 在同文件里调"],
  ["safeJoin", "写沙箱文件的越界防护，由 writeSandboxFile 调"],
  ["baseline", "initObserver 在同文件里调"],
  ["snapshotRef", "observe 在同文件里调"],
  ["ResourceError", "别名解析的错误类型，由 catch 分支识别"],
  ["filterEnv", "LocalRunner.run 在同文件里调"],
  ["toInnerPath", "WslRunner 在同文件里调"],
  ["toHostPath", "同上"],
  ["headPath", "readHead / writeHead 在同文件里调"],
  ["lockPath", "StateLock 在同文件里调"],
  ["isLocked", "给外部查锁状态用"],
  ["versionsOnDisk", "给外部查磁盘版本用"],
  ["encodeSegment", "objectDir 在同文件里调"],
  ["decodeSegment", "decodeObjectDir 在同文件里调"],
  ["permissionsPath", "loadPermissions 在同文件里调"],
]);

function sources() {
  const out = [];
  for (const pkg of PACKAGES) {
    const dir = join(ROOT, "packages", pkg, "src");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "index.ts") continue;
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      out.push({ pkg, file: `${pkg}/${name}`, path, text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

/**
 * **只看函数与类。**
 *
 * 第一版把 type / interface / 正则常量也算进来，280 个符号报出 123 个孤儿 ——
 * 那不是信号，是噪音：`REF_PATTERN` 只在自己文件里拼 schema、`ContractIssue`
 * 只是个形状，它们本来就不该有"调用点"。
 *
 * 而咬过我们的四次全是**能力没接线**：一个 class 没人构造、一个 function
 * 没人调用。所以只看这两种，宁可漏报也别把报告变成没人看的墙纸。
 */
const EXPORT = /^export (?:async )?(?:function|class|abstract class) ([A-Za-z_][A-Za-z0-9_]*)/gm;

function main() {
  const files = sources();
  const declared = new Map(); // 符号 → 定义它的文件

  for (const f of files) {
    for (const m of f.text.matchAll(EXPORT)) {
      // 同名的 const 与 type 是 zod 的常见写法，算一个
      if (!declared.has(m[1])) declared.set(m[1], f.file);
    }
  }

  const orphans = [];
  for (const [symbol, home] of declared) {
    if (ALLOWED.has(symbol)) continue;
    const pattern = new RegExp(`\\b${symbol}\\b`);
    const consumers = files.filter((f) => f.file !== home && pattern.test(f.text));
    if (consumers.length === 0) orphans.push({ symbol, home });
  }

  const check = process.argv.includes("--check");
  if (orphans.length === 0) {
    process.stdout.write(`可达性体检：${declared.size} 个导出符号，没有孤儿。\n`);
    return 0;
  }

  process.stdout.write(
    [
      `可达性体检：${declared.size} 个导出符号，${orphans.length} 个只在自己文件里出现。`,
      "",
      "以下符号在**生产代码**里没有任何调用点。可能是：",
      "  (a) 真的漏接了一根线 —— 这类咬过我们四次",
      "  (b) 给外部用的 API —— 那就加进 scripts/reachability.mjs 的 ALLOWED 并写明理由",
      "",
      ...orphans.map((o) => `  ${o.symbol.padEnd(28)} ${o.home}`),
      "",
    ].join("\n"),
  );
  return check ? 1 : 0;
}

process.exitCode = main();
