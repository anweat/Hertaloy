/**
 * 只读观测服务。
 *
 * 这里钉的重点不是"能返回 JSON"，是**授权那条线没有被 HTTP 这一层绕过去**：
 * 主体在启动时定死，请求不能自称身份（§11：Principal 由可信边界注入）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import { listen, type ServeHandle } from "../src/serve.js";
import { drain, send } from "../src/state-commands.js";

const HUMAN = { kind: "human", id: "local" } as const;
const AGENT = { kind: "agent", id: "coder-1" } as const;

const TEMPLATE = {
  nodes: {
    gate: {
      kind: "handler",
      handler: "collect",
      ports: {
        in: {
          direction: "receive",
          servo: {
            vars: {
              value: { type: "short", from: "$.value" },
              expect: { type: "short", from: "$.expect" },
            },
          },
        },
        done: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
};

let dir: string;
let h: ServeHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-serve-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"), "job-1");
    s.persist();
  } finally {
    s.close();
  }
  h = await listen({ dir, actor: HUMAN, intervalMs: 30 });
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

const url = (p: string): string => `http://127.0.0.1:${h.port()}${p}`;
const withToken = (p: string): Promise<Response> =>
  fetch(url(p), { headers: { "x-hertaloy-token": h.token } });

/**
 * ★ token 挡住的是什么、挡不住什么（审核 R05）。
 *
 * 原来注释写着"挡住同机的其他进程" —— 那句话是假的：首页把 token 内嵌进去
 * 交给浏览器，本机任何进程 GET `/` 就能拿到它。这一组把**真实**边界钉住，
 * 免得下次有人照着那句假话去接写操作。
 */
describe("★ token 的真实边界", () => {
  it("★ 首页不需要 token，而且它就把 token 交出去 —— 同机 = 可信是明说的前提", async () => {
    const withPage = await listen({
      dir,
      actor: HUMAN,
      intervalMs: 30,
      page: "<html>__HERTALOY_TOKEN__</html>",
    });
    try {
      const res = await fetch(`http://127.0.0.1:${withPage.port()}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // 谁都能取到它 —— 这就是"同机可信"这个前提的具体形状
      expect(html).toContain(withPage.token);

      // 取到之后照常读得了数据：token 不是身份验证
      const scene = await fetch(`http://127.0.0.1:${withPage.port()}/scene`, {
        headers: { "x-hertaloy-token": withPage.token },
      });
      expect(scene.status).toBe(200);
    } finally {
      await withPage.close();
    }
  });
});

describe("★ token：挡住不知道要先去取它的调用方", () => {
  it("不带 token → 401", async () => {
    const r = await fetch(url("/scene"));
    expect(r.status).toBe(401);
  });

  it("token 不对 → 401", async () => {
    const r = await fetch(url("/scene"), { headers: { "x-hertaloy-token": "0".repeat(48) } });
    expect(r.status).toBe(401);
  });

  it("★ token 不出现在任何 URL 里 —— 它走 header，不落浏览器历史", async () => {
    const r = await withToken("/scene");
    expect(r.status).toBe(200);
    expect(r.url).not.toContain(h.token);
  });
});

describe("★ 只读", () => {
  it("POST 被拒 —— 这一版没有写入口", async () => {
    const r = await fetch(url("/scene"), {
      method: "POST",
      headers: { "x-hertaloy-token": h.token },
    });
    expect(r.status).toBe(405);
  });

  it("不认识的路径 404，并说清有哪些出口", async () => {
    const r = await withToken("/nope");
    expect(r.status).toBe(404);
    expect((await r.json()) as { error: string }).toHaveProperty("error");
  });
});

describe("三个读出口", () => {
  it("/scene 给一帧场景", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    drain(dir, HUMAN, undefined);
    const body = (await (await withToken("/scene")).json()) as {
      viewport: string;
      cells: { id: string }[];
    };
    expect(body.viewport).toBe("job-1");
    expect(body.cells.map((c) => c.id)).toContain("job-1#gate");
  });

  it("/templates 给配置全文，servo 在里面", async () => {
    const body = (await (await withToken("/templates")).json()) as Record<
      string,
      { nodes: Record<string, { ports: Record<string, { servo?: unknown }> }> }
    >;
    const one = Object.values(body)[0];
    expect(one?.nodes.gate?.ports.in?.servo).toBeDefined();
  });

  it("/authz 给决策流水", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    const body = (await (await withToken("/authz")).json()) as { actor: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]?.actor).toBe("human:local");
  });
});

