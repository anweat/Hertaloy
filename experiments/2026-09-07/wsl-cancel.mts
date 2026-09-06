/** Two harmless, bounded processes with a unique command line; cancel only one. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WslRunner, toHostPath, wslAvailable } from "../../packages/sandbox/src/wsl.js";
import { createSandbox } from "../../packages/sandbox/src/layout.js";

if (!wslAvailable("Ubuntu")) throw new Error("Ubuntu is not available");
const innerRoot = `/tmp/hertaloy-audit-${randomUUID()}`;
const hostRoot = toHostPath(innerRoot, "Ubuntu");
mkdirSync(hostRoot);
const script = `${innerRoot}/work.sh`;
writeFileSync(join(hostRoot, "work.sh"), "echo started > started\nsleep 4\necho finished > finished\n");
const runner = new WslRunner({ innerRoot });
const first = createSandbox(runner.allocate("first"));
const second = createSandbox(runner.allocate("second"));
const abort = new AbortController();
const started = Date.now();
const firstRun = runner.run({ root: first.box, argv: ["sh", script], signal: abort.signal });
const secondRun = runner.run({ root: second.box, argv: ["sh", script] });
while (!existsSync(join(first.workspace, "started")) || !existsSync(join(second.workspace, "started"))) {
  if (Date.now() - started > 10_000) {
    console.log(JSON.stringify({ setupFailed: true, outcomes: await Promise.all([firstRun, secondRun]) }));
    throw new Error("WSL fixture did not start");
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
abort.abort();
const [a, b] = await Promise.all([firstRun, secondRun]);
// The bounded sleep descendants are allowed to finish before this probe returns.
await new Promise((resolve) => setTimeout(resolve, Math.max(0, 5000 - (Date.now() - started))));
const result = { innerRoot, first: a, second: b,
  firstFinished: existsSync(join(first.workspace, "finished")),
  secondFinished: existsSync(join(second.workspace, "finished")) };
writeFileSync(new URL("./wsl-results.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
