/**
 * Nodeflow 执行面 —— 内置工具执行器（Phase 1）
 *
 * 独立成模块的原因：openai_compat_driver.mjs 是线协议入口（需要 API 配置），
 * 而这些执行器必须能被 `tool_executors.test.mjs` 在**不打 API** 的前提下
 * 确定性测试。规则：
 *
 *   - 工作区根 = request.workspace.root；所有路径解析到根之下，越界即拒
 *   - run_shell 默认关闭：必须显式设 NODEFLOW_ALLOW_SHELL=1，cwd 仍限工作区内
 *   - 输出一律截断；超时按 NODEFLOW_TOOL_TIMEOUT_MS（默认 30s）
 */

import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const TOOL_TIMEOUT_MS = Number(process.env.NODEFLOW_TOOL_TIMEOUT_MS ?? 30_000);
const MAX_TOOL_OUTPUT = Number(process.env.NODEFLOW_TOOL_MAX_OUTPUT ?? 20_000);

export function workspaceRoot(req) {
  return path.resolve(req.workspace?.root ?? ".");
}

export function resolveInside(root, rel) {
  const abs = path.resolve(root, rel ?? ".");
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越出工作区：${rel}`);
  }
  return abs;
}

export function clip(text) {
  const s = String(text ?? "");
  return s.length > MAX_TOOL_OUTPUT
    ? s.slice(0, MAX_TOOL_OUTPUT) +
        `\n...[截断 ${s.length - MAX_TOOL_OUTPUT} 字符]`
    : s;
}

export const BUILTIN_TOOLS = {
  read_file: {
    description: "读取工作区内的文本文件",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对工作区的路径" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, req) => {
      const abs = resolveInside(workspaceRoot(req), args.path);
      const text = await import("node:fs").then((fs) =>
        fs.promises.readFile(abs, "utf-8")
      );
      return clip(text);
    },
  },
  write_file: {
    description: "在工作区内写入文件（目录不存在会自动创建）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args, req) => {
      const fs = await import("node:fs");
      const root = workspaceRoot(req);
      const abs = resolveInside(root, args.path);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, String(args.content ?? ""), "utf-8");
      return `已写入 ${path.relative(root, abs)}（${Buffer.byteLength(
        String(args.content ?? "")
      )} 字节）`;
    },
  },
  list_dir: {
    description: "列出工作区内的目录条目",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区路径，缺省为根" },
      },
      additionalProperties: false,
    },
    execute: async (args, req) => {
      const fs = await import("node:fs");
      const abs = resolveInside(workspaceRoot(req), args.path ?? ".");
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      return clip(
        entries
          .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
          .join("\n")
      );
    },
  },
  run_shell: {
    description: "在工作区内执行 shell 命令（需 NODEFLOW_ALLOW_SHELL=1 启用）",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        cwd: { type: "string", description: "工作区内的相对目录，缺省为根" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args, req) => {
      if (process.env.NODEFLOW_ALLOW_SHELL !== "1") {
        throw new Error(
          "run_shell 未启用：请由控制面显式设置 NODEFLOW_ALLOW_SHELL=1"
        );
      }
      const root = workspaceRoot(req);
      const cwd = resolveInside(root, args.cwd ?? ".");
      const { stdout, stderr } = await execAsync(String(args.command), {
        cwd,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const body = clip(
        (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")
      );
      return body || "(无输出)";
    },
  },
};

export function builtinTool(name) {
  return BUILTIN_TOOLS[name] ?? null;
}