describe("★ 授权没有被 HTTP 这层绕过去", () => {
  it("启动时的主体无权 → 403，而不是 500 也不是照给", async () => {
    const noRights = await listen({ dir, actor: AGENT, intervalMs: 30 });
    try {
      const r = await fetch(`http://127.0.0.1:${noRights.port()}/scene`, {
        headers: { "x-hertaloy-token": noRights.token },
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toMatch(/拒绝/);
    } finally {
      await noRights.close();
    }
  });

  it("★ 请求不能自称身份 —— 参数里塞主体不改变任何事", async () => {
    const noRights = await listen({ dir, actor: AGENT, intervalMs: 30 });
    try {
      // 试图用参数把自己说成有权的人
      const r = await fetch(`http://127.0.0.1:${noRights.port()}/scene?as=human:local`, {
        headers: { "x-hertaloy-token": noRights.token, "x-as": "human:local" },
      });
      // 仍然按启动时那个主体判 —— Principal 由可信边界注入，不由调用方自称
      expect(r.status).toBe(403);
    } finally {
      await noRights.close();
    }
  });
});

describe("★ /scene/stream：差量流", () => {
  it("有变化才吐，一行一帧", async () => {
    const res = await withToken("/scene/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readSome = async (): Promise<void> => {
      const { value, done } = await reader.read();
      if (!done && value !== undefined) text += decoder.decode(value, { stream: true });
    };

    await readSome(); // 基线那一帧
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    drain(dir, HUMAN, undefined);
    await readSome(); // 变化那一帧

    await reader.cancel();
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) expect(() => JSON.parse(l) as unknown).not.toThrow();
  }, 20_000);
});

/**
 * ★ 流的授权与失败收口（审核 F01）。
 *
 * 原实现两处错：
 *
 *   1. `res.writeHead(200)` 排在授权**之前** —— 同一个无权主体 `GET /scene`
 *      是 403，`GET /scene/stream` 却是 200。头一旦写出去就改不了状态码了。
 *   2. `void watchScene(...)` 没有 `.catch()` —— 授权抛出变成**未处理的
 *      Promise rejection**，整个观测服务以 code=1 退出。
 *
 * 第二条尤其要紧：**一次被拒的读取把服务打死了**，而拒绝本身是正常答复。
 */
describe("★ 流：先授权再写头，失败要收口（F01）", () => {
  it("★ 无权主体的流也是 403 —— 与 /scene 同一个答案", async () => {
    const noRights = await listen({ dir, actor: AGENT, intervalMs: 30 });
    try {
      const one = await fetch(`http://127.0.0.1:${noRights.port()}/scene`, {
        headers: { "x-hertaloy-token": noRights.token },
      });
      const stream = await fetch(`http://127.0.0.1:${noRights.port()}/scene/stream`, {
        headers: { "x-hertaloy-token": noRights.token },
      });
      expect(one.status).toBe(403);
      expect(stream.status).toBe(403);
      await stream.body?.cancel();
    } finally {
      await noRights.close();
    }
  });

  it("★ 被拒之后服务还活着 —— 拒绝是正常答复，不是故障", async () => {
    const noRights = await listen({ dir, actor: AGENT, intervalMs: 30 });
    try {
      const first = await fetch(`http://127.0.0.1:${noRights.port()}/scene/stream`, {
        headers: { "x-hertaloy-token": noRights.token },
      });
      await first.body?.cancel();
      // 还能继续答复 —— 原来这里进程已经带着 code=1 退了
      const again = await fetch(`http://127.0.0.1:${noRights.port()}/scene`, {
        headers: { "x-hertaloy-token": noRights.token },
      });
      expect(again.status).toBe(403);
    } finally {
      await noRights.close();
    }
  });

  it("有权主体照常拿到流", async () => {
    const res = await withToken("/scene/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    await res.body?.cancel();
  });
});
