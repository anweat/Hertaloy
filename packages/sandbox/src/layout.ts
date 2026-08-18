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

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SandboxPaths {
  readonly root: string;
  /** git work-tree：唯一被观察的目录。 */
  readonly workspace: string;
  readonly meta: string;
  readonly context: string;
  readonly request: string;
  readonly emit: string;
  readonly artifacts: string;
}

export function sandboxPaths(root: string): SandboxPaths {
  const meta = join(root, ".hertaloy");
  return {
    root,
    workspace: join(root, "workspace"),
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
  walk(p.artifacts, (file) => {
    out.push({
      name: relative(p.artifacts, file).split(sep).join("/"),
      content: readFileSync(file, "utf8"),
    });
  });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function walk(dir: string, visit: (file: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, visit);
    else visit(full);
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
