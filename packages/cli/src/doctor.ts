/**
 * `hertaloy doctor` —— 环境自检。
 *
 * 存在的理由很实际：搭沙箱的过程里踩到的坑全是**环境不一致**，
 * 而且报错离病因很远（git 装了但 WSL 里没有、发行版装了但没启动、
 * daemon 没起来）。与其让每个人重踩一遍，不如固化成一条命令。
 */

import { execFileSync } from "node:child_process";
import {
  LocalRunner,
  PROFILE_NAMES,
  WslRunner,
  dockerAvailable,
  wslAvailable,
} from "@nodeflow/sandbox";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** 不通过是否阻塞主链。false = 只是少一种 runner。 */
  readonly blocking: boolean;
}

function probe(argv: readonly string[]): string | null {
  try {
    const [cmd, ...args] = argv;
    return execFileSync(cmd as string, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function diagnose(): readonly Check[] {
  const checks: Check[] = [];

  const node = process.version;
  checks.push({
    name: "node",
    ok: Number(node.slice(1).split(".")[0]) >= 20,
    detail: `${node}（需要 ≥ 20）`,
    blocking: true,
  });

  const git = probe(["git", "--version"]);
  checks.push({
    name: "git（宿主机）",
    ok: git !== null,
    detail: git ?? "未找到 —— local runner 将无法观察改动",
    blocking: false,
  });

  checks.push({
    name: "runner: local",
    ok: true,
    detail: `可用，但 isolates=${String(new LocalRunner().isolates)} —— **不是安全边界**，只适合本机开发`,
    blocking: false,
  });

  /**
   * docker 单列一条，而且**要说清它独有的能力**：三个运行器里只有它
   * 能强制出网策略。少了它，"沙箱"这个词只覆盖文件系统那一半。
   */
  const hasDocker = dockerAvailable();
  checks.push({
    name: "runner: docker",
    ok: hasDocker,
    detail: hasDocker
      ? "可用 —— 唯一能强制出网策略的运行器（--network none/internal/open）"
      : "不可用 —— 没有它就控不住 agent 出网，local 与 wsl 都只隔离文件系统",
    blocking: false,
  });

  const hasWsl = wslAvailable("Ubuntu");
  checks.push({
    name: "runner: wsl（Ubuntu）",
    ok: hasWsl,
    detail: hasWsl
      ? `可用，isolates=${String(new WslRunner().isolates)}`
      : "不可用 —— 装一个：wsl --install Ubuntu",
    blocking: false,
  });

  if (hasWsl) {
    const wslGit = probe(["wsl", "-d", "Ubuntu", "--", "git", "--version"]);
    checks.push({
      name: "git（WSL 内）",
      ok: wslGit !== null,
      detail:
        wslGit ??
        "WSL 里没有 git —— 沙箱改动将无法观察。装：wsl -d Ubuntu -- sudo apt install -y git",
      blocking: false,
    });
  }

  const docker = probe(["docker", "info", "--format", "{{.ServerVersion}}"]);
  checks.push({
    name: "runner: docker",
    ok: docker !== null,
    detail: docker !== null ? `daemon 在跑（${docker}）` : "daemon 未运行 —— 启动 Docker Desktop",
    blocking: false,
  });

  checks.push({
    name: "profiles",
    ok: true,
    detail: PROFILE_NAMES.join("、"),
    blocking: false,
  });

  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const lines = checks.map((c) => `${c.ok ? "✓" : c.blocking ? "✗" : "○"} ${c.name}：${c.detail}`);
  const blocked = checks.filter((c) => !c.ok && c.blocking);
  lines.push("");
  lines.push(
    blocked.length === 0
      ? "主链可用。○ 表示可选能力缺失，不阻塞。"
      : `主链不可用：${blocked.map((c) => c.name).join("、")}`,
  );
  return lines.join("\n");
}
