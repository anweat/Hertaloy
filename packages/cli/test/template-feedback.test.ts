import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunState } from "@nodeflow/state";
import { define, definitions, operations, validateDefinition } from "../src/template-commands.js";
import { execFileSync } from "node:child_process";
import { message } from "../src/state-commands.js";
import { listen } from "../src/serve.js";

const HUMAN = { kind: "human", id: "local" } as const;
const AGENT = { kind: "agent", id: "reader" } as const;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-templates-"));
  const s = RunState.open(dir);
  try {
    s.control.define(HUMAN, "contract", { type: "object" }, "message_contract");
    s.control.define(HUMAN, "leaf", { nodes: { w: { kind: "handler", handler: "noop",
      ports: { in: { direction: "receive", contract: "contract@1" } } } } });
    s.control.define(HUMAN, "mid", { children: { leaf: { template: "leaf@1" } } });
    s.control.define(HUMAN, "root", { children: { kids: { template: "mid@1" } } }, "root_config");
    s.registry.createRoot("root@1", "job");
    s.control.spawn(HUMAN, "job", "kids", "a");
    s.control.define(HUMAN, "leaf", {}); // 新版没有替换已固定的 leaf@1
    s.control.define(HUMAN, "unrelated", {});
    s.persist();
  } finally { s.close(); }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("声明闭包含未实例化的孙模板和契约；版本与使用者精确关联", () => {
  const before = readFileSync(join(dir, "head.json"), "utf8");
  const d = definitions(dir, HUMAN).data as Record<string, { usedBy: string[]; dependencies: unknown[] }>;
  expect(Object.keys(d).sort()).toEqual(["contract@1", "leaf@1", "mid@1", "root@1"]);
  expect(d["root@1"]!.usedBy).toEqual(["job"]);
  expect(d["leaf@1"]!.usedBy).toEqual([]);
  expect(d["mid@1"]!.dependencies).toContainEqual({ ref: "leaf@1", where: "children.leaf.template" });
  expect(readFileSync(join(dir, "head.json"), "utf8")).toBe(before);
});

it("子树读权限可以看它的声明闭包，但不能扩成父树或未使用资产目录", () => {
  writeFileSync(join(dir, "permissions.json"), JSON.stringify({ format: 1, grants: [
    { principal: "agent:reader", scope: "job/a", ops: ["DQL"] },
  ] }));
  expect(definitions(dir, AGENT).code).toBe(1);
  const r = definitions(dir, AGENT, "job/a");
  expect(r.code).toBe(0);
  expect(Object.keys(r.data as object).sort()).toEqual(["contract@1", "leaf@1", "mid@1"]);
});

it("HTTP 出口与 CLI 返回同一闭包，未授权请求仍被拒", async () => {
  const h = await listen({ dir, actor: HUMAN });
  try {
    const url = `http://127.0.0.1:${h.port()}/definitions`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { "x-hertaloy-token": h.token } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(definitions(dir, HUMAN).data);
  } finally { await h.close(); }
});

it.each([
  [{ nodes: { w: { kind: "wrong" } } }, "nodes.w.kind"],
  [{ children: { bad: { template: "missing@1" } } }, "children.bad"],
  [{ extends: "missing@1", override: {} }, "extends"],
  [{ nodes: { w: { kind: "handler", ports: {}, agent: { argv: ["x"], capabilities: { network: "opne" } } } } }, "nodes.w.agent"],
])("干跑和正式注册拒绝同一字段，不追加对象：%j", (spec, where) => {
  const before = readFileSync(join(dir, "head.json"), "utf8");
  const checked = validateDefinition(dir, HUMAN, "draft", spec);
  const written = define(dir, HUMAN, "draft", spec);
  expect(checked.code).toBe(1);
  expect(written.data).toEqual(checked.data);
  expect(checked.data).toMatchObject({ valid: false, registered: false, issues: expect.arrayContaining([
    expect.objectContaining({ where: expect.stringContaining(where as string), severity: "error" }),
  ]) });
  expect(readFileSync(join(dir, "head.json"), "utf8")).toBe(before);
});

it("overlay 干跑返回物化结果，注册返回真实 ref；运行 pin 不变", () => {
  const spec = { extends: "leaf@1", override: {} };
  const before = readFileSync(join(dir, "head.json"), "utf8");
  expect(validateDefinition(dir, HUMAN, "derived", spec).data).toMatchObject({
    valid: true, registered: false, definition: { kind: "materialized", base: "leaf@1" },
  });
  expect(readFileSync(join(dir, "head.json"), "utf8")).toBe(before);
  expect(define(dir, HUMAN, "derived", spec).data).toEqual({ ref: "derived@1", registered: true });
  expect((definitions(dir, HUMAN).data as object)).not.toHaveProperty("derived@1");
});

it("HTTP 草稿校验携带字段错误；坏 JSON/大请求收口；始终不写 head", async () => {
  const before = readFileSync(join(dir, "head.json"), "utf8");
  const h = await listen({ dir, actor: HUMAN });
  try {
    const url = `http://127.0.0.1:${h.port()}/validate-definition`;
    const post = (body: string, token = h.token) => fetch(url, {
      method: "POST", headers: { "x-hertaloy-token": token }, body,
    });
    expect((await post("{}", "bad")).status).toBe(401);
    expect((await post("{" )).status).toBe(400);
    expect((await post("x".repeat(300 * 1024))).status).toBe(413);
    const bad = await post(JSON.stringify({ id: "draft", spec: { extends: "missing@1", override: {} } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ valid: false, issues: [{ where: "extends", code: "missing_definition" }] });
    const good = await post(JSON.stringify({ id: "draft", spec: {} }));
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ valid: true, registered: false });
    expect(readFileSync(join(dir, "head.json"), "utf8")).toBe(before);
  } finally { await h.close(); }
});

