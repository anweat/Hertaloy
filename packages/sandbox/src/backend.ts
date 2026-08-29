/**
 * 沙箱 backend —— 把契约目录 + 运行器 + git 观察组装成 `ExecutionBackend`。
 *
 * 对应 FOUNDATION_V5.md §14。内核那侧一行不用改：`agentSpec` 早就是
 * `JsonObject`（不透明），换里面装什么都不影响编排面。
 *
 * 一次执行 = 建沙箱 → 注入 → 打基线 → **跑一条命令行** → 读 emit → 观察 → 收产物 → 拆沙箱。
 */

import { join } from "node:path";
import { z } from "zod";
import { AgentSpec, MASK, SECRET_PATTERNS, resolveEnv } from "@nodeflow/contracts";
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
import {
  type ProvisionedWorkspace,
  type ResourceRegistry,
  inheritWorkspace,
  provisionResources,
  provisionWorkspace,
} from "./resources.js";

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
  /**
   * 沙箱保留策略。默认 **always** —— 留着。
   *
   * 跑完就删的代价是：多开 agent 时谁也看不到现场，失败了没法查，
   * 产出也取不回来（工作树没了，`git fetch` 无从谈起）。
   *
   * **代价要说清**：留着就会一直涨，而对象回收目前**没有设计路径**。
   * 所以沙箱位置会写进执行观测对象，`hertaloy status` 报出保留了几个 ——
   * 至少让人看得见自己在攒什么，而不是在磁盘里悄悄堆。
   */
  readonly retain?: RetainPolicy;
  /** @deprecated 用 `retain` 。`cleanup: false` 等价于 `retain: "always"`。 */
  readonly cleanup?: boolean;
  /**
   * 资源别名注册表。模板只写名字，这里说名字指向哪。
   *
   * 不给就等于没有任何资源可用 —— 声明了 `workspace` 的模板会失败并说清
   * 已配置哪些名字。默认空表而不是"随便什么路径都行"，是第一不变量的
   * 同一条纪律：**能用的东西必须是显式给出来的**。
   */
  readonly resources?: ResourceRegistry;
}

/** 什么时候留沙箱。 */
export type RetainPolicy = "always" | "on-failure" | "never";

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
  /** 工作区从哪个具名源、哪个 commit 起的 —— 让"从哪开始的"可复查。 */
  readonly workspace?: ProvisionedWorkspace;
  /**
   * 沙箱在哪、留没留下。
   *
   * 放进 diagnostics 而不是新开一张"沙箱表"：diagnostics 已经会落成
   * `<traceid>/$exec` 对象（§17.14），于是"哪次执行对应哪个沙箱"由**版本层**
   * 回答，不需要第二处记账。
   */
  readonly sandbox?: { readonly path: string; readonly retained: boolean };
  /**
   * 这一次**实际生效**的能力。
   *
   * 声明在模板上（`AgentSpec.capabilities`），但生效值可能来自 backend 缺省 ——
   * 事后要能回答"它当时到底能不能上网"，所以记的是生效值不是声明值。
   */
  readonly capabilities?: {
    readonly network: string;
    readonly wallClockSeconds?: number;
  };
}

export class SandboxBackend implements ExecutionBackend {
  readonly #runner: Runner;
  readonly #retain: RetainPolicy;
  readonly #resources: ResourceRegistry;
  /**
   * `<traceid>/<节点>` → 那次执行的工作区路径。
   *
   * backend 自己记账，不扫目录：WSL 的沙箱住在 Linux 文件系统里，
   * 宿主机扫不到。记账对三种运行器一视同仁。
   * 键里含 traceid ⇒ **命名空间限定是天然的**，查不到兄弟实例的。
   */
  readonly #workspaces = new Map<string, string>();
  readonly #inflight = new Map<string, AbortController>();

