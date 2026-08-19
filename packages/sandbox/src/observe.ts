/**
 * 沙箱外的 git 观察 —— 记录 agent 到底改了什么。
 *
 * 对应 FOUNDATION_V5.md §14.4。
 *
 * ```
 * git --git-dir=<沙箱外的记录仓> --work-tree=<沙箱>/workspace  diff
 * ```
 *
 * `.git` 在沙箱**外**，工作树在沙箱**内** —— agent 看不到任何 `.git`，
 * 我们照样能观察。这是 git 原生能力，不需要第三方工具。
 *
 * **比 agent 自报的 observations 强得多**：不需要它配合，也骗不了。
 * 早期稿指望 backend 回传"我调了哪些工具"，那是一份可以撒谎的自述；
 * 文件差异是事实。
 */

export interface GitExec {
  /** 在给定 cwd 下跑一条命令，返回 stdout；失败抛错。**路径一律用运行环境内的。** */
  (argv: readonly string[], innerCwd: string): string;
}

export interface ObserverPaths {
  /**
   * 记录仓（`--git-dir`），**必须在 workspace 之外**，且是
   * **运行环境内的路径**（git 在哪跑，路径就按哪算）。
   */
  readonly gitDir: string;
  /** 工作树（`--work-tree`），运行环境内的路径。 */
  readonly workTree: string;
}

export interface FileChange {
  /** git 的状态字母：A 新增 · M 修改 · D 删除 · R 重命名 …… */
  readonly status: string;
  readonly path: string;
}

export interface Observation {
  /** 快照 commit 的 sha。只有传了 snapshotId 才有。 */
  readonly snapshot?: string;
  /** 快照落在哪条隐藏 ref 上。 */
  readonly ref?: string;
  readonly changes: readonly FileChange[];
  /** 变更行数合计，供画布与预算观测用。 */
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * 所有 git 调用都经 `exec` 走 —— 它由 runner 提供。
 *
 * 这样 git 跟 agent 在**同一个环境**里跑：WSL 沙箱由 WSL 里的 git 观察，
 * 换行、权限位、大小写才对得上。宿主机的 git 隔着 UNC 看 Linux 文件，
 * 正是"落在 Linux 上避免不一致"要躲的那种绕弯。
 */
function git(paths: ObserverPaths, exec: GitExec, args: readonly string[]): string {
  return exec(
    ["git", "--git-dir", paths.gitDir, "--work-tree", paths.workTree, ...args],
    paths.workTree,
  );
}

/**
 * 建记录仓并对当前工作树打基线。
 *
 * 用 `git add -A` + `commit --allow-empty` 而不是只 init：**基线必须包含
 * agent 开工前的全部文件**，否则第一次 diff 会把项目里原有的东西也算成
 * "agent 改的"。
 */
export function initObserver(paths: ObserverPaths, exec: GitExec): void {
  exec(["mkdir", "-p", paths.gitDir], paths.workTree);
  git(paths, exec, ["init", "--quiet"]);
  // 局部身份，避免依赖宿主机的 git 全局配置
  git(paths, exec, ["config", "user.email", "observer@hertaloy.local"]);
  git(paths, exec, ["config", "user.name", "hertaloy-observer"]);
  git(paths, exec, ["config", "core.autocrlf", "false"]);
  baseline(paths, exec, "baseline");
}

export function baseline(paths: ObserverPaths, exec: GitExec, message: string): void {
  git(paths, exec, ["add", "-A"]);
  git(paths, exec, ["commit", "--quiet", "--allow-empty", "-m", message]);
}

/** 相对上一次基线，agent 改了什么。 */
/**
 * 快照落在**隐藏 ref 命名空间**下，不是分支。
 *
 * git 自己就是这么藏东西的：`refs/notes/`、`refs/stash`、`refs/replace/`、
 * gerrit 的 `refs/changes/`。**"不可见"要说准是哪一种不可见**（实测过）：
 *
 * | | 看得到吗 |
 * |---|---|
 * | `git branch` | ❌ 不列 |
 * | `git log`（默认，走 HEAD） | ❌ 不遍历 |
 * | `git clone` / 默认 `git fetch` | ❌ 不带过去（默认 refspec 只有 heads + tags） |
 * | `git log --all` | ✅ **会遍历** —— `--all` 是"`refs/` 下全部"，不是只有分支 |
 * | `git for-each-ref refs/hertaloy` | ✅ 显式问就有 |
 *
 * 所以它挡的是**误入**，不是审计：人主动去看就看得到，这正是我们要的 ——
 * 快照是证据，不是秘密。真正的"agent 看不见"由另一级保证：
 * 记录仓是**另一个仓库**且不挂进 agent 容器（见 layout.ts）。
 *
 * 快照仍然可达，所以不会被 gc 清掉；要取走用显式 refspec
 * `git fetch <src> 'refs/hertaloy/*:refs/hertaloy/*'`。
 *
 * 这是**第二级**不可见。第一级是记录仓本身就是另一个仓库、还不挂进 agent 容器
 * （见 layout.ts）。两级各管一件事：
 *
 *   隔离仓 —— agent **看不见也改不了**观察记录
 *   隐藏 ref —— 快照 fetch 进真仓库之后，**不污染分支列表、不被默认 clone 带走**
 */
export const SNAPSHOT_NAMESPACE = "refs/hertaloy/snapshots";

export function snapshotRef(id: string): string {
  return `${SNAPSHOT_NAMESPACE}/${id}`;
}

export function observe(paths: ObserverPaths, exec: GitExec, snapshotId?: string): Observation {
  git(paths, exec, ["add", "-A"]);
  const nameStatus = git(paths, exec, ["diff", "--cached", "--name-status"]).trim();
  const changes: FileChange[] = nameStatus === ""
    ? []
    : nameStatus.split(/\r?\n/).map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: (status ?? "?").trim(), path: rest.join("\t") };
      });

  let insertions = 0;
  let deletions = 0;
  for (const line of git(paths, exec, ["diff", "--cached", "--numstat"]).trim().split(/\r?\n/)) {
    if (line === "") continue;
    const [add, del] = line.split("\t");
    insertions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  const base = { changes, insertions, deletions };
  if (snapshotId === undefined) return base;

  /**
   * 用 `commit-tree` 而不是 `commit`：后者会推进 HEAD 所在的分支，
   * 于是快照又变成了一条**可见**的分支线。`commit-tree` 只造对象、不动任何 ref，
   * 然后由 `update-ref` 把唯一的指针放进隐藏命名空间 ——
   * 这样指向这个快照的东西**有且只有**那条隐藏 ref。
   */
  const tree = git(paths, exec, ["write-tree"]).trim();
  const parent = git(paths, exec, ["rev-parse", "HEAD"]).trim();
  const commit = git(paths, exec, [
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    `snapshot ${snapshotId}`,
  ]).trim();
  git(paths, exec, ["update-ref", snapshotRef(snapshotId), commit]);
  return { ...base, snapshot: commit, ref: snapshotRef(snapshotId) };
}

/** 目标环境里 git 在不在。不在就退化成"不观察"，而不是让整条执行链挂掉。 */
export function gitAvailable(exec: GitExec, innerCwd: string): boolean {
  try {
    exec(["git", "--version"], innerCwd);
    return true;
  } catch {
    return false;
  }
}
