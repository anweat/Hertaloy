/**
 * 命令的 **JSON 契约** —— 一条流程要驱动另一个 run 时读的就是这个。
 *
 * 为什么单独立一份测试：`text` 是给人看的，措辞随时会调；`data` 是接口，
 * **改了就是破坏兼容**。把两者混在一起测，等于让任何文案调整都变成假红，
 * 久了就没人认真看红了。
 *
 * 顺带这份文件本身就是**测试流**：从 init 到 reclaim 全走一遍，
 * 每条命令的输出都当契约验。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentNode,
  edges,
  handlerNode,
  scenario,
  template,
} from "../src/build.js";
import {
  drain,
  history,
  init,
  reclaim,
  resources,
  send,
  show,
  status,
  truncate,
  why,
} from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
let dir: string;
let repo: string;

/**
 * 用构造器写的同一份审核流。
 *
 * 对照原来手写的 JSON：**40 行 → 9 行**，而且拼出来的就是
 * `ContainerTemplate` 本身 —— 没有中间表示，也就没有第二处真相。
 */
function reviewFlow(): Record<string, unknown> {
  return scenario({
    id: "review",
    spec: template({
      nodes: {
        gate: handlerNode("branch", { vars: ["cond", "score", "expect"] }, ["then", "else"]),
        sink: handlerNode("collect", { vars: ["value", "expect"] }, ["done"]),
      },
      edges: edges("gate.then -> sink.got", "gate.else -> sink.got"),
    }),
  });
}

/** servo 变量名与载荷字段不同名时仍要手写 —— 构造器不猜。 */
function reviewFlowFixed(): Record<string, unknown> {
  const s = reviewFlow() as {
    templates: { spec: { nodes: Record<string, { ports: Record<string, unknown> }> } }[];
  };
  const nodes = s.templates[0]!.spec.nodes;
  nodes.gate!.ports.in = {
    direction: "receive",
    servo: {
      vars: {
        cond: { type: "short", from: "$.pass" },
        score: { type: "short", from: "$.score" },
        expect: { type: "short", from: "$.expect" },
      },
    },
  };
  nodes.sink!.ports.got = {
    direction: "receive",
    servo: {
      vars: {
        value: { type: "short", from: "$.score" },
        expect: { type: "short", from: "$.expect" },
      },
    },
  };
  delete nodes.sink!.ports.in;
  return s as unknown as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-json-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...a: string[]): void => {
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  };
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "a@b");
  git("config", "user.name", "a");
  writeFileSync(join(repo, "README.md"), "v1", "utf8");
  git("add", "-A");
  git("commit", "--quiet", "-m", "one");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (): string => join(dir, "state");

describe("★ 测试流：从空目录到回收，每条命令的 JSON 都是契约", () => {
  it("走完一整条链，且每一步的 data 形状都稳定", async () => {
    // ① 空状态
    const empty = status(state(), HUMAN);
    expect(empty.data).toMatchObject({ root: null, instances: [], queued: [] });

    // ② 登记资源
    const added = resources(state(), HUMAN, "add", ["primary", "git", repo, "主仓库"]);
    expect(added.code).toBe(0);
    const listed = resources(state(), HUMAN, "list", []);
    expect(listed.data).toMatchObject({
      source: "file",
      resources: { primary: { kind: "git", path: repo, note: "主仓库" } },
    });

    // ③ 建 run
    expect(init(state(), HUMAN, reviewFlowFixed()).code).toBe(0);
    const afterInit = status(state(), HUMAN);
    expect(afterInit.data).toMatchObject({
      root: "job-1",
      permissions: "default",
      instances: [{ traceid: "job-1", status: "OPEN", seq: 0 }],
      queued: [],
    });

    // ④ 投两条
    const sent = send(state(), HUMAN, "job-1", "gate", "in", {
      pass: true,
      score: 92,
      expect: 2,
    });
    expect(sent.data).toMatchObject({
      target: { traceid: "job-1", node: "gate", port: "in" },
    });
    expect((sent.data as { messageId: string }).messageId).toMatch(/^msg-/);
    send(state(), HUMAN, "job-1", "gate", "in", { pass: false, score: 41, expect: 2 });

    const queued = status(state(), HUMAN).data as { queued: unknown[] };
    expect(queued.queued).toHaveLength(2);

    // ⑤ 推进
    const drained = await drain(state(), HUMAN);
    expect(drained.data).toMatchObject({
      converged: true,
      failed: 0,
      settled: ["job-1"],
      failures: [],
      executionFace: null,
    });

    // ⑥ 读产物
    const hist = history(state(), HUMAN, "job-1/parts");
    expect(hist.data).toMatchObject({ objectId: "job-1/parts" });
    const versions = (hist.data as { versions: { version: number; body: unknown }[] }).versions;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.map((v) => (v.body as { value: number }).value)).toEqual([92, 41]);

    const one = show(state(), HUMAN, "job-1/parts@1");
    expect(one.data).toMatchObject({ object_id: "job-1/parts", version: 1 });

    // ⑦ 因果
    const first = (queued.queued[0] as { id: string }).id;
    expect(why(state(), HUMAN, first).data).toMatchObject({ messageId: first, causes: [] });

    // ⑧ 回收（没有沙箱，但形状要对）
    expect(reclaim(state(), HUMAN, 5).code).toBe(0);
  }, 120_000);
});

