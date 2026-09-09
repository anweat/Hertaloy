/**
 * 面向**人**的命令 —— 查状态、看资产、投消息。
 *
 * 与 `commands.ts` 里的 `validate` / `run` 的分界：那两条是一次性的、进程内的；
 * 这些全部作用在**磁盘上的 run**（§17）。持久化之前这些命令根本无从谈起 ——
 * "查一个正在跑的容器的状态"要求状态活得比进程久。
 *
 * **审批不是一条独立机制**（第四次归约）：等待就是阻塞锁，放行就是往它等的
 * 那个端点投一条消息。所以这里没有 `approve` 的专用状态机，只有
 * `status` 让人看见谁在等、`send` 让人放行。多一套审批状态机就是多一份要对齐的真相。
 *
 * **每条命令都过 `ControlPlane`**，不直连 `Runtime`。此前是直连的 —— 于是
 * "人有完整权限"成立的原因是**根本没有权限检查**，而不是授权对了。
 * `actor` 由 `--as` 注入，默认 `human:local`；绝不从载荷里取（§11.3）。
 */

import {
  DockerRunner,
  LocalRunner,
  WslRunner,
  checkAgentSpec,
  readJournal,
  sandboxPaths,
  type JournalEntry,
  type Runner,
} from "@nodeflow/sandbox";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { headPath } from "@nodeflow/state";
import { join } from "node:path";
import {
  buildScene,
  diffScenes,
  emptyScene,
  isEmptyDelta,
  parseSnapshot,
  type Scene,
} from "@nodeflow/scene";
import {
  RunState,
  StateLock,
  lockHolders,
  releaseHeldLocks,
  addResource,
  exportSnapshot,
  loadResources,
  permissionsPath,
  removeResource,
  resourcesPath,
  writePermissions,
} from "@nodeflow/state";
import type { ExecutionBackend } from "@nodeflow/contracts";
import {
  containerOf,
  formatEndpoint,
  parentTrace,
  isOverlay,
  type Json,
  type Principal,
} from "@nodeflow/contracts";
import { AuthorizationError, execLog } from "@nodeflow/kernel";
import { BUILTIN_HANDLERS, BUILTIN_NAMES } from "./builtins.js";
import { Scenario } from "./scenario.js";

export interface CommandResult {
  readonly text: string;
  readonly code: number;
  /**
   * 机器可读的那一份。**加 `--json` 时打印它而不是 `text`。**
   *
   * 为什么两份都要：`text` 是给人看的（对齐、缩进、中文说明），
   * `data` 是给流程看的 —— 一条 hertaloy 流程要能驱动另一个 run 时，
   * 它读的是这个。把 `text` 拿去 parse 是最脆的接口，任何措辞调整都会打断它。
   *
   * 不给 `data` 的命令在 `--json` 下退出码 2 并说清楚，不悄悄打印空对象。
   */
  readonly data?: Json;
}

/** drain 的交替轮次上限。到顶不代表完成 —— 见 drain 里的 converged。 */
const MAX_ROUNDS = 100;

const ok = (text: string, data?: Json): CommandResult =>
  data === undefined ? { text, code: 0 } : { text, code: 0, data };
const fail = (text: string, data?: Json): CommandResult =>
  data === undefined ? { text, code: 1 } : { text, code: 1, data };

/** 只读打开：不拿目录锁，所以能在写进程跑着的时候查（§17.8）。 */
function readOnly(dir: string, fn: (s: RunState) => CommandResult): CommandResult {
  const state = RunState.open(dir, { readOnly: true, validateExecutionSpec: checkAgentSpec });
  try {
    return guard(() => fn(state));
  } finally {
    state.close();
  }
}

/**
 * 授权失败要变成**退出码 1 加一句人话**，不是一个栈。
 *
 * `PermissionTable.decide` 的拒绝理由里已经列了当前授权，所以这里原样透出 ——
 * 人看得见"缺什么"，才改得动 permissions.json。
 */
function guard(fn: () => CommandResult): CommandResult {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(`拒绝：${error.message}`);
    throw error;
  }
}

function writable(dir: string, fn: (s: RunState) => CommandResult): CommandResult {
  const state = RunState.open(dir, { validateExecutionSpec: checkAgentSpec });
  try {
    const result = guard(() => fn(state));
    if (result.code === 0) state.persist();
    return result;
  } finally {
    state.close();
  }
}

/**
 * 容器状态：实例树 + 阻塞原因 + 在途消息。
 *
 * 阻塞原因是这条命令的重点 —— 人要能一眼看出"卡在哪、在等谁"，
 * 否则唯一的排查手段就是读日志猜。
 */
