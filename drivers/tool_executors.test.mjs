/**
 * tool_executors.mjs 的确定性测试 —— 不打 API，不进 Python。
 * 运行：node drivers/tool_executors.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_TOOLS,
  builtinTool,
  resolveInside,
  workspaceRoot,
} from "./tool_executors.mjs";

function makeReq(root) {
  return { workspace: { root } };
}

test("resolveInside 拒绝越界路径", () => {
  const root = path.resolve("C:/ws");
  assert.throws(() => resolveInside(root, "../secret.txt"), /越出工作区/);
  assert.throws(() => resolveInside(root, "a/../../secret.txt"), /越出工作区/);
  assert.equal(resolveInside(root, "a/../b.txt"), path.join(root, "b.txt"));
});

test("read_file/write_file/list_dir 在根内往返", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nf-tools-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const req = makeReq(root);

  await BUILTIN_TOOLS.write_file.execute(
    { path: "sub/hello.txt", content: "HELLO-TOOLS" },
    req
  );
  const text = await BUILTIN_TOOLS.read_file.execute(
    { path: "sub/hello.txt" },
    req
  );
  assert.equal(text, "HELLO-TOOLS");

  const listing = await BUILTIN_TOOLS.list_dir.execute({ path: "sub" }, req);
  assert.match(listing, /hello\.txt/);
});

test("write_file 越界被拒绝且不落盘", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nf-tools-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const req = makeReq(root);

  await assert.rejects(
    BUILTIN_TOOLS.write_file.execute(
      { path: "../escape.txt", content: "x" },
      req
    ),
    /越出工作区/
  );
  assert.equal(fs.existsSync(path.join(root, "..", "escape.txt")), false);
});

test("run_shell 默认关闭，显式启用后在工作区执行", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nf-tools-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const req = makeReq(root);

  await assert.rejects(
    BUILTIN_TOOLS.run_shell.execute({ command: "echo hi" }, req),
    /NODEFLOW_ALLOW_SHELL=1/
  );

  process.env.NODEFLOW_ALLOW_SHELL = "1";
  t.after(() => delete process.env.NODEFLOW_ALLOW_SHELL);
  const out = await BUILTIN_TOOLS.run_shell.execute(
    { command: "echo shell-ok" },
    req
  );
  assert.match(out, /shell-ok/);
});

test("builtinTool 命中/未命中语义", () => {
  assert.equal(builtinTool("read_file"), BUILTIN_TOOLS.read_file);
  assert.equal(builtinTool("ghost"), null);
});

test("workspaceRoot 缺省为当前目录", () => {
  assert.equal(workspaceRoot({}), path.resolve("."));
});
