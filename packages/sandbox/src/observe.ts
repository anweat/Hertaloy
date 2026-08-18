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
export function observe(paths: ObserverPaths, exec: GitExec): Observation {
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
  return { changes, insertions, deletions };
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
