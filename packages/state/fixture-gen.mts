/**
 * 造一个**生命周期有落差**的真实 run，落盘后导出快照。
 *
 * 上一版所有东西都是 idle、都活着，于是"生命周期"那条轴上什么都看不出来。
 * 这一版刻意造出四种不同的命运：
 *
 *   a1  干完活 → 已终止（带有右端，收口）
 *   b1  还开着（带没有右端，羽化）
 *   review  agent 正在外面跑（RUNNING —— 有宽度的执行段）
 *   audit   agent 跑失败了（FAILED）
 *
 * 用法：npx tsx packages/state/fixture-gen.mts > snap.json
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSegment } from "@nodeflow/contracts";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "@nodeflow/contracts";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "./src/run-state.js";
import { exportSnapshot } from "./src/snapshot.js";

/** `review` 永不返回（模拟还在外面跑），`audit` 返回失败。 */
class Mixed implements ExecutionBackend {
  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    if (lastSegment(req.instance) === "review") return await new Promise<ExecutionResult>(() => {});
    return {
      executionId: req.executionId,
      emissions: {},
      termination: "FAILED",
      diagnostics: { runner: "fixture", stderrTail: "审计脚本退出码 2" } as never,
    };
  }
  async cancel(): Promise<void> {}
}

const dir = mkdtempSync(join(tmpdir(), "fixture-"));
const s = RunState.open(dir, { backend: new Mixed(), maxAttempts: 1 });

const worker = registerContainerTemplate(s.store, "worker", {
  nodes: {
    scan: {
      kind: "handler",
      handler: "emit",
      ports: {
        in: { direction: "receive", servo: { vars: {} } },
        found: { direction: "emit", alias: "findings" },
        out: { direction: "emit" },
      },
    },
    wrap: {
      kind: "handler",
      handler: "noop",
      ports: { got: { direction: "receive", servo: { vars: {} } } },
    },
  },
  edges: { e: { from: { node: "scan", port: "out" }, to: { node: "wrap", port: "got" } } },
  children: {},
});

const root = registerContainerTemplate(
  s.store,
  "root",
  {
    nodes: {
      plan: {
        kind: "handler",
        handler: "emit",
        ports: {
          start: { direction: "receive", servo: { vars: {} } },
          out: { direction: "emit" },
        },
      },
      merge: {
        kind: "handler",
        handler: "noop",
        ports: {
          got: { direction: "receive", servo: { vars: {} } },
          exit: { direction: "receive", servo: { vars: {} } },
        },
      },
      watch: {
        kind: "handler",
        handler: "noop",
        ports: { heard: { direction: "receive", servo: { vars: {} } } },
      },
      review: {
        kind: "handler",
        agent: { argv: ["claude"] },
        ports: {
          task: { direction: "receive", servo: { vars: {} } },
          done: { direction: "emit" },
        },
      },
      audit: {
        kind: "handler",
        agent: { argv: ["codex"] },
        ports: {
          task: { direction: "receive", servo: { vars: {} } },
          done: { direction: "emit" },
        },
      },
      idle: {
        kind: "handler",
        handler: "noop",
        ports: { never: { direction: "receive", servo: { vars: {} } } },
      },
    },
    edges: { p: { from: { node: "plan", port: "out" }, to: { node: "merge", port: "got" } } },
    children: {
      a: { template: worker, entry: { node: "scan", port: "in" }, exit: { node: "merge", port: "exit" } },
      b: { template: worker, entry: { node: "scan", port: "in" }, exit: { node: "merge", port: "exit" } },
    },
    bindings: [
      { alias: "findings", node: "watch", port: "heard" },
      // 绑了但从没人往这儿发 —— certainty 恒 0 的那根须。
      // 别名校验只要求"用到的必须绑上"，反过来不要求，所以这根须仍然表达得出来。
      { alias: "silence", node: "idle", port: "never" },
    ],
  },
  "root_config",
);

s.registry.createRoot(root, "job-1");
s.runtime.registerHandler("emit", (_v, ctx) => {
  const self = lastSegment(ctx.instance);
  ctx.put(`note-${self}`, "artifact", { text: `${self} 的产出` });
  return { out: { ok: true }, ...(ctx.port === "in" ? { found: { what: "看这儿" } } : {}) };
});
s.runtime.registerHandler("noop", () => ({}));

s.runtime.send({ instance: "job-1/plan", port: "start" }, {});

/**
 * **同一个子槽扇出三个实例** —— 实测一个槽能有 N 个活实例（a1/a2/a3）。
 * 画布上它们叠在模板那一个位置上，而不是各自散开。
 */
const a1 = s.runtime.spawn("job-1", "a", "a1");
s.runtime.send({ instance: `${a1.traceid}/scan`, port: "in" }, {});
s.runtime.drain();

const a2 = s.runtime.spawn("job-1", "a", "a2");
s.runtime.send({ instance: `${a2.traceid}/scan`, port: "in" }, {});
s.runtime.drain();

// a3 晚出生，且留一条没消费的活儿 → 它会一直开着
const a3 = s.runtime.spawn("job-1", "a", "a3");
s.runtime.send({ instance: `${a3.traceid}/scan`, port: "in" }, {});
s.runtime.drain();

/**
 * review 出去且永不返回 —— 它得是 RUNNING，那是**有宽度的执行段**。
 */
s.runtime.send({ instance: "job-1/review", port: "task" }, {});
void s.runtime.stepAgent();
await Promise.resolve();

// audit 跑完并失败
s.runtime.send({ instance: "job-1/audit", port: "task" }, {});
await s.runtime.stepAgent();

/**
 * a1/a2 收口、a3 继续开着 —— 同一个槽的三个实例命运不同，
 * 这正是"叠加"要显示的东西：它们不是一个东西的三个副本，是三条各自的命。
 * a3 靠**还有一条没消费的消息**留住。
 * 子槽 b 一次都不 spawn —— 声明了没用过的那个位置也要看得见。
 */
s.runtime.send({ instance: `${a3.traceid}/scan`, port: "in" }, {});
s.runtime.settleAll();
s.persist();

process.stdout.write(`${JSON.stringify(exportSnapshot(s, { kind: "human", id: "local" }), null, 1)}
`);
s.close();
