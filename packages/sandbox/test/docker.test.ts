/**
 * S5：docker 运行器与出网策略（FOUNDATION_V5.md §14.5）。
 *
 * 纯逻辑（网络名、参数拼装、路径反查）永远跑；真起容器的部分在没有
 * docker 守护进程时跳过。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerRunner, dockerAvailable } from "../src/docker.js";
import { LocalRunner } from "../src/runner.js";
import { WslRunner } from "../src/wsl.js";
import { ensureInternalNetwork, networkArgs, networkNameFor } from "../src/network.js";
import { createSandbox } from "../src/layout.js";

const HAS_DOCKER = dockerAvailable();

describe("出网策略（纯逻辑）", () => {
  it("三档各自映射到 docker 的网络形态", () => {
    expect(networkArgs("none", "n")).toEqual(["--network", "none"]);
    expect(networkArgs("internal", "n")).toEqual(["--network", "n"]);
    expect(networkArgs("open", "n")).toEqual(["--network", "bridge"]);
  });

  it("内网名按**根** traceid 取 —— 同一次运行的兄弟同网，跨运行天然隔开", () => {
    expect(networkNameFor("job-1/coder-1/sub")).toBe("hertaloy-job-1");
    expect(networkNameFor("job-1/reviewer")).toBe("hertaloy-job-1");
    expect(networkNameFor("job-2/coder-1")).toBe("hertaloy-job-2");
  });

  it("docker 网络名不合法的字符被换掉", () => {
    expect(networkNameFor("run:a b/c")).toBe("hertaloy-run-a-b");
  });

  it("建内网带 --internal —— 墙在网络层，不靠容器自觉", () => {
    const calls: string[][] = [];
    ensureInternalNetwork("net-x", (argv) => {
      calls.push([...argv]);
      if (argv[1] === "inspect" && calls.length === 1) throw new Error("no such network");
      return "";
    });
    expect(calls[1]).toEqual(["network", "create", "--internal", "net-x"]);
  });

  it("网络已存在就不重复建（幂等）", () => {
    const calls: string[][] = [];
    ensureInternalNetwork("net-x", (argv) => {
      calls.push([...argv]);
      return "";
    });
    expect(calls).toEqual([["network", "inspect", "net-x"]]);
  });

  it("并发下别人抢先建好 —— create 失败但 inspect 成功，算成功", () => {
    let creates = 0;
    expect(() =>
      ensureInternalNetwork("net-x", (argv) => {
        if (argv[1] === "create") {
          creates += 1;
          throw new Error("already exists");
        }
        if (creates === 0) throw new Error("no such network");
        return "";
      }),
    ).not.toThrow();
  });
});

describe("★ 谁能强制出网策略 —— 这是必填字段，不是默认值", () => {
  it("只有 docker 报 true；local 和 wsl 都不能假装", () => {
    expect(new LocalRunner().enforcesNetwork).toBe(false);
    expect(new WslRunner().enforcesNetwork).toBe(false);
    expect(new DockerRunner().enforcesNetwork).toBe(true);
  });

  it("wsl 隔离文件系统但不控出网 —— 两堵墙要分开表达", () => {
    const wsl = new WslRunner();
    expect(wsl.isolates).toBe(true);
    expect(wsl.enforcesNetwork).toBe(false);
  });

  it("默认策略是 none —— 出网要显式要，不是默认给", () => {
    expect(new DockerRunner().network).toBe("none");
  });
});

describe.skipIf(!HAS_DOCKER)("真起容器", () => {
  it("挂载生效：宿主机写的文件容器里读得到，路径经 toInner 翻译", async () => {
    const runner = new DockerRunner();
    const root = runner.allocate();
    try {
      const paths = createSandbox(root);
      writeFileSync(join(paths.workspace, "hello.txt"), "from-host", "utf8");

      const inner = runner.toInner(paths.workspace);
      expect(inner.startsWith("/sandbox/")).toBe(true);

      const out = await runner.run({ argv: ["cat", "hello.txt"], root });
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe("from-host");
    } finally {
      runner.release(root);
    }
  }, 120_000);

  it("容器写的文件回到宿主机 —— git 观察靠的就是这条", async () => {
    const runner = new DockerRunner();
    const root = runner.allocate();
    try {
      const paths = createSandbox(root);
      const out = await runner.run({
        argv: ["sh", "-c", "echo from-container > made.txt"],
        root,
      });
      expect(out.code).toBe(0);
      const made = join(paths.workspace, "made.txt");
      expect(existsSync(made)).toBe(true);
      expect(readFileSync(made, "utf8").trim()).toBe("from-container");
    } finally {
      runner.release(root);
    }
  }, 120_000);

  it("★ network=none：出网真的被挡住（不是靠 agent 自觉）", async () => {
    const runner = new DockerRunner({ network: "none" });
    const root = runner.allocate();
    try {
      createSandbox(root);
      const out = await runner.run({
        argv: ["sh", "-c", "wget -q -T 5 -O - http://example.com; echo rc=$?"],
        root,
        timeoutSeconds: 60,
      });
      expect(out.stdout).toContain("rc=");
      expect(out.stdout).not.toContain("rc=0");
    } finally {
      runner.release(root);
    }
  }, 120_000);

  it("超时杀的是**容器**，不只是本地 docker 客户端", async () => {
    const runner = new DockerRunner();
    const root = runner.allocate();
    try {
      createSandbox(root);
      const out = await runner.run({ argv: ["sleep", "600"], root, timeoutSeconds: 3 });
      expect(out.timedOut).toBe(true);
      expect(out.wallClockSeconds).toBeLessThan(30);
      // 容器真死了 —— 名字不该还在运行列表里。
      // 只断言 timedOut 是不够的：那只证明本地 docker 客户端退了。
      const running = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
        encoding: "utf8",
      });
      expect(running).not.toContain(basename(root));
    } finally {
      runner.release(root);
    }
  }, 120_000);

  it("exec 在同一个挂载上跑 git —— 观察容器一律无网", () => {
    const runner = new DockerRunner();
    const root = runner.allocate();
    try {
      const paths = createSandbox(root);
      const cwd = runner.toInner(paths.workspace);
      expect(runner.exec(["git", "--version"], cwd)).toContain("git version");
    } finally {
      runner.release(root);
    }
  }, 120_000);
});

describe("路径反查", () => {
  it("没分配过的路径直接报错，不静默返回原值", () => {
    const runner = new DockerRunner();
    expect(() => runner.toInner("C:/nowhere")).toThrow(/不在任何已分配的沙箱里/);
  });

  it("释放后就查不到了 —— 不留悬挂映射", () => {
    const runner = new DockerRunner();
    const root = runner.allocate();
    expect(() => runner.toInner(root)).not.toThrow();
    runner.release(root);
    expect(() => runner.toInner(root)).toThrow(/不在任何已分配的沙箱里/);
  });

  it("不是本运行器分配的沙箱，run 直接拒绝", async () => {
    const runner = new DockerRunner();
    await expect(runner.run({ argv: ["true"], root: "C:/elsewhere" })).rejects.toThrow(
      /不是本运行器分配的/,
    );
  });
});
