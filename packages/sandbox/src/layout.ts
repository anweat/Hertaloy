/**
 * 沙箱契约目录 —— 内核与 agent 命令行之间的**唯一接口**。
 *
 * 对应 FOUNDATION_V5.md §14.2。像 Docker 的 entrypoint 约定：不管里面跑的是
 * `claude`、`codex` 还是 `hertaloy agent`，都按这份目录约定读输入、写输出。
 *
 * ```
 * <沙箱>/
 *   workspace/          真实项目文件 —— **git work-tree，唯一被观察的**
 *   .hertaloy/          契约目录 —— **在 work-tree 之外**
 *     context/          注入（按 profile 渲染）
 *     request.json      允许的 emit 端口、预算、traceid
 *     emit.json         → agent 写这里表达输出
 *     artifacts/        → 放这里的文件被收成版本化资产
 * ```
 *
 * `.hertaloy/` 放在 work-tree **之外**解决两件事：
 *   1. 注入的内容不会被 git 误当成"agent 改的"
 *   2. **凭据不会被 git 记录**
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export interface SandboxPaths {
  /** 交给 agent 的那一层。运行器只挂这个。 */
  readonly box: string;
  /** 外置记录仓。在 `box` 之外，所以 agent 改不到。 */
  readonly record: string;
  readonly root: string;
  /** git work-tree：唯一被观察的目录。 */
  readonly workspace: string;
  readonly meta: string;
  readonly context: string;
  readonly request: string;
  readonly emit: string;
  readonly artifacts: string;
}

/**
 * 沙箱布局。**`box/` 是唯一交给 agent 的东西。**
 *
 * ```
 * <root>/
 *   box/              ← 挂给 agent；cwd 落在 box/workspace
 *     workspace/
 *     .hertaloy/
 *   record.git/       ← **不挂**。观察面，agent 够不着
 * ```
 *
 * 记录仓此前放在沙箱根下，注释还写着"agent 看不到" —— 那只相对 `workspace/`
 * 成立，`cd ..` 就到了；docker 更是把整个根挂进容器，agent 能直接改自己的档案。
 * 一个能被观察对象改写的观察记录，不是观察记录。
 *
 * 现在挂载边界与观察边界分开：agent 容器挂 `box/`，观察容器挂 `<root>/`。
 * **注意这个保证只在 docker 上是真的** —— local 与 wsl 里 agent 能读整个宿主机，
 * 那两个 runner 的 `isolates` 已经如实报告了这件事。
 */
export function sandboxPaths(root: string): SandboxPaths {
  const box = join(root, "box");
  const meta = join(box, ".hertaloy");
  return {
    root,
    box,
    record: join(root, "record.git"),
    workspace: join(box, "workspace"),
    meta,
    context: join(meta, "context"),
    request: join(meta, "request.json"),
    emit: join(meta, "emit.json"),
    artifacts: join(meta, "artifacts"),
  };
}

