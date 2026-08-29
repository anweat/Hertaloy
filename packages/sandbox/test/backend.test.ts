/**
 * S4：沙箱 backend 端到端（FOUNDATION_V5.md §14）。
 *
 * 用 node 脚本当"假 agent"打通契约 —— `claude` / `codex` 接上去只是换 argv。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRequest } from "@nodeflow/contracts";
import { SandboxBackend, redact, type SandboxDiagnostics } from "../src/backend.js";

let workRoot: string;
let agentDir: string;
let backend: SandboxBackend;

/** 造一个假 agent。它按契约读 request.json、写 emit.json。 */
function fakeAgent(body: string): string {
  const file = join(agentDir, `agent-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, "utf8");
  return file;
}

function request(
  argv: readonly string[],
  spec: Record<string, unknown> = {},
  over: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    executionId: "exec-1",
    traceid: "job-1/coder-1",
    nodeId: "work",
    agentSpec: { argv: [...argv], ...spec } as never,
    vars: { task: "写个导出功能" },
    outputContract: { allowedEmitPorts: ["out", "err"] },
    limits: {},
    ...over,
  };
}

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "hertaloy-wr-"));
  agentDir = mkdtempSync(join(tmpdir(), "hertaloy-ag-"));
  backend = new SandboxBackend({ workRoot });
});

afterEach(() => undefined);

describe("★ 主链：注入 → 跑命令行 → 读 emit → 观察 → 收产物", () => {
  it("假 agent 按契约干活，全链走通", async () => {
    const agent = fakeAgent(`
      import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
      // 契约：request.json 与 vars.json 在 ../.hertaloy 下（cwd 是 workspace）
      const req = JSON.parse(readFileSync("../.hertaloy/request.json", "utf8"));
      const vars = JSON.parse(readFileSync("../.hertaloy/context/vars.json", "utf8"));

      // 干活：改工作区
      writeFileSync("export.ts", "export function run(){}");

      // 产物
      mkdirSync("../.hertaloy/artifacts", { recursive: true });
      writeFileSync("../.hertaloy/artifacts/plan.md", "计划:" + vars.task);

      // 输出：只能用白名单里的端口
      writeFileSync("../.hertaloy/emit.json", JSON.stringify({
        out: { done: true, port: req.allowedEmitPorts[0] }
      }));
    `);

    const result = await backend.run(request(["node", agent]));

    expect(result.termination).toBe("DONE");
    expect(result.emissions).toEqual({ out: { done: true, port: "out" } });
    expect(result.artifacts?.[0]?.object_id).toBe("plan");
    expect(result.artifacts?.[0]?.body).toEqual({ text: "计划:写个导出功能" });

    // ★ git 观察到了工作区的改动，agent 全程不知道
    const diag = result.diagnostics as never as SandboxDiagnostics;
    expect(diag.observation?.changes.map((c) => c.path)).toEqual(["export.ts"]);
    expect(diag.observation?.insertions).toBeGreaterThan(0);
    expect(diag.isolates).toBe(false); // local 不是安全边界
  }, 30_000);

  it("变量经 vars.json 注入 —— 批 P 的 profile 渲染建在这上面", async () => {
    const agent = fakeAgent(`
      import { readFileSync, writeFileSync } from "node:fs";
      const vars = JSON.parse(readFileSync("../.hertaloy/context/vars.json", "utf8"));
      writeFileSync("../.hertaloy/emit.json", JSON.stringify({ out: { echoed: vars.task } }));
    `);
    const result = await backend.run(request(["node", agent]));
    expect(result.emissions).toEqual({ out: { echoed: "写个导出功能" } });
  }, 30_000);
});

describe("★ 退出码 → 终止原因（§14.6，判据是「重试会不会有不同结果」）", () => {
  it("退出 0 但没写 emit.json → INVALID_OUTPUT（换次采样可能就对）", async () => {
    const agent = fakeAgent(`process.exit(0);`);
    const r = await backend.run(request(["node", agent]));
    expect(r.termination).toBe("INVALID_OUTPUT");
  }, 30_000);

  it("emit.json 不是对象 → INVALID_OUTPUT", async () => {
    const agent = fakeAgent(`
      import { writeFileSync } from "node:fs";
      writeFileSync("../.hertaloy/emit.json", JSON.stringify(["数组不行"]));
    `);
    expect((await backend.run(request(["node", agent]))).termination).toBe("INVALID_OUTPUT");
  }, 30_000);

  it("退出码非 0 → FAILED（真故障，可重试）", async () => {
    const agent = fakeAgent(`process.exit(7);`);
    const r = await backend.run(request(["node", agent]));
    expect(r.termination).toBe("FAILED");
    expect((r.diagnostics as never as SandboxDiagnostics).exitCode).toBe(7);
  }, 30_000);

  it("超时被杀 → BUDGET（是限额意图，不是故障，不重试）", async () => {
    const agent = fakeAgent(`setTimeout(() => process.exit(0), 60_000);`);
    const r = await backend.run(
      request(["node", agent], {}, { limits: { wallClockSeconds: 0.5 } }),
    );
    expect(r.termination).toBe("BUDGET");
  }, 30_000);

  it("取消 → CANCELLED（是意图，不重试）", async () => {
    const agent = fakeAgent(`setTimeout(() => process.exit(0), 60_000);`);
    const p = backend.run(request(["node", agent]));
    setTimeout(() => void backend.cancel("exec-1"), 300);
    expect((await p).termination).toBe("CANCELLED");
  }, 30_000);

  it("agentSpec 不是合法沙箱规格 → INVALID_OUTPUT，错误说清哪不对", async () => {
    const r = await backend.run(request([], {}, { agentSpec: { nope: 1 } as never }));
    expect(r.termination).toBe("INVALID_OUTPUT");
    expect((r.diagnostics as never as SandboxDiagnostics).stderrTail).toMatch(/不是合法的沙箱规格/);
  }, 30_000);
});

describe("凭据与环境", () => {
  it("env 注入进沙箱，且不落进 git（.hertaloy 在工作树外）", async () => {
    const agent = fakeAgent(`
      import { writeFileSync } from "node:fs";
      writeFileSync("../.hertaloy/emit.json", JSON.stringify({ out: { key: process.env.FAKE_KEY } }));
    `);
    const r = await backend.run(
      request(["node", agent], { env: { FAKE_KEY: "sk-假的" } }),
    );
    expect(r.emissions).toEqual({ out: { key: "sk-假的" } });
    const diag = r.diagnostics as never as SandboxDiagnostics;
    expect(diag.observation?.changes).toEqual([]); // 工作区没动，凭据没留痕
  }, 30_000);
});


describe("★ 告诉 agent 的话必须是对的", () => {
  /**
   * 一个**只照着 request.json 做**的 agent：不猜路径，用契约里给的。
   * 契约写错的话它必然失败 —— 这正是我们要抓的。
   */
  const literalAgent = [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'const r = JSON.parse(readFileSync("../.hertaloy/request.json", "utf8"));',
    "mkdirSync(r.artifactsDir, { recursive: true });",
    'writeFileSync(r.artifactsDir + "/note.txt", "产物");',
    "writeFileSync(r.emitPath, JSON.stringify({ [r.allowedEmitPorts[0]]: { ok: true } }));",
  ].join("\n");

  it("agent 逐字照 request.json 的路径写，内核就读得到", async () => {
    const agent = fakeAgent(literalAgent);
    const result = await backend.run(request(["node", agent]));
    expect(result.termination).toBe("DONE");
    expect(result.emissions).toEqual({ out: { ok: true } });
    expect(result.artifacts?.map((a) => a.object_id)).toContain("note");
  }, 60_000);
});
describe("★ profile 渲染真的发生了", () => {
  /** 读一个 workspace 下的文件，把内容原样 emit 出来。 */
  function reader(expr: string): string {
    return [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `writeFileSync("../.hertaloy/emit.json", JSON.stringify({ out: ${expr} }));`,
      "void existsSync; void readFileSync;",
    ].join("\n");
  }

  it("claude-code 拿到 CLAUDE.md", async () => {
    const agent = fakeAgent(reader('{ md: readFileSync("CLAUDE.md", "utf8") }'));
    const result = await backend.run(request(["node", agent], { profile: "claude-code" }));
    expect(result.termination).toBe("DONE");
    expect(String((result.emissions.out as { md: string }).md)).toContain("本次任务上下文");
  }, 60_000);

  it("codex 拿到 AGENTS.md，claude 的那份不在", async () => {
    const agent = fakeAgent(
      reader('{ a: existsSync("AGENTS.md"), c: existsSync("CLAUDE.md") }'),
    );
    const result = await backend.run(request(["node", agent], { profile: "codex" }));
    expect(result.emissions.out).toEqual({ a: true, c: false });
  }, 60_000);

  it("★ 渲染出的文件不算 agent 的改动 —— 它在打基线之前", async () => {
    const agent = fakeAgent(reader("{}"));
    const result = await backend.run(request(["node", agent], { profile: "claude-code" }));
    const d = result.diagnostics as never as SandboxDiagnostics;
    expect(d.observation?.changes).toEqual([]);
  }, 60_000);

  it("★ 环境交代里有关键信息：限额、可用资源、被观察", async () => {
    const agent = fakeAgent(reader('{ md: readFileSync("CLAUDE.md", "utf8") }'));
    const result = await backend.run(
      request(["node", agent], { profile: "claude-code" }, { limits: { tokenBudget: 5000 } }),
    );
    const md = String((result.emissions.out as { md: string }).md);
    expect(md).toContain("# 环境");
    expect(md).toContain("token 预算 5000");
    expect(md).toContain("被沙箱外的 git 记录");
    expect(md).toContain("输出契约");
  }, 60_000);
});

describe("★ 平权自证：hertaloy agent 与外部 CLI 走同一条路", () => {
  /**
   * 用**真的 `hertaloy agent --dry-run`** 跑一次。
   *
   * 它不走任何特殊通道：同一个沙箱、同一份 request.json、同一条 argv。
   * 这条测试的意义就是这个 —— 如果我们自己的 agent 需要特殊待遇，
   * "agent 就是命令行"那条归约就是假的。
   */
  const CLI = join(process.cwd(), "..", "cli", "src", "main.ts");
  /**
   * 用 `node <tsx/cli.mjs>` 而不是 `npx tsx`。
   *
   * 运行器 `shell: false` 跑 argv，而 Windows 上 `npx` 是 `.cmd`，
   * 不经 shell 解析不到 —— `spawn npx ENOENT`。这不是运行器的毛病：
   * **不经 shell 正是我们要的**（argv 原样执行，不被 shell 二次解释）。
   */
  const TSX = createRequire(import.meta.url).resolve("tsx/cli");

  it("跑得起来，且按契约写出 emit", async () => {
    const result = await backend.run(
      request([process.execPath, TSX, CLI, "agent", "--dry-run"], { profile: "hertaloy-agent" }),
    );
    expect(result.termination).toBe("DONE");
    expect(result.emissions).toEqual({ out: { dryRun: true } });
  }, 180_000);

  it("★ 它读的是 request.json —— 换了端口白名单，输出跟着变", async () => {
    const result = await backend.run(
      request([process.execPath, TSX, CLI, "agent", "--dry-run"], { profile: "hertaloy-agent" }, {
        outputContract: { allowedEmitPorts: ["报告"] },
      }),
    );
    expect(result.termination).toBe("DONE");
    expect(Object.keys(result.emissions)).toEqual(["报告"]);
  }, 180_000);

  it("没有密钥又没加 --dry-run → 退 2 并说清缺什么", async () => {
    const result = await backend.run(
      request([process.execPath, TSX, CLI, "agent"], { profile: "hertaloy-agent" }),
    );
    expect(result.termination).toBe("FAILED");
    const d = result.diagnostics as never as SandboxDiagnostics;
    expect(d.stderrTail).toContain("HERTALOY_BASE_URL");
  }, 180_000);
});

describe("★ 脱敏：密钥不进不可变的对象库", () => {
  it("注入的凭据即使被 agent 打印出来，也不会留在 diagnostics 里", async () => {
    const agent = fakeAgent(
      [
        'import { writeFileSync } from "node:fs";',
        "console.log(`拿到 key：${process.env.FAKE_KEY}`);",
        'writeFileSync("../.hertaloy/emit.json", "{}");',
      ].join("\n"),
    );
    const r = await backend.run(
      request(["node", agent], { env: { FAKE_KEY: "sk-super-secret-value-1234" } }),
    );
    const d = r.diagnostics as never as SandboxDiagnostics;
    expect(d.stdoutTail).not.toContain("sk-super-secret-value-1234");
    expect(d.stdoutTail).toContain("已遮蔽");
  }, 60_000);

  it("纯函数：精确遮蔽已注入的值", () => {
    expect(redact("前 abcdefghij 后", { K: "abcdefghij" })).toBe("前 «已遮蔽» 后");
  });

  it("太短的值不遮 —— 遮了反而毁可读性，而且多半不是凭据", () => {
    expect(redact("端口 8080", { PORT: "8080" })).toBe("端口 8080");
  });

  it("常见格式的模式匹配是**尽力而为**，不是保证", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrst", {})).toContain("已遮蔽");
    expect(redact("token=sk-abcdefghijklmnopqrst", {})).toContain("已遮蔽");
    // 说清它挡不住什么：命名千奇百怪的密钥漏得掉
    expect(redact("MY_PASS=hunter2-plain-text", {})).toContain("hunter2");
  });
});

/**
 * 节点声明的能力优先于 backend 缺省。
 *
 * 判据不是"schema 里有这个字段"，是**它真的走到了 runner 与 diagnostics**。
 * 声明加了却没人读，正是这个项目被咬过七次的那个形状。
 */
describe("★ 逐节点能力：声明在模板上，backend 只是执行它", () => {
  it("节点声明的超时盖过 request.limits", async () => {
    const seen: { timeoutSeconds: number | undefined; network: string | undefined }[] = [];
    const spy = {
      kind: "spy", isolates: false, enforcesNetwork: false,
      allocate: () => mkdtempSync(join(workRoot, "spy-")),
      release: () => {},
      toInner: (p: string) => p,
      toHost: (p: string) => p,
      run: async (s: { timeoutSeconds?: number; network?: string }) => {
        seen.push({ timeoutSeconds: s.timeoutSeconds, network: s.network });
        return { code: 0, stdout: "", stderr: "", wallClockSeconds: 0, timedOut: false };
      },
    };
    const b = new SandboxBackend({ workRoot, runner: spy as never });
    await b.run(
      request(["true"], { capabilities: { wallClockSeconds: 42 } }, { limits: { wallClockSeconds: 999 } }),
    );
    expect(seen[0]?.timeoutSeconds).toBe(42);
  });

  it("★ 节点声明的网络策略传到了 runner —— 此前整个 run 只有一条", async () => {
    const seen: string[] = [];
    const spy = {
      kind: "spy", isolates: false, enforcesNetwork: false,
      allocate: () => mkdtempSync(join(workRoot, "spy-")),
      release: () => {},
      toInner: (p: string) => p,
      toHost: (p: string) => p,
      run: async (s: { network?: string }) => {
        seen.push(s.network ?? "（未指定）");
        return { code: 0, stdout: "", stderr: "", wallClockSeconds: 0, timedOut: false };
      },
    };
    const b = new SandboxBackend({ workRoot, runner: spy as never });
    await b.run(request(["true"], { capabilities: { network: "none" } }));
    await b.run(request(["true"], {}, { executionId: "exec-2" }));
    expect(seen).toEqual(["none", "（未指定）"]);
  });

  it("生效的能力写进 diagnostics —— 事后要能回答「它当时能上网吗」", async () => {
    const r = await backend.run(request(["true"], { capabilities: { network: "none" } }));
    const d = r.diagnostics as unknown as SandboxDiagnostics;
    expect(d.capabilities?.network).toBe("none");
  });
});

/**
 * 端到端：工具集从装到合成。
 *
 * 判据不是"某个函数返回对了"，是**agent 跑一条用工具的命令，
 * 结果真的变成 ExecutionResult 的 emissions**。装了没人调、
 * 或调了合成不出来，都是这个项目最熟悉的漏接。
 */
describe("★ 沙箱工具集：从装到合成", () => {
  it("★ agent 用工具发的，真的成了 emissions", async () => {
    const r = await backend.run(
      request([
        process.execPath,
        "../.hertaloy/bin/hertaloy.mjs",
        "emit",
        "out",
        '{"from":"工具"}',
      ]),
    );
    expect(r.termination).toBe("DONE");
    expect(r.emissions).toEqual({ out: { from: "工具" } });
  });

  it("整条调用日志进了 diagnostics —— 事后能看它试过什么", async () => {
    const r = await backend.run(
      request([process.execPath, "../.hertaloy/bin/hertaloy.mjs", "progress", "2", "5", "跑测试"]),
    );
    const d = r.diagnostics as unknown as SandboxDiagnostics;
    expect(d.journal?.map((e) => e.op)).toEqual(["progress"]);
    expect(d.progress).toEqual({ done: 2, total: 5, note: "跑测试" });
  });

  it("★ 老路径不删 —— 没用工具时 emit.json 照旧生效", async () => {
    // 镜像里没有 node 时它是唯一能走的那条；工具是增量不是替换
    const r = await backend.run(
      request(["node", "-e", `require("fs").writeFileSync("../.hertaloy/emit.json", '{"out":{"old":1}}')`]),
    );
    expect(r.emissions).toEqual({ out: { old: 1 } });
  });

  it("★ agent 照着契约里那串去调，必须真的成功", async () => {
    /**
     * 这是 `emitPath` 那条教训的一般化：**告诉 agent 的话本身错了，
     * 比没说更糟** —— 它会照做，然后失败得莫名其妙。
     * 所以不验"字段长什么样"，验"照着做能不能成"。
     */
    const script =
      "const {execFileSync}=require('child_process');" +
      "const r=JSON.parse(require('fs').readFileSync('../.hertaloy/request.json','utf8'));" +
      "const [bin,...rest]=r.tools.command.split(' ');" +
      "execFileSync(bin,[...rest,'emit','out',JSON.stringify({照着做:true})],{stdio:'inherit'});";
    const r = await backend.run(request([process.execPath, "-e", script]));
    expect(r.termination).toBe("DONE");
    expect(r.emissions).toEqual({ out: { 照着做: true } });
  });
});