export function status(dir: string, actor: Principal): CommandResult {
  return readOnly(dir, (s) => {
    const root = s.registry.rootTrace;
    if (root === null) {
      return ok("空状态：还没有根容器。", {
        root: null,
        permissions: s.permissions.source,
        instances: [],
        queued: [],
        claimed: [],
        running: [],
        deadlocks: [],
        retainedSandboxes: 0,
      } as never);
    }

    const control = s.control;
    const lines: string[] = [
      `run ${root}（${s.dir}）`,
      `主体 ${actor.kind}:${actor.id}　权限表 ${
        s.permissions.source === "file" ? "permissions.json" : "缺省（人类全权，agent 无权）"
      }`,
      "",
    ];
    lines.push("实例树：");
    for (const inst of control.subtree(actor, root)) {
      const depth = inst.traceid.split("/").length - root.split("/").length;
      const blockers = control.blockers(actor, inst.traceid);
      lines.push(
        `${"  ".repeat(depth + 1)}${inst.traceid}  ${inst.status}  ` +
          `seq=${inst.seq} gen=${inst.generation}` +
          (inst.slot === undefined ? "" : `  槽=${inst.slot}`) +
          (blockers.length > 0 ? `\n${"  ".repeat(depth + 2)}↳ 阻塞：${blockers.join("；")}` : ""),
      );
    }

    /**
     * 义务与消息按**子树**汇总，不是只看根。
     *
     * 之前只统计 root 自己持有的锁、以及 `target.traceid === root` 的消息 ——
     * 于是子实例卡住时，status 照样显示"阻塞锁 0、在途消息 0"。
     * 一个只在根节点出问题时才说真话的状态命令，比没有更糟。
     */
    const subtree = control.subtree(actor, root);
    const obligations = subtree.flatMap((i) => control.obligations(actor, i.traceid));
    /**
     * 「阻塞锁」是**给人看的词**，不是第二种类型。
     *
     * 内核那侧的 `Lock` 已经删了 —— 它是同一批事实的第二套词汇（滤掉两种
     * kind、另发一个没人读的 id 与 since），而"两份拷贝必然漂移"正是当初
     * 删掉锁账本的理由。词汇留在渲染这一层，判据回到事实本身：
     * **有 `waitingOn` 就是在等别人**，没有就是自己还在跑。
     */
    const waiting = obligations.filter((o) => o.waitingOn !== undefined);
    lines.push("", `阻塞锁 ${waiting.length} 把：`);
    for (const o of waiting) {
      lines.push(`  ${o.kind}  持有者=${o.holder}  键=${o.key}  等待=${String(o.waitingOn)}`);
    }

    const inbox = subtree.flatMap((i) => control.messages(actor, i.traceid));
    const pending = inbox.filter((m) => m.state === "QUEUED");
    const claimed = inbox.filter((m) => m.state === "CLAIMED");
    lines.push("", `在途消息 ${pending.length} 条（另有 ${claimed.length} 条已被 claim）：`);
    for (const m of [...pending, ...claimed]) {
      lines.push(
        `  ${m.state === "CLAIMED" ? "⟳" : "→"} ${formatEndpoint(m.target)}`,
      );
    }
    // `$exec` 挂在执行位点自己名下（V6：节点有自己的对象命名空间），所以按位点枚举
    const execs = subtree.flatMap((i) =>
      s.registry.sites(i.traceid).flatMap((site) => s.store.history(execLog(site))),
    );
    let retained = 0;
    if (execs.length > 0) {
      // 「执行」而不是「观测」：V6 阶段 5 之后每次执行都留一版，
      // 而 `diagnostics`（观测）是可选的 —— 同步执行就没有。
      lines.push("", `执行 ${execs.length} 次（\`show <traceid>/<节点>/$exec\` 看详情）：`);
      for (const v of execs) {
        const d = ((v.body as Record<string, unknown>).diagnostics ?? {}) as {
          sandbox?: { retained?: boolean };
        };
        if (d.sandbox?.retained === true) retained += 1;
      }
      for (const v of execs.slice(-5)) {
        const b = v.body as Record<string, unknown>;
        const d = (b.diagnostics ?? {}) as Record<string, unknown>;
        const obs = (d.observation ?? {}) as { changes?: unknown[] };
        const box = (d.sandbox ?? {}) as { path?: string; retained?: boolean };
        lines.push(
          // 位点从对象 id 读（`<位点>/$exec`），不从正文 —— 正文里已经没有第二份了
          `  ${String(b.execution_id)}  ${parentTrace(v.object_id) ?? v.object_id}  ` +
            `${String(b.termination)}` +
            (obs.changes === undefined ? "" : `  改动 ${obs.changes.length} 个文件`) +
            (box.retained === true ? `
      沙箱 ${String(box.path)}` : ""),
        );
      }
      if (retained > 0) {
        // 留着的沙箱会一直涨，而回收目前没有设计路径 —— 与其悄悄堆，不如报出来
        lines.push(`  ★ 保留中的沙箱 ${retained} 个，需要时手工删除（暂无自动回收）`);
      }
    }

    const running = subtree.flatMap((i) =>
      control.records(actor, i.traceid).filter((r) => r.status === "RUNNING"),
    );
    if (running.length > 0) {
      lines.push("", `在跑的 execution ${running.length} 个：`);
      for (const r of running) lines.push(`  ${r.executionId}  ${r.instance}`);
    }

    /**
     * 目录锁 —— **一把残留的 `driver.lock` 会让整个 run 推不动**，
     * 而在此之前它在任何输出里都看不见，只能靠人想起来去 ls 目录。
     * 它不是内核的锁（那些是义务的投影），是操作系统层面的进程排他。
     */
    const dirLocks = lockHolders(s.dir);
    if (dirLocks.length > 0) {
      lines.push("", "目录锁（进程排他，不是容器的阻塞态）：");
      for (const l of dirLocks) {
        lines.push(
          `  ${l.name}  持有者 ${l.pid === null ? "（读不出）" : `pid ${String(l.pid)}`}` +
            (l.since === null ? "" : `，自 ${l.since}`) +
            (l.name === "driver.lock"
              ? "\n    ↳ 推进权被它占着。确认那个进程确实没了，再删这个文件"
              : ""),
        );
      }
    }

    // 按作用域裁剪后再找环 —— 此前这里直连 runtime，不授权也不裁剪
    const deadlocks = control.deadlocks(actor);
    if (deadlocks.length > 0) {
      lines.push("", "★ 死锁环：");
      for (const cycle of deadlocks) lines.push(`  ${cycle.join(" → ")}`);
    }
    return ok(lines.join("\n"), {
      root,
      permissions: s.permissions.source,
      dirLocks: dirLocks.map((l) => ({ name: l.name, pid: l.pid, since: l.since })),
      /**
       * `data` 里给**结构化**义务，中文那份只留在 `text` 里。
       *
       * 原来两边都是 `blockers` 的中文字符串 —— 而那是给人看的渲染，
       * 不该被当成机器协议（审核指出）。结构化的形式不是缺的东西：
       * `Obligation` 本来就是 `{kind, holder, waitingOn, key, originNode}`，
       * 缺的只是带授权的出口，现在补上了。
       */
      instances: subtree.map((i) => ({
        traceid: i.traceid,
        status: i.status,
        seq: i.seq,
        generation: i.generation,
        blockers: control.obligations(actor, i.traceid).map((o) => ({
          kind: o.kind,
          key: o.key,
          ...(o.waitingOn === undefined ? {} : { waitingOn: o.waitingOn }),
          ...(o.originNode === undefined ? {} : { originNode: o.originNode }),
        })),
      })),
      queued: pending.map((m) => ({ id: m.id, ...m.target })),
      claimed: claimed.map((m) => ({ id: m.id, ...m.target })),
      running: running.map((r) => ({ executionId: r.executionId, instance: r.instance })),
      deadlocks: deadlocks.map((c) => [...c]),
      retainedSandboxes: retained,
    } as never);
  });
}