  constructor(options: SandboxOptions = {}) {
    this.#runner = options.runner ?? new LocalRunner(options.workRoot);
    // cleanup 是旧名字：true 意为"跑完就删"，等价于 never
    this.#retain = options.retain ?? (options.cleanup === true ? "never" : "always");
    this.#resources = options.resources ?? {};

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

    /**
     * 沙箱住哪归 runner 管；**叫什么由这里定**。
     *
     * id 带上 traceid，因为 executionId 每个 Runtime 都从 exec-1 起 ——
     * 沙箱跑完即删时无所谓，留着就会在共享目录里真的撞名。
     */
    /**
     * id 里带上**节点名**，因为"接过上游工作区"要靠它找人（见 inheritWorkspace）。
     * 顺带 traceid 在前 —— 于是搜索前缀天然把范围限定在自己的命名空间内。
     */
    const root = this.#runner.allocate(
      `${request.traceid}/${request.nodeId}/${request.executionId}`,
    );
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

    // finally 里要按结果决定留不留，所以结果得先记下来。
    // 默认按失败算：走到异常路径时现场更值得留。
    let termination: Termination = "FAILED";

    try {
      /**
       * 物化在打基线**之前** —— 否则仓库内容会被算成 agent 的改动。
       * 顺序：物化 → 渲染 → 基线 → 跑 → 观察，于是 diff 里只剩 agent 干的事。
       */
      const profile = resolveProfile(spec.profile);
      let workspace: ProvisionedWorkspace | undefined;
      let placed: Readonly<Record<string, string>> = {};
      try {
        if (spec.workspace?.from !== undefined) {
          const key = `${request.traceid}/${spec.workspace.from}`;
          workspace = inheritWorkspace(
            this.#workspaces.get(key) ?? "（上游还没跑过）",
            spec.workspace.from,
            paths.workspace,
          );
        } else if (spec.workspace?.source !== undefined) {
          workspace = provisionWorkspace(
            this.#resources,
            { source: spec.workspace.source, base: spec.workspace.base },
            paths.workspace,
          );
        }
        if (spec.resources !== undefined) {
          // 放哪由 profile 决定 —— 同一个别名在不同 agent 下展开成不同位置
          placed = provisionResources(this.#resources, spec.resources, paths.box, (k, a) =>
            profile.place(k, a),
          );
        }
      } catch (error) {
        // 别名配错是**配置错误**，重试不会有不同结果 —— 但内核的终止分类里
        // 没有"配置错误"这一档，所以落 FAILED，理由说清是配置问题。
        return this.#fail(request, "FAILED", {
          runner: this.#runner.kind,
          isolates: this.#runner.isolates,
          networkEnforced: this.#runner.enforcesNetwork,
          exitCode: null,
          stdoutTail: "",
          stderrTail: `资源物化失败：${(error as Error).message}`,
        });
      }

      /**
       * **路径一律相对 cwd（workspace）。**
       *
       * request.json 之前写的是 `.hertaloy/emit.json` —— 而 agent 的 cwd 是
       * `workspace/`，照着写就落到 `workspace/.hertaloy/emit.json`，
       * 而内核读的是 `box/.hertaloy/emit.json`。**照着契约做反而失败**：
       * 告诉 agent 的话本身是错的，比没说更糟。
       */
      const emitPath = "../.hertaloy/emit.json";
      const artifactsDir = "../.hertaloy/artifacts";

      writeContext(paths, {
        ...spec.context,
        "vars.json": `${JSON.stringify(request.vars, null, 2)}\n`,
      });
      writeRequest(paths, {
        executionId: request.executionId,
        traceid: request.traceid,
        nodeId: request.nodeId,
        allowedEmitPorts: request.outputContract.allowedEmitPorts,
        limits: request.limits,
        emitPath,
        artifactsDir,
        /**
         * **网络与隔离如实告诉 agent。**
         *
         * 原生 agent 要据此决定行为：出网被挡住时就别去装依赖、别去查文档，
         * 直接说"这个我拿不到"比试半天超时好。外部 CLI 也一样受益 ——
         * 它们至少能在提示里读到。
         */
        environment: {
          networkEnforced: this.#runner.enforcesNetwork,
          isolates: this.#runner.isolates,
          runner: this.#runner.kind,
        },
        /** 别名 → 实际落点。原生 agent 直接照这个去读，不必猜。 */
        resources: placed,
      });

      /**
       * **profile 渲染 —— 这是「适配」的全部内容**（§14.3）。
       *
       * 此前 `resolveProfile` 被 import 了却从没调用：`spec.profile` 声明了、
       * 校验了、给了默认值，然后完全没有效果 —— claude-code 拿不到 CLAUDE.md、
       * codex 拿不到 AGENTS.md。与 K5 / E1 / MessageContract 同类：实现在，路不通。
       */
      const rendered = profile.render({
        vars: request.vars,
        allowedEmitPorts: request.outputContract.allowedEmitPorts,
        emitPath,
        artifactsDir,
        traceid: request.traceid,
        nodeId: request.nodeId,
        ...(workspace === undefined ? {} : { workspace }),
        limits: request.limits,
        resources: Object.entries(placed).map(([alias, rel]) => `${alias} → ${rel}`),
        observed: canObserve,
      });
      for (const [rel, content] of Object.entries(rendered)) {
        writeSandboxFile(paths, rel, content);
      }

      // 记下自己的工作区，好让下游节点接得过去
      this.#workspaces.set(`${request.traceid}/${request.nodeId}`, paths.workspace);

      if (canObserve) initObserver(observer, exec);

      /**
       * `$NAME` 在**这里**解析成真值 —— 一处解析，三个 runner 都拿到结果。
       * 放在 runner 里就得写三遍，而这正是"两端各自都绿、中间没人走"的温床。
       */
      const env = resolveEnv(spec.env, process.env);

      /**
       * 节点声明的能力优先于 backend 缺省 —— 声明在模板上的那条才是权威。
       * 没声明就沿用缺省，所以这是个纯增字段，老模板行为不变。
       */
      const caps = spec.capabilities;
      const timeout = caps?.wallClockSeconds ?? request.limits.wallClockSeconds;

      const outcome = await this.#runner.run({
        // 只挂 box —— 记录仓在它外面，agent 够不着（见 layout.ts）
        root: paths.box,
        argv: spec.argv,
        env,
        signal: abort.signal,
        ...(caps?.network === undefined ? {} : { network: caps.network }),
        ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
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
        // 脱敏在**进对象库之前** —— 对象不可变，写进去就撤不回来
        // 遮的是**解析后的真值** —— 遮 `$NAME` 那串字面量毫无意义
        stdoutTail: redact(tail(outcome.stdout), env),
        stderrTail: redact(tail(outcome.stderr), env),
        sandbox: {
          path: root,
          retained: keeps(caps?.retain ?? this.#retain, classify(outcome, emitted)),
        },
        // 实际生效的能力也写进 diagnostics —— 事后要能回答"它当时能上网吗"
        capabilities: {
          network: caps?.network ?? this.#runner.kind,
          ...(timeout === undefined ? {} : { wallClockSeconds: timeout }),
        },
        ...(workspace === undefined ? {} : { workspace }),
        ...(observation === undefined ? {} : { observation }),
      };

      termination = classify(outcome, emitted);
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
      if (!keeps(this.#retain, termination)) this.#runner.release(root);
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
 * 脱敏 —— **进不可变对象库之前的最后一道**。
 *
 * `stdoutTail` / `stderrTail` 会随 diagnostics 落成 `<traceid>/$exec` 对象，
 * 而对象是不可变、内容寻址、按前缀可读的：**一旦写进去就撤不回来**。
 * agent 打印一次 `echo $API_KEY`，那份密钥就永久留在审计记录里了。
 *
 * 主手段是**精确遮蔽已注入的凭据**：我们清楚知道往沙箱里塞了哪些 env 值，
 * 所以能一个不漏地遮掉。这是允许清单式的确定性，不是猜。
 *
 * 附带几条常见格式的模式匹配（`sk-…`、`Bearer …`），但要说清它是
 * **尽力而为**：黑名单永远漏得掉，密钥命名千奇百怪。真正的保证来自
 * 第一条 —— 以及"密钥只经 env 注入、不落任何配置文件"（§17.7）。
 */

export function redact(text: string, injected: Readonly<Record<string, string>>): string {
  let out = text;
  // 精确遮蔽：我们注入了什么，就一定遮得掉什么
  for (const value of Object.values(injected)) {
    if (value.length < 8) continue; // 太短的多半不是凭据，遮了反而毁可读性
    out = out.split(value).join(MASK);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

/** 这次跑完之后留不留沙箱。 */
function keeps(policy: RetainPolicy, termination: Termination): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return termination !== "DONE";
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
