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

    const locks = control.locks(actor, root);
    lines.push("", `阻塞锁 ${locks.length} 把：`);
    for (const lock of locks) {
      lines.push(
        `  ${lock.kind}  持有者=${lock.holder}  键=${lock.key}` +
          (lock.waitingOn === undefined ? "" : `  等待=${lock.waitingOn}`),
      );
    }

    const pending = control.messages(actor, root).filter((m) => m.state === "QUEUED");
    lines.push("", `在途消息 ${pending.length} 条：`);
    for (const m of pending) {
      lines.push(`  → ${m.target.traceid}/${m.target.node}.${m.target.port}`);
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
  const state = RunState.open(dir, backend === undefined ? {} : { backend });
  try {
    const root = state.registry.rootTrace;
    if (root === null) return fail("空状态：没有根容器可推进。");
    for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) {
      state.runtime.registerHandler(name, fn);
    }

    type Step = { traceid: string; nodeId: string; reason?: string };
    const results: Step[] = [];
    try {
      /**
       * 同步 handler 与 agent **交替**推进到静止。
       *
       * 不能各跑一遍了事：handler 的输出会喂给 agent，agent 的输出又会喂回
       * handler。一轮一轮来，直到两边都没活可干。
       */
      for (let round = 0; round < 100; round += 1) {
        const sync = state.control.run(actor, root) as readonly Step[];
        results.push(...sync);
        const agents =
          backend === undefined
            ? ([] as readonly Step[])
            : ((await state.control.runAgents(actor, root)) as readonly Step[]);
        results.push(...agents);
        if (sync.length === 0 && agents.length === 0) break;
      }
      const settled = state.control.settleAll(actor, root);
      state.runtime.checkInvariants();
      state.persist();

      const failures = results.filter((r) => r.reason !== undefined);
      const text =
        `提交 ${results.length} 次，失败 ${failures.length} 次，` +
        `终结 ${settled.length} 个实例。` +
        (backend === undefined ? "\n（未配置执行面：agent 节点不会被推进，见 --runner）" : "") +
        `\n可用内置 handler：${BUILTIN_NAMES.join(", ")}`;
      return failures.length > 0
        ? fail(
            `${text}\n失败：\n` +
              failures.map((f) => `  ${f.traceid}/${f.nodeId}：${String(f.reason)}`).join("\n"),
          )
        : ok(text);
    } catch (error) {
      if (error instanceof AuthorizationError) return fail(`拒绝：${error.message}`);
      return fail(`推进失败：${(error as Error).message}`);
    }
  } finally {
    state.close();
  }
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