/** 读一个对象。`id` 取最新版，`id@N` 取指定版。 */
export function show(dir: string, actor: Principal, ref: string): CommandResult {
  return readOnly(dir, (s) => {
    const at = ref.lastIndexOf("@");
    try {
      const version = at === -1 ? s.control.head(actor, ref) : s.control.read(actor, ref);
      return ok(JSON.stringify(version, null, 2), version as never);
    } catch (error) {
      return fail(error instanceof AuthorizationError ? `拒绝：${error.message}` : (error as Error).message);
    }
  });
}

/**
 * 一次执行的详情 —— 从节点追到失败、观测与产物。
 *
 * 四种"没有"分开表达（审核要求）：
 *
 *   无权          `拒绝：…`，理由照抄授权表的说明
 *   从来没有过     `没有 execution …`
 *   有过但没采集   记录在，`observation` 缺席并说明为什么
 *   有过但已回收   沙箱那侧由 `retained` 与实际存在与否共同回答
 *
 * 无权与"没有"分不出来是**有意的**：否则存在性本身成了泄漏面（见
 * `ControlPlane.execution` 的说明）。
 */
/**
 * 只为**定位**沙箱而造的 runner —— 不起执行面。
 *
 * 观察方要看执行中的现场，就得算出沙箱在哪；而沙箱路径是 id 的确定性函数
 * （`locate`）。所以只需要知道当初用的是哪个 runner、workRoot 在哪，
 * 不需要任何上报通道 —— 那条通道要跨进程就得再落一份盘，而它要落的内容
 * 恰好是这里能算出来的。
 *
 * **配不上就如实说读不到**，不能显示成"没有内容"。
 */
function locator(kind: string | undefined, dir: string): Runner | undefined {
  if (kind === undefined) return undefined;
  const workRoot = join(dir, "sandboxes");
  if (kind === "local") return new LocalRunner(workRoot);
  if (kind === "wsl") return new WslRunner();
  if (kind === "docker") return new DockerRunner({ workRoot });
  return undefined;
}

/** 一条 journal 记录压成一行 —— 长的截断，别让一条大输出把整个答复撑爆。 */
function summarize(entry: JournalEntry): string {
  const { seq: _seq, op: _op, ...rest } = entry;
  const text = JSON.stringify(rest);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** 执行中的现场：agent 到这一刻为止都干了什么。窗口不是全量。 */
const LIVE_WINDOW = 20;

function liveJournal(
  runner: Runner | undefined,
  record: { instance: string; executionId: string },
): { readonly available: false; readonly why: string } | { readonly available: true; readonly entries: readonly JournalEntry[] } {
  if (runner === undefined) {
    return {
      available: false,
      why: "要看执行中的现场得知道用的哪个 runner —— 加 --runner local|wsl|docker",
    };
  }
  try {
    const root = runner.locate(`${record.instance}/${record.executionId}`);
    const paths = sandboxPaths(root);
    // readJournal 为结算容忍目录缺席；观察接口不能把缺席解释成空现场。
    readdirSync(paths.journal);
    const entries = readJournal(paths);
    return { available: true, entries: entries.slice(-LIVE_WINDOW) };
  } catch (error) {
    return { available: false, why: `读不到沙箱现场：${(error as Error).message}` };
  }
}

export function execution(
  dir: string,
  actor: Principal,
  executionId: string,
  runnerKind?: string,
): CommandResult {
  return readOnly(dir, (s) => {
    const record = s.control.execution(actor, executionId);
    // 从来没有过 —— 与"无权"分开：无权在上面就抛了（拒绝路径）
    if (record === undefined) return fail(`没有 execution ${executionId}`);

    // 观测：`<执行位点>/$exec` 的历史里找本次那一版
    const observation = s.control
      .history(actor, execLog(record.instance))
      .find((v) => (v.body as { execution_id?: string }).execution_id === executionId);

    /**
     * 本次提交的 `$run` —— 单列，不混进用户产物。
     *
     * 与 `$exec` 同理：它们是内核为这次执行写的记录，不是节点的产出。
     * 单列出来，页面点开就能读到 consumed / produced 的正文，
     * 而这正是 `Cell.result.commit` 曾经要解决的事 —— 现在它落在
     * 执行上，同步与 agent 走同一条路。
     */
    const container = containerOf(record);
    const internal = new Set([execLog(record.instance), `${container}/$run`]);
    const byExecution = s.store.appended(0).filter((v) => v.provenance.execution_id === executionId);
    const commit = byExecution.find((v) => v.object_id === `${container}/$run`);
    // 产物：provenance 记着是哪次执行写的 —— 不靠名字猜
    const artifacts = byExecution
      .filter((v) => !internal.has(v.object_id))
      .map((v) => ({ ref: `${v.object_id}@${String(v.version)}`, kind: v.kind }));

    /**
     * 执行中的现场 —— **重点不是进度数字，是它到这一刻在输出什么**。
     *
     * journal 本来就是那份过程观测：已经落在磁盘、一次工具调用一个文件、
     * 自带条数与字节上限。只读方去读它**完全在提交路径之外** ——
     * 观察失败不可能回滚提交，这是审核对 S5 的硬要求。
     */
    const live = record.status === "RUNNING" ? liveJournal(locator(runnerKind, dir), record) : null;

    const lines = [
      `${record.executionId}  ${record.instance}`,
      `  状态 ${record.status}${record.termination === undefined ? "" : ` · ${record.termination}`}` +
        `  generation ${String(record.generation)}`,
      `  消费的消息：${record.claimed.join("、") || "（无）"}`,
      observation === undefined
        ? "  观测：未采集（这次执行没有留下 $exec —— backend 没给 diagnostics）"
        : `  观测：${execLog(record.instance)}@${String(observation.version)}（\`show\` 看详情）`,
      commit === undefined
        ? "  提交：未记录（这次执行没有留下 $run）"
        : `  提交：${container}/$run@${String(commit.version)}（\`show\` 看 consumed / produced）`,
      `  产物 ${String(artifacts.length)} 个${artifacts.length === 0 ? "" : `：${artifacts.map((a) => a.ref).join("、")}`}`,
      ...(live === null
        ? []
        : live.available
          ? [
              `  现场（最近 ${String(LIVE_WINDOW)} 条）：`,
              ...(live.entries.length === 0
                ? ["    （还没有输出）"]
                : live.entries.map((e) => `    #${String(e.seq)} ${e.op}  ${summarize(e)}`)),
            ]
          : [`  现场：${live.why}`]),
    ];
    return ok(lines.join("\n"), {
      execution: {
        executionId: record.executionId,
        instance: record.instance,
        status: record.status,
        ...(record.termination === undefined ? {} : { termination: record.termination }),
        generation: record.generation,
        claimed: [...record.claimed],
        ...(record.usage === undefined ? {} : { usage: record.usage }),
      },
      observation:
        observation === undefined
          ? { available: false, why: "未采集：这次执行没有留下 $exec" }
          : { available: true, ref: `${execLog(record.instance)}@${String(observation.version)}` },
      ...(commit === undefined
        ? {}
        : { commit: `${container}/$run@${String(commit.version)}` }),
      artifacts,
      ...(live === null ? {} : { live }),
    } as never);
  });
}

/**
 * 一条消息的详情 —— 端点、尝试、失败原因、因果。
 *
 * `failure` 与 `attempts` 是**历史痕迹**：一条重试后成功的消息仍然留着上次的
 * 失败说明。所以这里把「当前状态」与「历史失败」分成两个字段，
 * 而不是把 failure 直接当成当前结论（审核特别点名的那条）。
 */
export function message(dir: string, actor: Principal, messageId: string): CommandResult {
  return readOnly(dir, (s) => {
    const m = s.control.message(actor, messageId);
    if (m === undefined) return fail(`没有消息 ${messageId}`);
    let causes: readonly string[] = [];
    let causesUnavailable: string | undefined;
    try { causes = s.control.causesOf(actor, s.registry.rootTrace ?? messageId, messageId); }
    catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      causesUnavailable = "完整因果查询需要根作用域读取权";
    }
    const settled = m.state !== "QUEUED" && m.state !== "CLAIMED";
    const lines = [
      `${m.id}  →  ${formatEndpoint(m.target)}`,
      `  状态 ${m.state}${m.attempts > 0 ? `  已试 ${String(m.attempts)} 次` : ""}`,
      m.source === undefined
        ? "  来源：图外（人 / CLI 投的）"
        : m.source.port === undefined
          ? `  来源：实例 ${m.source.instance} 的生命周期信号`
          : `  来源：${m.source.instance}.${m.source.port}`,
      ...(m.failure === undefined
        ? []
        : [`  历史失败：${m.failure}${settled ? "" : "（当前仍在途 —— 这是上一次尝试留下的）"}`]),
      causesUnavailable === undefined
        ? `  由 ${causes.length} 条消息导致${causes.length === 0 ? "" : `：${causes.join("、")}`}`
        : `  因果不可用：${causesUnavailable}`,
    ];
    return ok(lines.join("\n"), {
      message: {
        id: m.id,
        target: m.target,
        state: m.state,
        attempts: m.attempts,
        ...(m.source === undefined ? {} : { source: m.source }),
        ...(m.alias === undefined ? {} : { alias: m.alias }),
        ...(m.requestId === undefined ? {} : { requestId: m.requestId }),
      },
      // 与当前状态分开 —— 重试成功之后它仍然在，但它说的是上一次
      ...(m.failure === undefined ? {} : { lastFailure: m.failure }),
      payload: m.payload,
      causes: [...causes],
      ...(causesUnavailable === undefined ? {} : { causesUnavailable }),
    } as never);
  });
}

