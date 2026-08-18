/**
 * 出网策略 —— 沙箱的第二堵墙。
 *
 * 对应 FOUNDATION_V5.md §14.5。文件系统隔离挡不住网络：一个只能写
 * `workspace/` 的 agent 照样能把整个仓库 POST 出去、能装任意包、能烧钱。
 * "沙箱"这个词在没有出网控制时是名不副实的。
 *
 * 三档，对应 docker 的三种网络形态（"内网 + 容器网"）：
 *
 * | 策略 | docker | 谁能通 | 用途 |
 * |---|---|---|---|
 * | `none` | `--network none` | 谁也不通 | 纯离线任务、观察 git |
 * | `internal` | `--network <名> --internal` | **只有同网的兄弟沙箱** | 多 agent 互相调用，不出公网 |
 * | `open` | `--network bridge` | 全通 | agent 要装依赖、调模型 API |
 *
 * `internal` 就是"内网"：同一次运行的几个 agent 能互相连（未来的 A2A / MCP
 * over TCP 走这里），但集体出不去。docker 的 `--internal` 是**网络级**的，
 * 不靠容器自觉。
 *
 * **明确不做**：按域名放行。docker 原生做不到，要做得起一个出网代理
 * 并强制所有流量走它。假装支持一个实际不强制的白名单，比没有更危险。
 */

export const NETWORK_POLICIES = ["none", "internal", "open"] as const;
export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

/** docker 网络名的合法字符；traceid 里的 `/` 要换掉。 */
const UNSAFE = /[^a-zA-Z0-9_.-]/g;

/**
 * 内网名按**根 traceid** 取 —— 又一次复用前缀机制（§16 不变量 X）。
 *
 * 同一次运行（同一个根）下的所有沙箱落在同一张内网上，互相能连；
 * 不同运行之间网络层就是隔开的，不靠命名约定自觉。
 */
export function networkNameFor(traceid: string): string {
  const root = traceid.split("/")[0] ?? traceid;
  return `hertaloy-${root.replace(UNSAFE, "-")}`;
}

export interface DockerCli {
  (argv: readonly string[]): string;
}

/** 幂等地建内网。`--internal` 是这堵墙本身，不是命名习惯。 */
export function ensureInternalNetwork(name: string, docker: DockerCli): void {
  try {
    docker(["network", "inspect", name]);
    return;
  } catch {
    // 不存在，往下建
  }
  try {
    docker(["network", "create", "--internal", name]);
  } catch (err) {
    // 并发下另一个进程可能刚建好 —— 再查一次，确实有就算成功
    try {
      docker(["network", "inspect", name]);
    } catch {
      throw new Error(`建内网 ${name} 失败：${(err as Error).message}`);
    }
  }
}

/** 策略 → `docker run` 的网络参数。 */
export function networkArgs(policy: NetworkPolicy, networkName: string): readonly string[] {
  switch (policy) {
    case "none":
      return ["--network", "none"];
    case "internal":
      return ["--network", networkName];
    case "open":
      return ["--network", "bridge"];
  }
}
