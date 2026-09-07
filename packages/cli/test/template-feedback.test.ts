import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunState } from "@nodeflow/state";
import { define, definitions, validateDefinition } from "../src/template-commands.js";
import { execFileSync } from "node:child_process";
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
