/**
 * `hertaloy agent` —— 平权的另一半。
 *
 * 重点验它凭什么存在：**原生懂契约**带来的三件外部 CLI 做不到的事，
 * 尤其是本地自校验重试（一次内核级 attempt 都不烧）。
 */

import { describe, expect, it } from "vitest";
import {
  type AgentIO,
  type ModelClient,
  buildPrompt,
  checkAssetName,
  extractJson,
  runAgent,
  validateResponse,
} from "../src/agent.js";

const REQUEST = {
  executionId: "exec-1",
  traceid: "job-1/coder-1",
  nodeId: "work",
  allowedEmitPorts: ["out", "err"],
  limits: { tokenBudget: 4000, wallClockSeconds: 60 },
  emitPath: "../.hertaloy/emit.json",
  artifactsDir: "../.hertaloy/artifacts",
  environment: { networkEnforced: true, isolates: true, runner: "docker" },
  resources: { manual: "workspace/.claude/skills/manual" },
};

/** 内存 IO —— 不碰磁盘，跑得快且能直接断言写了什么。 */
function memIO(files: Record<string, string> = {}): AgentIO & { files: Record<string, string>; logs: string[] } {
  const store: Record<string, string> = {
    "../.hertaloy/request.json": JSON.stringify(REQUEST),
    "../.hertaloy/context/vars.json": JSON.stringify({ task: "写个导出功能" }),
    ...files,
  };
  const logs: string[] = [];
  return {
    cwd: "/box/workspace",
    files: store,
    logs,
    read: (rel) => {
      const v = store[rel];
      if (v === undefined) throw new Error(`没有 ${rel}`);
      return v;
    },
    write: (rel, content) => {
      store[rel] = content;
    },
    exists: (rel) => store[rel] !== undefined,
    log: (line) => logs.push(line),
  };
}

function scripted(...replies: string[]): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    complete: async (p) => {
      prompts.push(p);
      return replies[i++] ?? replies[replies.length - 1] ?? "";
    },
  };
}

describe("★ 提示里必须有的关键信息", () => {
  const prompt = buildPrompt(REQUEST as never, { task: "写个导出功能" });

  it("端口白名单 —— 编不出第三条路", () => {
    expect(prompt).toContain("`out`");
    expect(prompt).toContain("`err`");
    expect(prompt).toContain("只能");
  });

  it("★ 出网被挡时明说别去查文档 —— 试到超时是纯浪费", () => {
    expect(prompt).toContain("没有外网");
  });

  it("限额说得出具体数", () => {
    expect(prompt).toContain("4000");
    expect(prompt).toContain("60");
  });

  it("资源给的是**实际落点**，不用 agent 猜", () => {
    expect(prompt).toContain("manual");
    expect(prompt).toContain("workspace/.claude/skills/manual");
  });

  it("任务变量原样给出，不经 markdown 渲染损耗", () => {
    expect(prompt).toContain("写个导出功能");
  });

  it("非隔离运行器要警告", () => {
    const p = buildPrompt(
      { ...REQUEST, environment: { networkEnforced: false, isolates: false, runner: "local" } } as never,
      {},
    );
    expect(p).toContain("不是安全边界");
  });
});

