import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DockerRunner } from "../src/docker.js";
import { createSandbox } from "../src/layout.js";

// 只模拟 Docker CLI 进程边界，真实调用 runner 的分配、参数构建、取消与资源释放。
const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  networks: new Map<string, boolean>(),
  children: [] as Array<{ emit: (event: string, ...args: unknown[]) => boolean }>,
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    execFileSync: (_command: string, args: string[]) => {
      fake.calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") {
        if (!fake.networks.has(args[2]!)) throw new Error("no such network");
        return JSON.stringify([{ Name: args[2], Internal: fake.networks.get(args[2]!) }]);
      }
      if (args[0] === "network" && args[1] === "create") fake.networks.set(args.at(-1)!, true);
      return "";
    },
    spawn: (_command: string, args: string[]) => {
      fake.calls.push([...args]);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { queueMicrotask(() => child.emit("close", null)); return true; },
      });
      fake.children.push(child);
      return child;
    },
  };
});
const roots: string[] = [];
function workRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "hertaloy-docker-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const child of fake.children.splice(0)) child.emit("close", 0);
  fake.calls.length = 0;
  fake.networks.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function run(runner: DockerRunner, id: string | undefined, network?: "none" | "internal" | "open"): Promise<string[]> {
  const paths = createSandbox(runner.allocate(id));
  const pending = runner.run({ root: paths.box, argv: ["true"], ...(network === undefined ? {} : { network }) });
  const args = fake.calls.filter((a) => a[0] === "run").at(-1)!;
  fake.children.at(-1)?.emit("close", 0);
  expect((await pending).code).toBe(0);
  return args;
}
function networkOf(args: string[]): string { return args[args.indexOf("--network") + 1]!; }

it("节点从 none 覆盖到 internal：执行前创建并检查内网", async () => {
  const runner = new DockerRunner({ workRoot: workRoot() });
  const args = await run(runner, "job/a/exec-1", "internal");
  const created = fake.calls.find((a) => a[0] === "network" && a[1] === "create");
  expect(created).toEqual(["network", "create", "--internal", networkOf(args)]);
  expect(fake.calls.indexOf(created!)).toBeLessThan(fake.calls.indexOf(args));
});

it("默认 internal 被节点覆盖到 none/open：不创建闲置网络", async () => {
  const runner = new DockerRunner({ workRoot: workRoot(), network: "internal" });
  expect(networkOf(await run(runner, "job/a/exec-1", "none"))).toBe("none");
  expect(networkOf(await run(runner, "job/b/exec-2", "open"))).toBe("bridge");
  expect(fake.calls.filter((a) => a[0] === "network")).toEqual([]);
});

it("同一根的兄弟共享内网，不同根和不同 workRoot 不混网", async () => {
  const runner = new DockerRunner({ workRoot: workRoot(), network: "internal" });
  const a = networkOf(await run(runner, "job/a/exec-1"));
  expect(networkOf(await run(runner, "job/b/exec-2"))).toBe(a);
  expect(networkOf(await run(runner, "other/a/exec-1"))).not.toBe(a);
  const other = new DockerRunner({ workRoot: workRoot(), network: "internal" });
  expect(networkOf(await run(other, "job/a/exec-1"))).not.toBe(a);
});

it("显式 networkName 仍表示主动共享，并在执行前验证", async () => {
  fake.networks.set("shared", true);
  const runner = new DockerRunner({ workRoot: workRoot(), networkName: "shared" });
  expect(networkOf(await run(runner, "job/a/exec-1", "internal"))).toBe("shared");
  expect(fake.calls[0]).toEqual(["network", "inspect", "shared"]);
});

it("未提供身份的两次分配不能被默认为同一个运行组", async () => {
  const runner = new DockerRunner({ workRoot: workRoot(), network: "internal" });
  expect(networkOf(await run(runner, undefined))).not.toBe(networkOf(await run(runner, undefined)));
});

it("同名外网在实际 run 边界被拒绝，不启动 agent", async () => {
  fake.networks.set("wrong", false);
  const runner = new DockerRunner({ workRoot: workRoot(), networkName: "wrong" });
  const paths = createSandbox(runner.allocate("job/a/exec-1"));
  const pending = runner.run({ root: paths.box, argv: ["true"], network: "internal" });
  // 旧实现会启动：及时结束模拟进程，让断言失败而不挂住测试。
  fake.children.at(-1)?.emit("close", 0);
  await expect(pending).rejects.toThrow(/内网/);
  expect(fake.children).toHaveLength(0);
});