/**
 * 场景导出 —— **观测这条链此前唯一缺的那一段**。
 *
 * `exportSnapshot`（state）与 `buildScene`（scene）都早就写好了，但：
 * 前者**零个调用方**，后者只被自己的测试调用，输入还是一份定格夹具。
 * 于是整条链两端各自都绿，中间没人走 —— 前端要开工，第一件事恰恰是从这个
 * 不存在的出口拿数据。
 *
 * 输出的是 `Scene` 而不是 `RunSnapshot`：快照是中间步骤，渲染器要的是场景。
 * 只给一种，不给"UI 格式 / API 格式"两套（那是明确不学的做法）。
 *
 * `parseSnapshot` 在这里**不是多余的一步**：它拿 zod 去验我们自己刚导出的东西。
 * 导出端的形状一旦和 scene 收的形状分家，这条命令当场炸 —— 而在此之前，
 * 那种漂移是静默的（夹具是定格的，两端各自演化谁也不知道）。
 */
export function scene(dir: string, actor: Principal, scope?: string): CommandResult {
  return readOnly(dir, (s) => {
    const built = buildScene(parseSnapshot(exportSnapshot(s, actor, scope)), scope);
    return ok(JSON.stringify(built, null, 2), built as never);
  });
}

/** 算一帧场景。watch 与一次性导出走的是同一条路，不给两套。 */
function sceneOf(dir: string, actor: Principal, scope?: string): Scene {
  const state = RunState.open(dir, { readOnly: true, validateExecutionSpec: checkAgentSpec });
  try {
    return buildScene(parseSnapshot(exportSnapshot(state, actor, scope)), scope);
  } finally {
    state.close();
  }
}

/**
 * 持续输出场景差量（NDJSON，一行一帧）。
 *
 * ## 为什么是轮询，不是订阅
 *
 * 内核有 `CommitHook`，覆盖生命周期转移（commit/claim/apply/settle/truncate）——
 * 但它在**写进程内**触发。前端是另一个进程，**收不到**。照着"订阅事件"去设计
 * 会做出一个跨进程根本收不到的东西。
 *
 * 所以这里盯 `head.json` 的 mtime + size：它每次提交全量重写，变了就说明有事
 * 发生。这个门很便宜 —— 没变就连状态目录都不打开。
 *
 * ## 只读打开，不抢锁
 *
 * `readOnly` 不拿目录锁、不写授权日志（§17.8 的单写者纪律）。看的人再多也
 * 不影响跑的那个进程。
 *
 * ## 一种形状
 *
 * 第一帧是**与空场景的差量**，不是"全量帧" —— 流上只有一种消息。
 * 没有变化的轮次一个字都不输出，这就是"减少占用"的落点。
 */
