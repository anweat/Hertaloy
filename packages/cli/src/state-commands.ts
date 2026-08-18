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
 */

import { RunState } from "@nodeflow/state";
import type { Json } from "@nodeflow/contracts";
import { BUILTIN_HANDLERS, BUILTIN_NAMES } from "./builtins.js";

export interface CommandResult {
  readonly text: string;
  readonly code: number;
}

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

/** 只读打开：不拿目录锁，所以能在写进程跑着的时候查（§17.8）。 */
function readOnly<T>(dir: string, fn: (s: RunState) => T): T {
  const state = RunState.open(dir, { readOnly: true });
  try {
    return fn(state);
  } finally {
    state.close();
  }
}

function writable(dir: string, fn: (s: RunState) => CommandResult): CommandResult {
  const state = RunState.open(dir);
  try {
    const result = fn(state);
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
export function status(dir: string): CommandResult {
  return readOnly(dir, (s) => {
    const root = s.registry.rootTrace;
    if (root === null) return ok("空状态：还没有根容器。");

    const lines: string[] = [`run ${root}（${s.dir}）`, ""];
    lines.push("实例树：");
    for (const inst of s.registry.subtree(root)) {
      const depth = inst.traceid.split("/").length - root.split("/").length;
      const blockers = s.runtime.terminationBlockers(inst.traceid);
      lines.push(
        `${"  ".repeat(depth + 1)}${inst.traceid}  ${inst.status}  ` +
          `seq=${inst.seq} gen=${inst.generation}` +
          (inst.slot === undefined ? "" : `  槽=${inst.slot}`) +
          (blockers.length > 0 ? `\n${"  ".repeat(depth + 2)}↳ 阻塞：${blockers.join("；")}` : ""),
      );
    }

    const locks = s.runtime.locks.all();
    lines.push("", `阻塞锁 ${locks.length} 把：`);
    for (const lock of locks) {
      lines.push(
        `  ${lock.kind}  持有者=${lock.holder}  键=${lock.key}` +
          (lock.waitingOn === undefined ? "" : `  等待=${lock.waitingOn}`),
      );
    }

    const pending = s.runtime.pending();
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
export function show(dir: string, ref: string): CommandResult {
  return readOnly(dir, (s) => {
    const at = ref.lastIndexOf("@");
    try {
      const version =
        at === -1 ? s.store.head(ref) : s.store.get(ref.slice(0, at), Number(ref.slice(at + 1)));
      return ok(JSON.stringify(version, null, 2));
    } catch (error) {
      return fail((error as Error).message);
    }
  });
}

/** 一个对象的版本历史 —— C5 下这就是"这个东西经历了什么"。 */
export function history(dir: string, objectId: string): CommandResult {
  return readOnly(dir, (s) => {
    const versions = s.store.history(objectId);
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
      s.runtime.send({ traceid, node, port }, payload);
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
export function drain(dir: string): CommandResult {
  return writable(dir, (s) => {
    for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) s.runtime.registerHandler(name, fn);
    try {
      const results = s.runtime.drain();
      const settled = s.runtime.settleAll();
      s.runtime.checkInvariants();
      const failures = results.filter((r) => "reason" in r);
      const text =
        `提交 ${results.length} 次，失败 ${failures.length} 次，` +
        `终结 ${settled.length} 个实例。\n` +
        `可用内置 handler：${BUILTIN_NAMES.join(", ")}`;
      return failures.length > 0
        ? fail(
            `${text}\n失败：\n` +
              failures
                .map((f) => `  ${(f as { traceid: string; nodeId: string; reason: string }).traceid}` +
                  `/${(f as { nodeId: string }).nodeId}：${(f as { reason: string }).reason}`)
                .join("\n"),
          )
        : ok(text);
    } catch (error) {
      return fail(`推进失败：${(error as Error).message}`);
    }
  });
}

/**
 * 强制截断一个实例及其子树（L3 / L4）。
 *
 * 之前 `Runtime.truncate` 有实现却没有出口：一个卡住的 run 只能靠删状态目录
 * 处理，而那会把不可变的对象历史一起删掉 —— 用数据损失换流程解卡。
 */
export function truncate(dir: string, traceid: string, reason: string): CommandResult {
  return writable(dir, (s) => {
    if (!s.registry.has(traceid)) return fail(`没有实例 ${traceid}`);
    const r = s.runtime.truncate(traceid, reason);
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