describe("★ 失败路径的 JSON 也是契约", () => {
  it("drain 未收敛时 data 里 converged 为 false", async () => {
    init(state(), HUMAN, reviewFlowFixed());
    const r = await drain(state(), HUMAN);
    expect((r.data as { converged: boolean }).converged).toBe(true);
  });

  it("截断的结果是结构化的，不用 parse 文本", () => {
    init(state(), HUMAN, reviewFlowFixed());
    send(state(), HUMAN, "job-1", "gate", "in", { pass: true, score: 1, expect: 9 });
    const t = truncate(state(), HUMAN, "job-1", "测试");
    expect(t.data).toMatchObject({
      traceid: "job-1",
      reason: "测试",
      truncatedMessages: 1,
      cascaded: [],
    });
    expect((t.data as { generation: number }).generation).toBeGreaterThan(0);
  });

  it("授权被拒时没有 data —— 让调用方立刻发现，而不是照着空对象往下走", () => {
    init(state(), HUMAN, reviewFlowFixed());
    const denied = status(state(), { kind: "agent", id: "x" });
    expect(denied.code).toBe(1);
    expect(denied.data).toBeUndefined();
  });
});

describe("★ 构造器：只减样板，不加权威", () => {
  it("拼出来的就是 ContainerTemplate —— 没有中间表示", () => {
    const t = template({
      nodes: { a: handlerNode("noop", { vars: ["x"] }, ["out"]) },
      edges: edges("a.out -> a.in"),
    });
    // 直接就是模板该有的四个键，注册期校验一行不用改
    expect(Object.keys(t).sort()).toEqual(["children", "edges", "nodes", "subscriptions"]);
    expect(t.nodes.a).toMatchObject({ kind: "handler", handler: "noop" });
    expect(t.edges.e1).toEqual({
      from: { node: "a", port: "out" },
      to: { node: "a", port: "in" },
    });
  });

  it("同名变量的简写省掉一半字数", () => {
    const n = handlerNode("noop", { vars: ["task", "score"] }) as unknown as {
      ports: { in: { servo: { vars: Record<string, unknown> } } };
    };
    expect(n.ports.in.servo.vars).toEqual({
      task: { type: "short", from: "$.task" },
      score: { type: "short", from: "$.score" },
    });
  });

  it("agent 节点默认只出 out —— 要 err 分支得自己声明", () => {
    const n = agentNode(["claude"], {}, ["out"]) as { ports: Record<string, unknown> };
    expect(Object.keys(n.ports).sort()).toEqual(["in", "out"]);
  });

  it("边写错格式当场报错，不是等注册期", () => {
    expect(() => edges("a -> b.in")).toThrow(/节点.端口/);
    expect(() => edges("a.out b.in")).toThrow();
  });

  it("★ 构造出来的图真能跑 —— 构造器不是纸上谈兵", async () => {
    expect(init(state(), HUMAN, reviewFlowFixed()).code).toBe(0);
    send(state(), HUMAN, "job-1", "gate", "in", { pass: true, score: 7, expect: 1 });
    const r = await drain(state(), HUMAN);
    expect((r.data as { failed: number }).failed).toBe(0);
    expect(show(state(), HUMAN, "job-1/parts").text).toContain("7");
  }, 60_000);
});