it("真实 CLI 返回 JSON 校验及注册反馈", () => {
  const file = join(dir, "draft.json");
  writeFileSync(file, JSON.stringify({ children: { next: { template: "leaf@1" } } }));
  const cli = (cmd: string) => JSON.parse(execFileSync(process.execPath, [
    "--import", "tsx", "src/main.ts", cmd, dir, "draft", file, "--json",
  ], { encoding: "utf8" }));
  expect(cli("validate-definition")).toMatchObject({ valid: true, registered: false });
  expect(cli("define")).toEqual({ ref: "draft@1", registered: true });
});

it("可用性区分权限、根范围、运行状态和通道限制，不改 head", () => {
  const before = readFileSync(join(dir, "head.json"), "utf8");
  const actions = (channel: "http" | "cli" | "mcp", scope = "job") =>
    (operations(dir, HUMAN, scope, channel).data as { actions: { operation: string; available: boolean; reasons: { code: string }[]; requires: string[] }[] }).actions;
  expect(actions("http").every((a) => !a.available && a.reasons.some((r) => r.code === "read_only_transport"))).toBe(true);
  expect(actions("cli").find((a) => a.operation === "spawn")!.reasons).toContainEqual(expect.objectContaining({ code: "unsupported_channel" }));
  expect(actions("mcp").find((a) => a.operation === "spawn")).toMatchObject({ available: true, requires: ["slot", "segment"] });
  expect(actions("cli", "job/a").find((a) => a.operation === "run")!.reasons).toContainEqual(expect.objectContaining({ code: "root_only" }));
  expect(readFileSync(join(dir, "head.json"), "utf8")).toBe(before);
  const s = RunState.open(dir);
  try { s.control.truncate(HUMAN, "job", "test"); s.persist(); } finally { s.close(); }
  expect(actions("mcp").find((a) => a.operation === "spawn")!.reasons).toContainEqual(expect.objectContaining({ code: "terminal_instance" }));
});

it("只有 DQL 的主体能预览和校验，看到写权限不足；不能据此注册", () => {
  writeFileSync(join(dir, "permissions.json"), JSON.stringify({ format: 1, grants: [
    { principal: "agent:reader", scope: "*", ops: ["DQL"] },
  ] }));
  const r = operations(dir, AGENT);
  expect(r.code).toBe(0);
  expect((r.data as { actions: { permission: { allowed: boolean }; available: boolean }[] }).actions
    .every((a) => !a.available && !a.permission.allowed)).toBe(true);
  expect(validateDefinition(dir, AGENT, "draft", {}).code).toBe(0);
  expect(define(dir, AGENT, "draft", {}).data).toHaveProperty("error.code", "forbidden");
});

it("HTTP 操作反馈指定真实通道，配置损坏后服务仍可恢复读取", async () => {
  const h = await listen({ dir, actor: HUMAN });
  try {
    const get = () => fetch(`http://127.0.0.1:${h.port()}/operations`, { headers: { "x-hertaloy-token": h.token } });
    expect(await (await get()).json()).toMatchObject({ channel: "http", scope: "job" });
    writeFileSync(join(dir, "permissions.json"), "broken");
    expect((await get()).status).toBe(500);
    rmSync(join(dir, "permissions.json"));
    expect((await get()).status).toBe(200);
  } finally { await h.close(); }
});

it("只读对象出口返回精确正文，子树主体不能读取范围外对象", async () => {
  const s = RunState.open(dir);
  try {
    s.store.put("job/a/result.md", "artifact", { text: "first" });
    s.store.put("job/a/result.md", "artifact", { text: "second" });
    s.store.put("job/private", "artifact", { text: "outside" });
    s.persist();
  } finally { s.close(); }
  writeFileSync(join(dir, "permissions.json"), JSON.stringify({ format: 1, grants: [
    { principal: "agent:reader", scope: "job/a", ops: ["DQL"] },
  ] }));
  const h = await listen({ dir, actor: AGENT });
  try {
    const get = (ref: string) => fetch(`http://127.0.0.1:${h.port()}/object?ref=${encodeURIComponent(ref)}`,
      { headers: { "x-hertaloy-token": h.token } });
    expect(await (await get("job/a/result.md@1")).json()).toMatchObject({ body: { text: "first" }, version: 1 });
    expect((await get("job/private@1")).status).toBe(403);
    expect((await get("job/nonexistent@1")).status).toBe(403);
  } finally { await h.close(); }
});

it("获准子树内的消息可读，根因果无权时明确标为不可用", () => {
  const s = RunState.open(dir);
  let id: string;
  try {
    s.control.spawn(HUMAN, "job/a", "leaf", "worker");
    id = s.control.send(HUMAN, { traceid: "job/a/worker", node: "w", port: "in" }, { visible: true });
    s.persist();
  } finally { s.close(); }
  writeFileSync(join(dir, "permissions.json"), JSON.stringify({ format: 1, grants: [
    { principal: "agent:reader", scope: "job/a", ops: ["DQL"] },
  ] }));
  const result = message(dir, AGENT, id!);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ payload: { visible: true }, causesUnavailable: expect.stringContaining("根作用域") });
  expect(result.text).not.toContain("由 0 条消息导致");
});
