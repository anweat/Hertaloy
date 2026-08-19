/**
 * 资源别名 —— **agent 拿到的是名字，不是位置**。
 *
 * 模板里写 `workspace: { source: "primary" }`，agent 在沙箱里看到的是
 * `workspace/` 已经有内容；它拿不到 `primary` 到底是哪个仓库、在宿主机哪个盘。
 * 与密钥同构：**模板放取值方式，不放值**（§17.7）。
 *
 * 为什么不复用 `Tunnel`：隧道解析到**端点**（traceid + node + port），纯内部，
 * 内核自己就能算；别名解析到**外部资源**（宿主机路径），跨信任边界，
 * 要 backend 配置。合并成一个命名空间的后果是一条路由标签和一份资源授权
 * 长得一样 —— 那正是前几次归约在删的"看起来统一、实际是两回事"。
 * 所以：**同一条纪律（只能选已声明的名字），两个命名空间。**
 *
 * 物化方式选了「预先复制」而不是「只读挂载」：沙箱本来就是一次性的，
 * 产出靠外部 fetch；多一个挂载面就多一个 agent 能翻的目录，
 * 而 `:ro` 也挡不住它读整个仓库历史（别的分支、别人的提交）。
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** git 仓库。物化 = clone 到工作树，agent 在里面干活。 */
export interface GitSource {
  readonly kind: "git";
  /** 宿主机路径。**agent 永远看不到这个值。** */
  readonly path: string;
  /** 不指定 base 时用哪个 ref。默认 `HEAD`。 */
  readonly defaultBase?: string;
}

/** 普通目录。物化 = 拷进 `.hertaloy/resources/<别名>/`，参考资料用。 */
export interface DirSource {
  readonly kind: "dir";
  readonly path: string;
}

export type ResourceSource = GitSource | DirSource;

/** 别名注册表。由 backend 配置给出，不进模板、不进对象库。 */
export type ResourceRegistry = Readonly<Record<string, ResourceSource>>;

export class ResourceError extends Error {}

function resolve(registry: ResourceRegistry, name: string): ResourceSource {
  const found = registry[name];
  if (found === undefined) {
    const known = Object.keys(registry);
    throw new ResourceError(
      `未知资源 \`${name}\`。已配置：${known.length > 0 ? known.join("、") : "（空）"}。` +
        "资源名由 backend 配置给出，模板只能引用已配置的名字。",
    );
  }
  return found;
}

function git(argv: readonly string[], cwd?: string): string {
  return execFileSync("git", [...argv], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface ProvisionedWorkspace {
  readonly source: string;
  readonly base: string;
  /** 实际落在哪个 commit —— 进执行观测，让"从哪开始的"可复查。 */
  readonly commit: string;
}

/**
 * 把命名仓库物化成工作树。
 *
 * `--no-hardlinks`：硬链接会让沙箱里的对象库与源仓库共享 inode，
 * 沙箱里一次 `git gc` 就可能动到源仓库的对象。一次性沙箱不值得冒这个险。
 */
export function provisionWorkspace(
  registry: ResourceRegistry,
  request: { readonly source: string; readonly base?: string | undefined },
  targetDir: string,
): ProvisionedWorkspace {
  const source = resolve(registry, request.source);
  if (source.kind !== "git") {
    throw new ResourceError(`资源 \`${request.source}\` 是 ${source.kind}，工作区需要 git`);
  }
  const base = request.base ?? source.defaultBase ?? "HEAD";
  git(["clone", "--no-hardlinks", "--quiet", "--no-checkout", source.path, targetDir]);
  git(["checkout", "--quiet", base], targetDir);
  return { source: request.source, base, commit: git(["rev-parse", "HEAD"], targetDir).trim() };
}

/**
 * 把命名目录拷进 `.hertaloy/resources/<别名>/`。
 *
 * 放在 `.hertaloy/` 下而不是 `workspace/` 里：工作树是**被观察**的，
 * 参考资料混进去会被算成 agent 的改动。
 */
export function provisionResources(
  registry: ResourceRegistry,
  aliases: Readonly<Record<string, string>>,
  resourcesDir: string,
): readonly string[] {
  const done: string[] = [];
  for (const [alias, name] of Object.entries(aliases)) {
    const source = resolve(registry, name);
    const target = join(resourcesDir, alias);
    mkdirSync(target, { recursive: true });
    if (source.kind === "dir") {
      cpSync(source.path, target, { recursive: true, dereference: false });
    } else {
      // git 源当参考资料：**只要内容不要历史**。浅克隆之后把 .git 删掉，
      // 免得 agent 从参考资料里翻出别的分支和别人的提交。
      git(["clone", "--no-hardlinks", "--quiet", "--depth", "1", source.path, target]);
      rmSync(join(target, ".git"), { recursive: true, force: true });
    }
    done.push(alias);
  }
  return done;
}
