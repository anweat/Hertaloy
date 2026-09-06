import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExecutionRequest } from "@nodeflow/contracts";
import { SandboxBackend, type RetainPolicy, type SandboxDiagnostics } from "../src/backend.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ["never", "always", true, true],
  ["never", "always", false, true],
  ["always", "never", true, false],
  ["always", "never", false, false],
  ["always", "on-failure", true, false],
  ["never", "on-failure", false, true],
  ["always", undefined, true, true],
  ["never", undefined, false, false],
] as const)("全局 %s，节点 %s，成功 %s：实际保留 %s", async (fallback, retain, success, kept) => {
  const workRoot = mkdtempSync(join(tmpdir(), "hertaloy-retain-"));
  roots.push(workRoot);
  const backend = new SandboxBackend({ workRoot, retain: fallback as RetainPolicy });
  const request: ExecutionRequest = {
    executionId: "exec-1", traceid: "job", nodeId: "work", priorExecutions: {},
    agentSpec: {
      argv: [process.execPath, "-e", success
        ? 'require("node:fs").writeFileSync("../.hertaloy/emit.json", JSON.stringify({out:{ok:true}}))'
        : "process.exit(7)"],
      ...(retain === undefined ? {} : { capabilities: { retain } }),
    },
    vars: {}, outputContract: { allowedEmitPorts: ["out"] }, limits: {},
  };
  const result = await backend.run(request);
  expect(result.termination).toBe(success ? "DONE" : "FAILED");
  const sandbox = (result.diagnostics as unknown as SandboxDiagnostics).sandbox!;
  expect(sandbox.retained).toBe(kept);
  expect(existsSync(sandbox.path)).toBe(kept);
}, 30_000);