describe("★ 本地自校验：不合规就不落盘", () => {
  it("端口没声明 → 拦下，并说清能用哪些", () => {
    const r = validateResponse({ emit: { ghost: {} } }, ["out"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("ghost");
      expect(r.reason).toContain("`out`");
    }
  });

  it("产物名带 `..` → 拦下（与内核 namespacedId 同一条规则）", () => {
    expect(checkAssetName("../escape")).not.toBeNull();
    expect(checkAssetName("ok/name")).toBeNull();
    expect(checkAssetName("")).not.toBeNull();
  });

  it("结构不对 → 拦下并指出哪一项", () => {
    const r = validateResponse({ nope: 1 }, ["out"]);
    expect(r.ok).toBe(false);
  });

  it("合规就通过", () => {
    const r = validateResponse({ emit: { out: { a: 1 } }, artifacts: [] }, ["out"]);
    expect(r.ok).toBe(true);
  });
});

describe("★ 重试发生在沙箱内 —— 一次内核 attempt 都不烧", () => {
  it("第一次选了没声明的端口，第二次改对 → 整体成功", async () => {
    const io = memIO();
    const client = scripted(
      JSON.stringify({ emit: { ghost: { x: 1 } } }),
      JSON.stringify({ emit: { out: { x: 1 } } }),
    );
    expect(await runAgent(io, client)).toBe(0);

    // 第二次的提示里带着上次的错误
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("上一次的输出被拒绝");
    expect(client.prompts[1]).toContain("ghost");

    expect(JSON.parse(io.files["../.hertaloy/emit.json"] as string)).toEqual({ out: { x: 1 } });
  });

  it("回的不是 JSON 也会重来", async () => {
    const io = memIO();
    const client = scripted("我觉得应该这样做……", JSON.stringify({ emit: { out: {} } }));
    expect(await runAgent(io, client)).toBe(0);
    expect(client.prompts[1]).toContain("不是合法 JSON");
  });

  it("★ 重试用完仍不合规 → 退出码非 0，且**没有写出半份输出**", async () => {
    const io = memIO();
    const client = scripted(JSON.stringify({ emit: { ghost: {} } }));
    expect(await runAgent(io, client)).toBe(1);
    expect(io.files["../.hertaloy/emit.json"]).toBeUndefined();
  });

  it("模型调用本身失败 → 退出码非 0，不重试（那是故障不是格式问题）", async () => {
    const io = memIO();
    const client: ModelClient = {
      complete: async () => {
        throw new Error("连不上");
      },
    };
    expect(await runAgent(io, client)).toBe(1);
    expect(io.logs.join("")).toContain("连不上");
  });
});

describe("★ 资产置入", () => {
  it("产物按 request.json 给的目录写，名字原样", async () => {
    const io = memIO();
    const client = scripted(
      JSON.stringify({
        emit: { out: { ok: true } },
        artifacts: [{ name: "report", content: "正文" }, { name: "docs/api", content: "接口" }],
      }),
    );
    expect(await runAgent(io, client)).toBe(0);
    expect(io.files["../.hertaloy/artifacts/report"]).toBe("正文");
    expect(io.files["../.hertaloy/artifacts/docs/api"]).toBe("接口");
  });

  it("★ 非法产物名在写盘**之前**被拦 —— 外部 agent 只能等内核整次作废", async () => {
    const io = memIO();
    const client = scripted(
      JSON.stringify({ emit: { out: {} }, artifacts: [{ name: "../溜出去", content: "x" }] }),
    );
    expect(await runAgent(io, client)).toBe(1);
    expect(Object.keys(io.files).filter((k) => k.includes("artifacts"))).toHaveLength(0);
  });
});

describe("契约路径全从 request.json 读", () => {
  it("换了 emitPath 就写到新位置 —— 一个都不硬编码", async () => {
    const io = memIO({
      "../.hertaloy/request.json": JSON.stringify({
        ...REQUEST,
        emitPath: "../别处/out.json",
        artifactsDir: "../别处/产物",
      }),
    });
    const client = scripted(
      JSON.stringify({ emit: { out: {} }, artifacts: [{ name: "a", content: "x" }] }),
    );
    expect(await runAgent(io, client)).toBe(0);
    expect(io.files["../别处/out.json"]).toBeDefined();
    expect(io.files["../别处/产物/a"]).toBe("x");
  });

  it("读不到契约就退 2，不瞎猜", async () => {
    const io = memIO();
    delete io.files["../.hertaloy/request.json"];
    expect(await runAgent(io, scripted("{}"))).toBe(2);
  });
});

describe("从模型回答里挖 JSON", () => {
  it("裸 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("包在代码块里也认 —— 模型总会这么干", () => {
    expect(extractJson('好的：\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });

  it("不带语言标记的代码块也认", () => {
    expect(extractJson("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });
});