export function createSandbox(root: string): SandboxPaths {
  const p = sandboxPaths(root);
  for (const dir of [p.workspace, p.context, p.artifacts]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function destroySandbox(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * 写注入文件。`files` 的键是**相对 context 的路径**，可多级（`skills/x.md`）。
 *
 * 路径校验与 `ctx.put` 同规：拒绝 `..` 与绝对路径 —— 注入是我们自己写的，
 * 但模板由 AI 生成，别让一个手滑的路径写到沙箱外面去。
 */
export function writeContext(p: SandboxPaths, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = safeJoin(p.context, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/**
 * 写沙箱内任意位置的文件，路径**相对沙箱根**。
 *
 * profile 渲染要用它 —— `CLAUDE.md` 得落在 `workspace/` 里，不在 `context/`。
 * 越界校验与 `writeContext` 同规。
 */
/**
 * 写一个 agent 可见的文件。`rel` 相对 **box**，不是相对沙箱根。
 *
 * box 才是交给 agent 的那一层（记录仓在它外面），所以 profile 渲染出的
 * `workspace/CLAUDE.md`、`.hertaloy/context/vars.json` 都以它为基准。
 * 拼 `root` 的话会写到 `<root>/workspace/…` —— 那个目录 agent 根本看不见。
 */
export function writeSandboxFile(p: SandboxPaths, rel: string, content: string): void {
  const target = safeJoin(p.box, rel);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

export function writeRequest(p: SandboxPaths, request: unknown): void {
  writeFileSync(p.request, `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

/** 读 agent 写的 emit.json。不存在或不是合法 JSON 都返回 null —— 由调用方判成 INVALID_OUTPUT。 */
export function readEmit(p: SandboxPaths): unknown | null {
  try {
    return JSON.parse(readFileSync(p.emit, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export interface CollectedArtifact {
  /** 相对 `artifacts/` 的路径，用作资产名。 */
  readonly name: string;
  readonly content: string;
}

/** 收 `artifacts/` 下的全部文件（递归），路径即资产名。 */
export function collectArtifacts(p: SandboxPaths): readonly CollectedArtifact[] {
  const out: CollectedArtifact[] = [];
  const skipped: string[] = [];
  let total = 0;

  walk(p.artifacts, (file, size) => {
    const name = relative(p.artifacts, file).split(sep).join("/");
    if (size > MAX_ARTIFACT_BYTES) {
      skipped.push(`${name}（${fmt(size)} > 单文件上限 ${fmt(MAX_ARTIFACT_BYTES)}）`);
      return;
    }
    if (total + size > MAX_ARTIFACT_TOTAL_BYTES) {
      skipped.push(`${name}（总量已达上限 ${fmt(MAX_ARTIFACT_TOTAL_BYTES)}）`);
      return;
    }
    total += size;
    out.push({ name, content: readFileSync(file, "utf8") });
  });

  if (skipped.length > 0) {
    // 超限不静默 —— 少了哪几份、为什么少，要能在产物里看到
    out.push({
      name: "$skipped",
      content: `以下产物超出上界，未收入对象库：\n${skipped.map((s) => `  ${s}`).join("\n")}\n`,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function fmt(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 产物收集的上界。沙箱里的东西不可信，无界递归 / 无界读取本身就是攻击面。 */
const MAX_ARTIFACT_DEPTH = 16;
const MAX_ARTIFACT_FILES = 1000;
/**
 * 单个产物与总量的字节上界。
 *
 * 此前只有文件数上界，**没有字节上界** —— 一个 agent 写一个 10 GB 的文件，
 * 它就会被 `readFileSync` 整个读进内存、再原样进不可变的对象库，撤不回来。
 * 文件数管不住这个：一个文件就够。
 *
 * 超限的文件**跳过并留一条记录**，不是静默丢：产物是 agent 的输出，
 * 悄悄少一份比报错更难查。
 */
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * 遍历 `artifacts/`。**不跟随符号链接。**
 *
 * 此前用 `statSync`（跟随链接）+ `readFileSync`：agent 在 artifacts 下放一条
 * 指向 `/etc/passwd`、`~/.aws/credentials` 或 `../.record.git` 的软链，
 * 内容就被原样读进对象库 —— 而对象库是不可变的，读进去就撤不回来。
 * 指向祖先目录的链接还会让递归自我循环。
 *
 * 用 `lstatSync` 判断**链接本身**，见到链接直接跳过而不是解析后放行：
 * 放行需要证明"解析后仍在 artifacts 内"，而那个证明在有并发的文件系统上
 * 有 TOCTOU 窗口（判完到读之间链接可以被换掉）。**跳过是唯一没有窗口的做法。**
 */
function walk(
  dir: string,
  visit: (file: string, size: number) => void,
  depth = 0,
  budget = { n: 0 },
): void {
  if (depth > MAX_ARTIFACT_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (budget.n >= MAX_ARTIFACT_FILES) return;
    const full = join(dir, entry);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue; // 见 上面的说明
    if (info.isDirectory()) walk(full, visit, depth + 1, budget);
    else if (info.isFile()) {
      budget.n += 1;
      visit(full, info.size);
    }
  }
}

export function safeJoin(base: string, rel: string): string {
  const target = join(base, rel);
  const inside = relative(base, target);
  if (inside.startsWith("..") || inside === "" || /^[A-Za-z]:/.test(inside)) {
    throw new Error(`路径 ${JSON.stringify(rel)} 越出沙箱目录 ${base}`);
  }
  return target;
}
