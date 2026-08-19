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

import { RunState } from "@nodeflow/state";
import type { ExecutionBackend } from "@nodeflow/contracts";
import type { Json, Principal } from "@nodeflow/contracts";
import { AuthorizationError } from "@nodeflow/kernel";
import { BUILTIN_HANDLERS, BUILTIN_NAMES } from "./builtins.js";

export interface CommandResult {
  readonly text: string;
  readonly code: number;
}

/** drain 的交替轮次上限。到顶不代表完成 —— 见 drain 里的 converged。 */
const MAX_ROUNDS = 100;

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

/** 只读打开：不拿目录锁，所以能在写进程跑着的时候查（§17.8）。 */
function readOnly(dir: string, fn: (s: RunState) => CommandResult): CommandResult {
  const state = RunState.open(dir, { readOnly: true });
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
  const state = RunState.open(dir);
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
    if (root === null) return ok("空状态：还没有根容器。");

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
     * 锁与消息按**子树**汇总，不是只看根。
     *
     * 之前只统计 root 自己持有的锁、以及 `target.traceid === root` 的消息 ——
     * 于是子实例卡住时，status 照样显示"阻塞锁 0、在途消息 0"。
     * 一个只在根节点出问题时才说真话的状态命令，比没有更糟。
     */
    const subtree = control.subtree(actor, root);
    const locks = subtree.flatMap((i) => control.locks(actor, i.traceid));
    lines.push("", `阻塞锁 ${locks.length} 把：`);
    for (const lock of locks) {
      lines.push(
        `  ${lock.kind}  持有者=${lock.holder}  键=${lock.key}` +
          (lock.waitingOn === undefined ? "" : `  等待=${lock.waitingOn}`),
      );
    }

    const inbox = subtree.flatMap((i) => control.messages(actor, i.traceid));
    const pending = inbox.filter((m) => m.state === "QUEUED");
    const claimed = inbox.filter((m) => m.state === "CLAIMED");
    lines.push("", `在途消息 ${pending.length} 条（另有 ${claimed.length} 条已被 claim）：`);
    for (const m of [...pending, ...claimed]) {
      lines.push(
        `  ${m.state === "CLAIMED" ? "⟳" : "→"} ${m.target.traceid}/${m.target.node}.${m.target.port}`,
      );
    }
    const execs = subtree.flatMap((i) => s.store.history(`${i.traceid}/$exec`));
    if (execs.length > 0) {
      lines.push("", `执行观测 ${execs.length} 条（\`show <traceid>/$exec\` 看详情）：`);
      let retained = 0;
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
          `  ${String(b.execution_id)}  ${String(b.node)}  ${String(b.termination)}` +
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
      for (const r of running) lines.push(`  ${r.executionId}  ${r.traceid}/${r.nodeId}`);
    }

    const deadlocks = s.runtime.locks.deadlocks();
    if (deadlocks.length > 0) {
      lines.push("", "★ 死锁环：");
      for (const cycle of deadlocks) lines.push(`  ${cycle.join(" → ")}`);
    }
    return ok(lines.join("\n"));
  });
}

/** 读一个对象。`id` 取最新版，`id@N` 取指定版。 */
export function show(dir: string, actor: Principal, ref: string): CommandResult {
  return readOnly(dir, (s) => {
    const at = ref.lastIndexOf("@");
    try {
      const version = at === -1 ? s.control.head(actor, ref) : s.control.read(actor, ref);
      return ok(JSON.stringify(version, null, 2));
    } catch (error) {
      return fail((error as Error).message);
    }
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
    return ok([`${objectId}（${versions.length} 版）：`, ...lines].join("\n"));
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
  traceid: string,
  node: string,
  port: string,
  payload: Json,
): CommandResult {
  return writable(dir, (s) => {
    if (!s.registry.has(traceid)) {
      return fail(`没有实例 ${traceid}。先跑 \`hertaloy status\` 看有哪些。`);
    }
    try {
      s.control.send(actor, { traceid, node, port }, payload);
      return ok(`已投递 → ${traceid}/${node}.${port}`);
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
  type Step = { traceid: string; nodeId: string; reason?: string; retrying?: boolean };
  const results: Step[] = [];
  let settled: readonly string[] = [];
  let converged = false;

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
    const state = RunState.open(dir, backend === undefined ? {} : { backend });
    try {
      const out = fn(state);
      state.persist();
      return out;
    } finally {
      state.close();
    }
  };

  try {
    const root = withState((s) => {
      for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) {
        s.runtime.registerHandler(name, fn);
      }
      return s.registry.rootTrace;
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

          // ← 这里没有锁。agent 爱跑多久跑多久，truncate 随时能进来。
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

  if (!converged) return fail(text); // 谎报"推进到静止"比慢一点糟得多
  return failures.length > 0
    ? fail(
        `${text}\n失败：\n` +
          failures.map((f) => `  ${f.traceid}/${f.nodeId}：${String(f.reason)}`).join("\n"),
      )
    : ok(text);
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
        `  释放锁 ${r.releasedLocks} 把`,
        `  取消执行 ${r.cancelledExecutions} 个`,
        `  级联子实例 ${r.cascaded.length} 个${r.cascaded.length > 0 ? `：${r.cascaded.join("、")}` : ""}`,
      ].join("\n"),
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
    if (causes.length === 0) {
      return ok(`${messageId} 没有记录在案的前因（可能是外部投递的起点）。`);
    }
    return ok([`${messageId} 的前因：`, ...causes.map((c) => `  ← ${c}`)].join("\n"));
  });
}
