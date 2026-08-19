/**
 * 沙箱 backend —— 把契约目录 + 运行器 + git 观察组装成 `ExecutionBackend`。
 *
 * 对应 FOUNDATION_V5.md §14。内核那侧一行不用改：`agentSpec` 早就是
 * `JsonObject`（不透明），换里面装什么都不影响编排面。
 *
 * 一次执行 = 建沙箱 → 注入 → 打基线 → **跑一条命令行** → 读 emit → 观察 → 收产物 → 拆沙箱。
 */

import { z } from "zod";
import { AgentSpec } from "@nodeflow/contracts";
import type {
  ExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
  Termination,
} from "@nodeflow/contracts";
import {
  collectArtifacts,
  createSandbox,
  destroySandbox,
  readEmit,
  writeContext,
  writeRequest,
  writeSandboxFile,
} from "./layout.js";
import { resolveProfile } from "./profile.js";
import { gitAvailable, initObserver, observe, type Observation } from "./observe.js";
import { LocalRunner, type RunOutcome, type Runner } from "./runner.js";

/**
 * `agentSpec` 的沙箱形态：**一条命令行**。
 *
 * `claude` / `codex` / `hertaloy agent` 三者平权 —— 它们的差别只是 argv 与
 * profile，不是三种 backend 类型（§14.1）。
 */
/**
 * 与 contracts 的 `AgentSpec` **同一套字段**，只是补上默认值。
 *
 * 不各写一份：两处各自演进而没人对账，正是"模板要 model、后端要 argv"
 * 那次断裂的成因。这里从契约派生，字段变了编译期就会撞上。
 */
export const SandboxAgentSpec = AgentSpec.extend({
  profile: z.string().default("hertaloy-agent"),
  context: z.record(z.string()).default({}),
  env: z.record(z.string()).default({}),
});

export type SandboxAgentSpec = z.infer<typeof SandboxAgentSpec>;

export interface SandboxOptions {
  readonly runner?: Runner;
  /** 沙箱与记录仓的父目录。默认系统临时目录。 */
  readonly workRoot?: string;
  /** 跑完是否删沙箱。调试时设 false。 */
  readonly cleanup?: boolean;
}

export interface SandboxDiagnostics {
  readonly runner: string;
  readonly isolates: boolean;
  /**
   * 这次跑的出网**实际**受不受控。
   *
   * 与 `isolates` 分两个字段而不是合成一个"安全吗"：文件系统隔离和网络隔离
   * 是两堵不同的墙，wsl 有前者没后者。合成一个布尔会让"隔离了但能出网"
   * 无法表达 —— 而那正是最常见的一档。
   */
  readonly networkEnforced: boolean;
  readonly exitCode: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly observation?: Observation;
}

export class SandboxBackend implements ExecutionBackend {
  readonly #runner: Runner;
  readonly #cleanup: boolean;
  readonly #inflight = new Map<string, AbortController>();

