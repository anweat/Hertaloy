/** 头随历史增长多少 —— 阶段 5 之后终态的执行与消息都归对象库，头只装在途。 */
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerContainerTemplate } from "../../packages/kernel/src/index.js";
import { RunState } from "../../packages/state/src/run-state.js";

const TPL = {
  nodes: { n: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  edges: {}, children: {},
};

for (const m of [200, 800, 2000, 5000]) {
  const dir = mkdtempSync(join(tmpdir(), "head-"));
  const s = RunState.open(dir);
  s.registry.createRoot(registerContainerTemplate(s.store, "root", TPL, "root_config"), "job");
  s.runtime.registerHandler("noop", () => ({}));
  // 生产里同步提交**不落盘**（`onCommit` 只在 claim 时 persist），
  // 所以一趟 drain 只写一次头。逐条 persist 是不真实的负载。
  const t0 = performance.now();
  for (let i = 0; i < m; i += 1) s.runtime.send({ instance: "job/n", port: "in" }, {});
  s.runtime.drain();
  s.persist();
  const ms = performance.now() - t0;
  const bytes = statSync(join(dir, "head.json")).size;
  const records = s.runtime.records().length;
  const history = s.runtime.messages().length;
  const live = s.runtime.liveMessages().length;
  s.close();
  console.log(
    `M=${String(m).padStart(4)}  head.json ${(bytes / 1024).toFixed(1)} KiB  ` +
    `记录 ${String(records)} 条  消息历史 ${String(history)} 条  ` +
    `队列里 ${String(live)} 条  落盘总耗时 ${ms.toFixed(0)}ms`,
  );
  rmSync(dir, { recursive: true, force: true });
}