export async function watchScene(
  dir: string,
  actor: Principal,
  scope: string | undefined,
  intervalMs: number,
  emit: (line: string) => void,
  stop?: AbortSignal,
): Promise<void> {
  let previous = emptyScene(scope ?? "");
  let stamp = "";

  const tick = (): void => {
    const head = headPath(dir);
    if (!existsSync(head)) return;
    const st = statSync(head);
    const now = `${st.mtimeMs}:${st.size}`;
    if (now === stamp) return; // 头没动 —— 连目录都不必打开
    stamp = now;

    const next = sceneOf(dir, actor, scope);
    const delta = diffScenes(previous, next);
    previous = next;
    if (!isEmptyDelta(delta)) emit(JSON.stringify(delta));
  };

  tick(); // 先给一帧基线，别让人对着空屏等第一次变化
  while (stop === undefined || !stop.aborted) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stop?.aborted === true) break;
    tick();
  }
}

/**
 * 模板全文 —— **配置那一条流**。
 *
 * ## 为什么与场景分成两条
 *
 * 配置是**不可变**的（C4：实例创建时 pin 一份定义，永不迁移），而场景**每帧变**。
 * 把 servo、端口声明、agent 规格塞进场景，等于每帧重传永远不变的东西 ——
 * 正好毁掉 `--watch` 差量省下的那部分。
 *
 * 分开之后，C5 的两条性质直接兑现成一句话：**拉一次就够，缓存永不失效**。
 * `worker@1` 永远是那份内容（内容寻址 + 引用永远精确，V3/V4）。
 *
 * ## 不做二次编码
 *
 * 给的是模板**原样的正文**，不挑字段、不编枚举。端口是内网边还是网关、
 * 是 PUBLISH 还是 REQUEST，靠 `alias` / `callback` / `reply` 有没有来判 ——
 * 这是内核自己那条规则（见 `MessageSource`：「三种情形，靠字段有无区分，
 * 不需要标签」）。渲染器照抄同一条判定，而不是我们在中间再发明一套 `mode`
 * 枚举：那样第五种网关模式出现时要改三处，而且两处判定必然漂移。
 *
 * ## 授权
 *
 * 与场景同一条：模板**跟着实例走**（`exportSnapshot` 里 `control.subtree`
 * 已经判过）。模板住在 traceid 树之外的扁平命名空间，单独按对象名授权会把
 * `mid@1` 算成 `mid` 而误拒 —— 那个坑深度用例抓到过一次。
 */
export function templates(dir: string, actor: Principal, scope?: string): CommandResult {
  return readOnly(dir, (s) => {
    const all = exportSnapshot(s, actor, scope).templates;
    return ok(JSON.stringify(all, null, 2), all as never);
  });
}

/**
 * 授权决策流水 —— **人在这个 run 里做过什么**。
 *
 * `authz.jsonl` 一直在写（每次 ControlPlane 决策，放行与拒绝都记），但
 * **没有任何出口**：文件在长，没人读得出来。又一条两端各自都绿、中间没人走。
 *
 * 它是画布外那块"人的操作"面板要吃的东西。为什么不进场景：内核是纯引擎，
 * **它不知道谁在调它**（§11 —— Principal 由可信边界注入）。"谁投的这条消息"
 * 根本不在编排状态里，只在这份决策流水里。硬塞进 `RunSnapshot` 就是让
 * 观测格式去承担它答不出的问题（上一轮已经把那个 `audit` 字段删掉了）。
 *
 * 授权：按**根实例**判定 DQL。这份流水横跨整个 run，读得了它就等于读得了
 * 全局，所以门槛该是根，不是某个子树。`ControlPlane.check` 是公开的，
 * 注释里写着就是给"操作不在内核里、但决策必须在这儿做"的调用方用的。
 */
export function authz(dir: string, actor: Principal, limit = 50): CommandResult {
  return readOnly(dir, (s) => {
    const root = s.registry.rootTrace;
    if (root === null) return fail("这个目录里还没有根实例");
    s.control.check(actor, "DQL", root, "query");

    const entries = s.authzLog.recent(limit);
    if (entries.length === 0) return ok("（还没有决策记录）", [] as never);
    const lines = entries.map(
      (e) =>
        `${String(e.seq).padStart(4)}  ${e.allowed ? "放行" : "拒绝"}  ` +
        `${e.actor.padEnd(16)} ${e.op.padEnd(9)} ${e.target}` +
        (e.allowed ? "" : `\n        ${e.reason}`),
    );
    return ok(lines.join("\n"), entries as never);
  });
}

/** 一个对象的版本历史 —— C5 下这就是"这个东西经历了什么"。 */
export function history(dir: string, actor: Principal, objectId: string): CommandResult {
  return readOnly(dir, (s) => {
    const versions = s.control.history(actor, objectId);
    if (versions.length === 0) return fail(`没有对象 ${objectId}`);
    const lines = versions.map(
      (v) => `@${v.version}  ${v.kind}  ${v.content_hash.slice(0, 12)}  ${JSON.stringify(v.body)}`,
    );
    return ok([`${objectId}（${versions.length} 版）：`, ...lines].join("\n"), {
      objectId,
      versions: versions.map((v) => ({
        version: v.version,
        kind: v.kind,
        contentHash: v.content_hash,
        body: v.body,
      })),
    } as never);
  });
}

/**
 * 往运行中的实例投一条消息。
 *
 * **人的放行走这条**：某个 handler 注册了阻塞锁在等审批，人看完 `status`
 * 之后往它等的端点投消息，锁就销账了。不需要第二套审批机制。
 */
export function send(
  dir: string,
  actor: Principal,
  instance: string,
  port: string,
  payload: Json,
): CommandResult {
  return writable(dir, (s) => {
    // 地址是一段（V6 阶段 1b）：`job-1/plan` 就是节点自己，容器由它派生
    const target = { instance, port };
    const container = containerOf(target);
    if (!s.registry.has(container)) {
      return fail(`没有实例 ${container}。先跑 \`hertaloy status\` 看有哪些。`);
    }
    try {
      const id = s.control.send(actor, target, payload);
      return ok(`已投递 ${id} → ${formatEndpoint(target)}`, { messageId: id, target } as never);
    } catch (error) {
      return fail((error as Error).message);
    }
  });
}

