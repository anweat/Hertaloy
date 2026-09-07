/**
 * 只读观测服务 —— 前后端分离的那条线。
 *
 * ## 主体在启动时定死，不由请求自称
 *
 * §11 的纪律是 **Principal 必须由可信边界注入**，绝不从 payload 或参数里取。
 * 让请求自带主体（header 或 query）等于让调用方自称身份 —— 那会把这条从
 * 结构性保证降成口头约定，而这个项目在授权上一路守的就是它。
 *
 * 所以：启动时 `--as` 定一个主体，**整个进程只有这一个身份**。这意味着
 * 「能连上这个端口的人 = 那个主体」。
 *
 * ## 信任边界如实说（审核 R05）
 *
 * 只监听 **127.0.0.1**，所以边界是**这台机器**：网络上的人进不来。
 *
 * token **不是**对同机进程的访问控制。我原来在这儿写着"挡住同机的其他进程"，
 * 那句话是假的：首页把 token 内嵌进去交给浏览器，于是**任何能连上这个端口的
 * 本机进程 GET `/` 就能拿到它**，再拿去读 `/scene` 一样是 200。实测如此。
 *
 * token 实际挡住的只有一样：**不知道要先去取它**的调用方 —— 比如别的页面
 * 从浏览器里发来的跨站请求（它读不到我们的响应体）。这是 CSRF 量级的护栏，
 * 不是身份验证。
 *
 * 换句话说：**同机 = 可信**，是这一版明确接受的前提。写操作落地之前必须
 * 重新定这条边界（要么 token 不再从首页发、由人转交，要么走真正的本地认证），
 * 那是一个待决定的设计题，不是这里能顺手补上的。
 *
 * token 走 **header 不走 query**：query 会落进浏览器历史与访问日志。
 * 代价是流不能用 `EventSource`（它设不了 header），改用 `fetch` + 流式读。
 *
 * ## 只读
 *
 * 全部是 GET，`RunState` 一律 `readOnly` 打开：不拿目录锁、不写授权日志
 * （§17.8 单写者）。看的人再多也不挡跑的那个进程。
 *
 * 人工操作（send / truncate）将来加 POST —— 内核不用配合，它本来就不知道
 * 谁在调它；要做的只是在这个边界上继续注入同一个主体。
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Principal } from "@nodeflow/contracts";
import {
  authz,
  execution,
  message,
  scene,
  status,
  templates,
  watchScene,
} from "./state-commands.js";

export interface ServeOptions {
  readonly dir: string;
  readonly actor: Principal;
  readonly port?: number;
  readonly intervalMs?: number;
  /** 页面 HTML。不给就只有 JSON 出口。 */
  readonly page?: string;
}

export interface ServeHandle {
  readonly server: Server;
  readonly token: string;
  /** 实际监听的端口（给了 0 就是系统分配的那个）。 */
  port(): number;
  close(): Promise<void>;
}

const TOKEN_HEADER = "x-hertaloy-token";

/** 定长比较 —— 长度不同直接判否，避免 `timingSafeEqual` 抛。 */
function tokenOk(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** 命令结果 → HTTP。授权被拒是 403，不是 500 —— 它是正常答复，不是故障。 */
function fromCommand(res: ServerResponse, r: { code: number; text: string; data?: unknown }): void {
  if (r.code === 0) {
    sendJson(res, 200, r.data ?? JSON.parse(r.text));
    return;
  }
  sendJson(res, r.text.startsWith("拒绝") ? 403 : 400, { error: r.text });
}

/** 只给 `listen` 用 —— 不导出：没有第二个调用方，导出就是孤儿。 */
function createServer(options: ServeOptions): ServeHandle {
  const token = randomBytes(24).toString("hex");
  const interval = options.intervalMs ?? 500;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const scope = url.searchParams.get("scope") ?? undefined;

    // 页面本身不要 token —— 它就是用来把 token 交到浏览器手里的那一步
    if (url.pathname === "/" && options.page !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(options.page.replace("__HERTALOY_TOKEN__", token));
      return;
    }

    if (!tokenOk(req.headers[TOKEN_HEADER] as string | undefined, token)) {
      sendJson(res, 401, { error: `缺少或错误的 ${TOKEN_HEADER}` });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "只读服务，只接受 GET" });
      return;
    }

    switch (url.pathname) {
      case "/scene":
        fromCommand(res, scene(options.dir, options.actor, scope));
        return;
      case "/templates":
        fromCommand(res, templates(options.dir, options.actor, scope));
        return;
      /**
       * 详情三口。都按 id 取，授权在 ControlPlane 那层按目标的 traceid 判 ——
       * 无权与"没有"分不出来是有意的（见 `ControlPlane.execution`）。
       */
      case "/status":
        fromCommand(res, status(options.dir, options.actor));
        return;
      case "/execution": {
        const id = url.searchParams.get("id");
        if (id === null) {
          sendJson(res, 400, { error: "缺少 id 参数" });
          return;
        }
        fromCommand(res, execution(options.dir, options.actor, id));
        return;
      }
      case "/message": {
        const id = url.searchParams.get("id");
        if (id === null) {
          sendJson(res, 400, { error: "缺少 id 参数" });
          return;
        }
        fromCommand(res, message(options.dir, options.actor, id));
        return;
      }
      case "/authz": {
        const n = Number(url.searchParams.get("limit") ?? "50");
        fromCommand(res, authz(options.dir, options.actor, Number.isFinite(n) ? n : 50));
        return;
      }
      case "/scene/stream": {
        /**
         * **先授权，再写头。**
         *
         * 原来 `writeHead(200)` 排在最前面，于是同一个无权主体 `GET /scene`
         * 是 403、`GET /scene/stream` 却是 200 —— 头一旦写出去就改不了状态码。
         * 这里先算一帧（走的是同一条带授权的路），拒绝就按普通答复回。
         */
        const preflight = scene(options.dir, options.actor, scope);
        if (preflight.code !== 0) {
          fromCommand(res, preflight);
          return;
        }

        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        const abort = new AbortController();
        // 客户端断开就停轮询 —— 否则关掉页面之后进程还在空转
        req.on("close", () => abort.abort());
        void watchScene(
          options.dir,
          options.actor,
          scope,
          interval,
          (line) => {
            if (!res.writableEnded) res.write(`${line}\n`);
          },
          abort.signal,
        )
          /**
           * **流里失败也要收口。**
           *
           * 原来是 `void watchScene(...)` 没有 catch —— 抛出变成未处理的
           * Promise rejection，整个观测服务以 code=1 退出。**一次被拒的读取
           * 把服务打死了**，而拒绝本身是正常答复。
           *
           * 头已经是 200，改不回状态码；能做的是在流里说清再收口。
           * 客户端按 `error` 字段识别 —— 普通帧没有这个键。
           */
          .catch((error: unknown) => {
            if (res.writableEnded) return;
            const text = error instanceof Error ? error.message : String(error);
            res.write(`${JSON.stringify({ error: text })}\n`);
          })
          .finally(() => {
            if (!res.writableEnded) res.end();
          });
        return;
      }
      default:
        sendJson(res, 404, { error: `没有这个出口：${url.pathname}` });
    }
  });

  return {
    server,
    token,
    port: () => {
      const addr = server.address();
      return addr !== null && typeof addr === "object" ? addr.port : 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 起服务，只绑 127.0.0.1。返回时已经在听了。 */
export async function listen(options: ServeOptions): Promise<ServeHandle> {
  const handle = createServer(options);
  await new Promise<void>((resolve) => {
    handle.server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  return handle;
}
