#!/usr/bin/env node
/**
 * MCP 服务端 —— 把 `TOOLS` 挂到 stdio 上。**这一层只做接线，不含逻辑。**
 *
 * 逻辑全在 `tools.ts`（纯函数，直接可测）。传输层薄到不值得测，
 * 是有意的：不该为了验一条业务规则去起一个 stdio 会话。
 *
 * 用法：
 *   hertaloy-mcp --dir <状态目录> [--as human:alice]
 *
 * `--as` 决定这个会话的身份，**默认 `human:local`**。真要开放给外部，
 * 身份应由认证会话注入而不是命令行 —— 当前这个只适合本机，
 * 与 CLI 的 `--as` 是同一条限制（自报身份，不是认证）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Principal } from "@nodeflow/contracts";
import { TOOLS, type ToolContext } from "./tools.js";

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function parseActor(raw: string | undefined): Principal {
  if (raw === undefined) return { kind: "human", id: "local" };
  const sep = raw.indexOf(":");
  const kind = sep === -1 ? raw : raw.slice(0, sep);
  const id = sep === -1 ? "" : raw.slice(sep + 1);
  const known = ["human", "agent", "system", "service"] as const;
  if (!known.includes(kind as (typeof known)[number]) || id === "") {
    throw new Error(`--as 形如 human:alice / agent:coder-1，收到 ${raw}`);
  }
  return { kind: kind as Principal["kind"], id };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = flag(argv, "--dir");
  if (dir === undefined) {
    process.stderr.write("用法：hertaloy-mcp --dir <状态目录> [--as human:alice]\n");
    process.exitCode = 2;
    return;
  }
  const ctx: ToolContext = { dir, actor: parseActor(flag(argv, "--as")) };

  const server = new McpServer({ name: "hertaloy", version: "0.0.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema.shape,
      },
      (args: Record<string, unknown>) => {
        const result = tool.handler(ctx, args);
        return {
          content: [{ type: "text" as const, text: result.text }],
          isError: result.isError,
        };
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

await main();