/**
 * 推进到静止：drain + settle。
 *
 * **限制要说清**：CLI 只认得内置 handler。模板若引用了别的 handler 名，
 * 这条命令推不动它 —— 那种图得由宿主程序驱动。装作能推是更坏的。
 */
export async function drain(
  dir: string,
  actor: Principal,
  backend?: ExecutionBackend,
): Promise<CommandResult> {
  type Step = { instance: string; reason?: string; retrying?: boolean };
  const results: Step[] = [];
  let settled: readonly string[] = [];
  let converged = false;
  // 驱动权跨越锁外执行阶段；head.lock 仍只保护短暂的读改写。
  const driver = new StateLock(dir, "driver.lock");

  /**
   * 每一步都**重新开关状态目录**。
   *
   * 关键在于：跑 agent 时**不持锁**。此前 drain 开一次 RunState 就一直持有
   * `head.lock` 到跑完，于是 agent 挂死 = 锁被永久占住 = `truncate` 拿不到锁 ——
   * 刚承诺的"卡住的 run 杀得掉"当场失效（外部审核指出的 P0，属实）。
   *
   * 代价是频繁开关（每次都要读回对象库）。这是拿性能换控制面可用性，
   * 而控制面在 agent 挂死时不可用，等于没有控制面。
   */
  const withState = <T>(fn: (s: RunState) => T): T => {
    const state = RunState.open(dir, {
      validateExecutionSpec: checkAgentSpec,
      ...(backend === undefined ? {} : { backend }),
    });
    try {
      const out = fn(state);
      state.persist();
      return out;
    } finally {
      state.close();
    }
  };

  /**
   * 被信号打断时也要把锁放掉。
   *
   * `finally` 挡得住异常与正常返回，**挡不住信号** —— Node 收到没有监听器的
   * SIGINT 会直接终止进程，`finally` 不跑。而 `driver.lock` 跨越整个 agent 执行
   * （分钟级），Ctrl-C 恰好最可能发生在那段时间：残留的锁会让之后每次 drain
   * 都失败，而且**没有内建的清理出路**。
   *
   * 放完照常按信号的约定退出（130 / 143），不改变 Ctrl-C 的语义。
   * 处理器只在持锁期间挂着，`finally` 里摘掉 —— 不给进程留全局副作用。
   */
  const onSignal = (code: number) => () => {
    releaseHeldLocks();
    process.exit(code);
  };
  const sigint = onSignal(130);
  const sigterm = onSignal(143);

  try {
    mkdirSync(dir, { recursive: true });
    driver.acquire();
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    const root = withState((s) => {
      for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) {
        s.runtime.registerHandler(name, fn);
      }
      /**
       * **认领孤儿只在这里做一次** —— 推进开始之前。
       *
       * driver.lock 证明本 CLI 驱动拥有独占推进权，head.lock 本身不能证明。
       * 循环里每步重开状态目录时不能再认领，否则会把自己刚落盘的 claim
       * 当成孤儿，agent 还在外面跑就被派了第二个。
       */
      const trace = s.registry.rootTrace;
      if (trace !== null) {
        for (const f of s.control.reconcile(actor, trace)) results.push(f as Step);
      }
      return trace;
    });
    if (root === null) return fail("空状态：没有根容器可推进。");

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // 1. 同步 handler：全程持锁，反正不会阻塞
      const sync = withState((s) => {
        for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) {
          s.runtime.registerHandler(name, fn);
        }
        return s.control.run(actor, root) as readonly Step[];
      });
      results.push(...sync);

      // 2. agent：claim 持锁 → 放锁跑 → 重新拿锁 apply
      let agentSteps = 0;
      if (backend !== undefined) {
        for (;;) {
          const claimed = withState((s) => s.runtime.claimAgent());
          if (claimed.kind === "idle") break;
          if (claimed.kind === "rejected") {
            results.push(claimed.failure as Step);
            agentSteps += 1;
            continue;
          }
          const { executionId } = claimed.record;

          // ← 这里只持有驱动锁；send/truncate 需要的 head.lock 已释放。
          let raw: unknown;
          let failure: string | null = null;
          try {
            raw = await backend.run(claimed.request);
          } catch (error) {
            failure = String(error);
          }

          const step = withState((s) =>
            failure === null
              ? s.runtime.applyAgentResult(executionId, raw)
              : s.runtime.failAgentResult(executionId, "FAILED", failure),
          );
          results.push(step as Step);
          agentSteps += 1;
        }
      }

      if (sync.length === 0 && agentSteps === 0) {
        converged = true;
        break;
      }
    }

    settled = withState((s) => {
      const out = s.control.settleAll(actor, root);
      s.runtime.checkInvariants();
      return out;
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(`拒绝：${error.message}`);
    return fail(`推进失败：${(error as Error).message}`);
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    driver.release();
  }

  /**
   * 只有**不再重试**的失败才算流程失败。
   *
   * 之前把每次 attempt 的失败都算进去：一个第三次才成功的 agent 会让整条命令
   * 退出码 1 —— 而重试成功正是重试机制该有的样子。
   * attempt 失败是过程，terminal 失败才是结论。
   */
  const attempts = results.filter((r) => r.reason !== undefined);
  const failures = attempts.filter((r) => r.retrying !== true);
  const retried = attempts.length - failures.length;
  const text =
    `提交 ${results.length} 次，失败 ${failures.length} 次` +
    (retried > 0 ? `（另有 ${retried} 次重试后恢复）` : "") +
    `，终结 ${settled.length} 个实例。` +
    (converged ? "" : `\n★ 未收敛：${String(MAX_ROUNDS)} 轮后仍有活可干，还有工作没做完。`) +
    (backend === undefined ? "\n（未配置执行面：agent 节点不会被推进，见 --runner）" : "") +
    `\n可用内置 handler：${BUILTIN_NAMES.join(", ")}`;

  const data = {
    converged,
    committed: results.length,
    failed: failures.length,
    retried,
    settled: [...settled],
    failures: failures.map((f) => ({ instance: f.instance, reason: String(f.reason) })),
    executionFace: backend === undefined ? null : "configured",
  } as never;

  if (!converged) return fail(text, data); // 谎报"推进到静止"比慢一点糟得多
  return failures.length > 0
    ? fail(
        `${text}\n失败：\n` +
          failures.map((f) => `  ${f.instance}：${String(f.reason)}`).join("\n"),
        data,
      )
    : ok(text, data);
}

