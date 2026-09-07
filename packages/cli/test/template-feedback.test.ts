import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunState } from "@nodeflow/state";
import { definitions } from "../src/template-commands.js";
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