  constructor(options: SandboxOptions = {}) {
    this.#runner = options.runner ?? new LocalRunner(options.workRoot);
    this.#cleanup = options.cleanup ?? true;
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const parsed = SandboxAgentSpec.safeParse(request.agentSpec);
    if (!parsed.success) {
      return this.#fail(request, "INVALID_OUTPUT", {
        runner: this.#runner.kind,
        isolates: this.#runner.isolates,
        networkEnforced: this.#runner.enforcesNetwork,
        exitCode: null,
        stdoutTail: "",
        stderrTail: `agentSpec 不是合法的沙箱规格：${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("；")}`,
      });
    }
    const spec = parsed.data;

    // 沙箱住哪归 runner 管：local 放宿主机临时目录，wsl 放 Linux 文件系统
    const root = this.#runner.allocate();
    const paths = createSandbox(root);
    // 记录仓放在沙箱**同级**的隐藏目录 —— 与工作树同一个文件系统，
    // 但不在 workspace 内，所以 agent 看不到（S1 布局的同一条理由）
    // ★ 传给 git 的路径必须是**运行环境内**的：git 在 WSL 里跑，
    //   收到宿主机 UNC 路径会直接失败（真跑 WSL 的测试第一次就撞到了）
    const observer = {
      gitDir: this.#runner.toInner(paths.record),
      workTree: this.#runner.toInner(paths.workspace),
    };
    const exec = (argv: readonly string[], cwd: string): string => this.#runner.exec(argv, cwd);
    const canObserve = gitAvailable(exec, observer.workTree);

    const abort = new AbortController();
    this.#inflight.set(request.executionId, abort);

    try {
      writeContext(paths, {
        ...spec.context,
        // 变量以 JSON 落盘：批 P 的 profile 渲染器会把它铺成各家认识的形态
        "vars.json": `${JSON.stringify(request.vars, null, 2)}\n`,
      });
      writeRequest(paths, {
        executionId: request.executionId,
        traceid: request.traceid,
        nodeId: request.nodeId,
        allowedEmitPorts: request.outputContract.allowedEmitPorts,
        limits: request.limits,
        emitPath: ".hertaloy/emit.json",
        artifactsDir: ".hertaloy/artifacts",
      });
      if (canObserve) initObserver(observer, exec);

      const outcome = await this.#runner.run({
        // 只挂 box —— 记录仓在它外面，agent 够不着（见 layout.ts）
        root: paths.box,
        argv: spec.argv,
        env: spec.env,
        signal: abort.signal,
        ...(request.limits.wallClockSeconds === undefined
          ? {}
          : { timeoutSeconds: request.limits.wallClockSeconds }),
      });

      // 快照按 executionId 命名 —— 与 ExecutionRecord、<traceid>/$exec 对得上
      const observation = canObserve ? observe(observer, exec, request.executionId) : undefined;
      const emitted = readEmit(paths);
      const artifacts = collectArtifacts(paths).map((a) => ({
        object_id: a.name.replace(/\.[^./]+$/, ""),
        kind: "artifact",
        body: { text: a.content } as never,
        derived_from: [] as never,
      }));

      const diagnostics: SandboxDiagnostics = {
        runner: this.#runner.kind,
        isolates: this.#runner.isolates,
        networkEnforced: this.#runner.enforcesNetwork,
        exitCode: outcome.code,
        stdoutTail: tail(outcome.stdout),
        stderrTail: tail(outcome.stderr),
        ...(observation === undefined ? {} : { observation }),
      };

      const termination = classify(outcome, emitted);
      if (termination !== "DONE") {
        return this.#fail(request, termination, diagnostics, outcome);
      }

      return {
        executionId: request.executionId,
        emissions: emitted as Readonly<Record<string, never>>,
        artifacts,
        usage: {
          inTokens: 0,
          outTokens: 0,
          costUsd: 0,
          wallClockSeconds: outcome.wallClockSeconds,
          toolCalls: 0,
          compactions: 0,
        },
        termination: "DONE",
        diagnostics: diagnostics as never,
      };
    } finally {
      this.#inflight.delete(request.executionId);
      if (this.#cleanup) this.#runner.release(root);
    }
  }

  /** best effort —— 气密性靠 generation fence，不靠这个（不变量 L3）。 */
  async cancel(executionId: string): Promise<void> {
    this.#inflight.get(executionId)?.abort();
  }

  #fail(
    request: ExecutionRequest,
    termination: Termination,
    diagnostics: SandboxDiagnostics,
    outcome?: RunOutcome,
  ): ExecutionResult {
    return {
      executionId: request.executionId,
      emissions: {},
      termination,
      usage: {
        inTokens: 0,
        outTokens: 0,
        costUsd: 0,
        wallClockSeconds: outcome?.wallClockSeconds ?? 0,
        toolCalls: 0,
        compactions: 0,
      },
      diagnostics: diagnostics as never,
    };
  }
}

/**
 * 退出码 → 终止原因（§14.6）。判据仍是**"重试会不会有不同结果"**。
 *
 * | 情形 | 终止 | 为什么 |
 * |---|---|---|
 * | 被取消 | `CANCELLED` | 是意图，重试无意义 |
 * | 超时被杀 | `BUDGET` | 是限额意图，不是故障 |
 * | 退出码非 0 | `FAILED` | 真故障（崩溃、依赖缺失），换一次可能就好 |
 * | 退出 0 但没写 emit.json | `INVALID_OUTPUT` | 没按契约输出，换一次采样可能就对 |
 */
function classify(outcome: RunOutcome, emitted: unknown | null): Termination {
  if (outcome.cancelled) return "CANCELLED";
  if (outcome.timedOut) return "BUDGET";
  if (outcome.code !== 0) return "FAILED";
  if (emitted === null || typeof emitted !== "object" || Array.isArray(emitted)) {
    return "INVALID_OUTPUT";
  }
  return "DONE";
}

function tail(text: string, limit = 2000): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}