/**
 * 强制截断一个实例及其子树（L3 / L4）。
 *
 * 之前 `Runtime.truncate` 有实现却没有出口：一个卡住的 run 只能靠删状态目录
 * 处理，而那会把不可变的对象历史一起删掉 —— 用数据损失换流程解卡。
 */
export function truncate(
  dir: string,
  actor: Principal,
  traceid: string,
  reason: string,
): CommandResult {
  return writable(dir, (s) => {
    if (!s.registry.has(traceid)) return fail(`没有实例 ${traceid}`);
    const r = s.control.truncate(actor, traceid, reason);
    return ok(
      [
        `已截断 ${r.traceid}（generation ${r.generation}）：${r.reason}`,
        `  丢弃消息 ${r.truncatedMessages} 条`,
        `  取消执行 ${r.cancelledExecutions} 个`,
        `  级联子实例 ${r.cascaded.length} 个${r.cascaded.length > 0 ? `：${r.cascaded.join("、")}` : ""}`,
      ].join("\n"),
      {
        traceid: r.traceid,
        generation: r.generation,
        reason: r.reason,
        truncatedMessages: r.truncatedMessages,
        cancelledExecutions: r.cancelledExecutions,
        cascaded: [...r.cascaded],
      } as never,
    );
  });
}

/**
 * 因果查询：这条消息是由哪些消息导致的。
 *
 * 走 RunSnapshot 的 `produced → consumed` 反查。这是 traceid 表达不了的那半边 ——
 * 扇出后子消息 traceid 相同却各有前因，汇聚时一条输出有多个前因。
 */
export function why(dir: string, actor: Principal, messageId: string): CommandResult {
  return readOnly(dir, (s) => {
    const root = s.registry.rootTrace;
    if (root === null) return fail("空状态：没有根容器。");
    const causes = s.control.causesOf(actor, root, messageId);
    const data = { messageId, causes: [...causes] } as never;
    if (causes.length === 0) {
      return ok(`${messageId} 没有记录在案的前因（可能是外部投递的起点）。`, data);
    }
    return ok([`${messageId} 的前因：`, ...causes.map((c) => `  ← ${c}`)].join("\n"), data);
  });
}

/**
 * 回收沙箱 —— 保留最近 `keep` 个，其余删掉。
 *
 * 排序用**版本号**不用墙钟：`<traceid>/$exec` 的版本序是内核给的、确定性的，
 * 而墙钟会让同一份状态在不同机器上回收出不同结果（L0 的同一条理由 ——
 * 时间可以给人看，不能进裁决）。
 *
 * 只回收沙箱，不动对象库：一个状态目录只有一个根（C1），
 * 所以"回收终态 run 的对象"等于删掉整个目录，那用 `rm` 就够，不必做成命令。
 * 隐藏 ref 快照住在沙箱的记录仓里，删沙箱一并带走。
 *
 * `$exec` 里记的路径是**不可变的**，回收之后仍然指向已删除的目录 ——
 * 那是历史事实，不该改写。
 */
export function reclaim(dir: string, actor: Principal, keep: number): CommandResult {
  return readOnly(dir, (s) => {
    const root = s.registry.rootTrace;
    if (root === null) return ok("空状态：没有可回收的沙箱。");

    const boxes: { path: string; exec: string }[] = [];
    for (const inst of s.control.subtree(actor, root)) {
      for (const site of s.registry.sites(inst.traceid))
      for (const v of s.store.history(execLog(site))) {
        const d = ((v.body as Record<string, unknown>).diagnostics ?? {}) as {
          sandbox?: { path?: string; retained?: boolean };
        };
        if (d.sandbox?.retained === true && typeof d.sandbox.path === "string") {
          boxes.push({ path: d.sandbox.path, exec: String((v.body as Record<string, unknown>).execution_id) });
        }
      }
    }

    const alive = boxes.filter((b) => existsSync(b.path));
    const doomed = alive.slice(0, Math.max(0, alive.length - keep));
    if (doomed.length === 0) {
      return ok(`沙箱 ${alive.length} 个，保留上限 ${keep} —— 没有要回收的。`);
    }

    let freed = 0;
    for (const b of doomed) {
      freed += dirSize(b.path);
      rmSync(b.path, { recursive: true, force: true });
    }
    return ok(
      [
        `回收 ${doomed.length} 个沙箱，释放约 ${(freed / 1024 / 1024).toFixed(1)} MB，保留 ${alive.length - doomed.length} 个。`,
        ...doomed.map((b) => `  ${b.exec}  ${b.path}`),
        "（$exec 里记的路径不改写 —— 那是历史事实）",
      ].join("\n"),
    );
  });
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* 读不到就算了，这只是个估数 */
        }
      }
    }
  }
  return total;
}

/**
 * 从场景文件建一个**持久化**的 run。
 *
 * 此前 CLI 根本创建不了持久 run —— `run` 是一次性进程内的，
 * 而 `status` / `drain` 只能作用在已有的状态目录上。
 * 于是唯一能建根的方式是写代码，命令行是残缺的。
 *
 * 与 `run` 共用同一份 `Scenario`：定义 + 根 + 入站消息。区别只是落不落盘。
 */
export function init(dir: string, actor: Principal, raw: unknown): CommandResult {
  const parsed = Scenario.safeParse(raw);
  if (!parsed.success) {
    return fail(
      ["场景文件非法：", ...parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`)].join(
        "\n  ",
      ),
    );
  }
  const scenario = parsed.data;

  return writable(dir, (s) => {
    if (s.registry.rootTrace !== null) {
      return fail(`状态目录已有根容器 ${s.registry.rootTrace}（C1：一个状态目录一个根）。`);
    }
    const refs = new Map<string, string>();
    try {
      for (const t of scenario.templates) {
        // 覆盖层的 extends 可以写成前面模板的 id，这里解析成精确 ref
        const spec =
          isOverlay(t.spec) && typeof (t.spec as { extends: string }).extends === "string"
            ? {
                ...(t.spec as object),
                extends:
                  refs.get((t.spec as { extends: string }).extends) ??
                  (t.spec as { extends: string }).extends,
              }
            : t.spec;
        refs.set(t.id, s.control.define(actor, t.id, spec, t.kind));
      }
    } catch (error) {
      return fail(`注册失败：${(error as Error).message}`);
    }

    const rootRef = refs.get(scenario.root.template);
    if (rootRef === undefined) {
      return fail(
        `根容器引用了未定义的模板 \`${scenario.root.template}\`。已定义：${[...refs.keys()].join("、")}`,
      );
    }
    s.registry.createRoot(rootRef, scenario.root.id);
    for (const m of scenario.send) {
      s.control.send(actor, { instance: m.instance, port: m.port }, m.payload);
    }
    return ok(
      [
        `已建 run ${scenario.root.id}（${scenario.templates.length} 个模板，${scenario.send.length} 条入站消息）。`,
        `下一步：hertaloy status ${dir}　或　hertaloy drain ${dir}`,
      ].join("\n"),
    );
  });
}

/**
 * 看/建 `permissions.json`。
 *
 * 此前根权限表只能手写：`writePermissions` 实现了却没有任何命令调用它。
 * 而"缺省是人类全权、agent 无权"这件事，人得先看得见才改得动。
 */
export function permissions(dir: string, actor: Principal, write: boolean): CommandResult {
  if (write) {
    const state = RunState.open(dir, { validateExecutionSpec: checkAgentSpec });
    try {
      if (state.permissions.source === "file") {
        return fail(`${permissionsPath(dir)} 已存在 —— 不覆盖已有的授权表。`);
      }
      writePermissions(dir);
      return ok(
        [
          `已写出 ${permissionsPath(dir)}（缺省授权：人类全权，agent 无权）。`,
          "改它就改文件；根权限表是启动配置，不进对象库（§17.9）。",
        ].join("\n"),
      );
    } finally {
      state.close();
    }
  }

  return readOnly(dir, (s) => {
    // 谁有什么权限，本身就是要授权才能看的 —— 此前这里是 `void actor`
    try {
      s.control.check(actor, "DQL", "*");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const lines = [
      `来源：${s.permissions.source === "file" ? permissionsPath(dir) : "缺省（无配置文件）"}`,
      "",
      "授权：",
      ...s.permissions.grants.map((g) => `  ${g.principal}  域=${g.scope}  ${g.ops.join("/")}`),
    ];
    if (s.permissions.source === "default") {
      lines.push("", `写出一份可改的：hertaloy permissions ${dir} init`);
    }
    return ok(lines.join("\n"));
  });
}

/**
 * 看 / 加 / 删资源别名 —— **动态上载**。
 *
 * 加完之后模板里写那个名字即可：模板本身不必改，也不知道路径变了。
 * 这正是别名的意义 —— 模板可移植，而 agent 拿不到真实位置。
 */
/**
 * 打开 run 只为问一句"我能不能"，然后关掉。
 *
 * 操作本身在别的层（资源表住 state，根授权表是启动配置），但**决策只有
 * ControlPlane 一处**，而且每次都落日志。这就是"没有第二个 Runtime"
 * 在授权上的形状：路径可以有多条，判断不能有第二处。
 */
function authorize(
  dir: string,
  actor: Principal,
  opClass: "DDL" | "DML" | "DQL",
  target: string,
): CommandResult | null {
  const state = RunState.open(dir, { readOnly: true, validateExecutionSpec: checkAgentSpec });
  try {
    state.control.check(actor, opClass, target);
    return null;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    state.close();
  }
}

export function resources(
  dir: string,
  actor: Principal,
  op: "list" | "add" | "remove",
  args: readonly string[],
): CommandResult {
  try {
    /**
     * 决策走 ControlPlane，操作留在这一层。
     *
     * 此前这个命令**连 actor 参数都没有** —— 而改别名就是改模板的实际指向
     * （`git-main` 指到哪个仓由这张表说了算），一点授权都不过。
     * 今天只有人能从 CLI 调到它，所以没被利用；但"第二条没有检查的路径"
     * 这个形状本身就是错的，而且它一旦被暴露出去，失败方式是静默的。
     *
     * 读也要查：这张表里是**真实路径**，而"agent 拿不到真实位置"正是
     * 别名机制的意义所在。
     */
    const guard = authorize(dir, actor, op === "list" ? "DQL" : "DDL", "*");
    if (guard !== null) return guard;

    if (op === "add") {
      const [name, kind, path, ...rest] = args;
      if (name === undefined || kind === undefined || path === undefined) {
        return fail("用法：hertaloy resources <dir> add <别名> <git|dir|skill|mcp> <路径> [说明]");
      }
      const note = rest.join(" ");
      const next = addResource(dir, name, {
        kind: kind as never,
        path,
        ...(note === "" ? {} : { note }),
      });
      return ok(
        [
          `已登记 ${name}（${kind}）→ ${path}`,
          `现有 ${Object.keys(next).length} 个别名。模板里写 ${name} 就能用上，路径不进模板。`,
        ].join("\n"),
      );
    }

    if (op === "remove") {
      const [name] = args;
      if (name === undefined) return fail("用法：hertaloy resources <dir> remove <别名>");
      const next = removeResource(dir, name);
      return ok(`已删除 ${name}，剩 ${Object.keys(next).length} 个。`);
    }

    const { registry, source } = loadResources(dir);
    const names = Object.keys(registry);
    if (names.length === 0) {
      return ok(
        [
          "没有登记任何资源。",
          `登记一个：hertaloy resources ${dir} add <别名> <git|dir|skill|mcp> <路径>`,
        ].join("\n"),
              { source, resources: {} } as never,
      );
    }
    return ok(
      [
        `来源：${source === "file" ? resourcesPath(dir) : "（无文件）"}`,
        "",
        ...names.map((n) => {
          const r = registry[n] as { kind: string; path: string; note?: string };
          return `  ${n.padEnd(16)} ${r.kind.padEnd(6)} ${r.path}${r.note === undefined ? "" : `　—— ${r.note}`}`;
        }),
      ].join("\n"),
      { source, resources: registry } as never,
    );
  } catch (error) {
    return fail((error as Error).message);
  }
}
