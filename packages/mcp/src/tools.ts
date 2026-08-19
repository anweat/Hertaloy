/**
 * MCP 工具集 —— **控制面开放出去的那一层**（批 K，G1 的出口）。
 *
 * 三条纪律，都不是可选的：
 *
 * 1. **每个工具都过 `ControlPlane`**，一个都不直连 `Runtime`。
 *    开放出去的必须是带授权检查的那扇门，否则等于把无检查的内核挂到网上。
 *
 * 2. **`actor` 由服务端注入，绝不从工具参数里取**（§11.3）。所以下面每个
 *    handler 的签名都是 `(ctx, args)`，`ctx.actor` 来自启动时的会话身份 ——
 *    参数 schema 里**根本没有 principal 这个字段**，客户端想伪造也没有地方写。
 *
 * 3. **每次调用各自开关状态目录**，跟 CLI 一样。常驻持锁会让 `truncate`
 *    这类救急命令进不来 —— 那个教训刚在 drain 上吃过一次。
 *
 * 工具与 SDK 接线**分开**：这里是纯函数，可以直接测；`server.ts` 只负责把它们
 * 挂到 stdio 上。逻辑的测试不该依赖传输层起没起来。
 */

import { z } from "zod";
import type { Json, Principal } from "@nodeflow/contracts";
import { AuthorizationError } from "@nodeflow/kernel";
import { RunState } from "@nodeflow/state";
import {
  BUILTIN_HANDLERS,
  BUILTIN_NAMES,
  init as createRunCommand,
  validate as validateTemplate,
} from "@nodeflow/cli";

export interface ToolContext {
  /** 状态目录。一个服务端绑一个 run（C1：一个目录一个根）。 */
  readonly dir: string;
  /** 会话身份。**由服务端注入**，工具参数里没有这个字段。 */
  readonly actor: Principal;
}

export interface ToolResult {
  /** 给模型看的文本。失败时这就是它自我修正的依据。 */
  readonly text: string;
  readonly isError: boolean;
}

export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** 必须是 object schema —— MCP 的 inputSchema 要的是它的 shape。 */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** 参数已由 schema 校验过；各 handler 自己收窄到需要的形状。 */
  readonly handler: (ctx: ToolContext, args: Record<string, unknown>) => ToolResult;
}

const ok = (text: string): ToolResult => ({ text, isError: false });
const err = (text: string): ToolResult => ({ text, isError: true });

/**
 * 统一的错误出口。
 *
 * 授权失败与校验失败都要变成**模型读得懂的文字**，不是一个栈 ——
 * G1 的自我修正内循环全靠这段文字：AI 生成模板 → 拿到错误 → 自己改。
 * 这正是 V4 的实质缺陷（`propose` 不校验，于是人成了 AI 的语法检查器）。
 */
function guard(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AuthorizationError) return err(`拒绝：${error.message}`);
    return err((error as Error).message);
  }
}

function readOnly(ctx: ToolContext, fn: (s: RunState) => ToolResult): ToolResult {
  return guard(() => {
    const state = RunState.open(ctx.dir, { readOnly: true });
    try {
      return fn(state);
    } finally {
      state.close();
    }
  });
}

function writable(ctx: ToolContext, fn: (s: RunState) => ToolResult): ToolResult {
  return guard(() => {
    const state = RunState.open(ctx.dir);
    try {
      const result = fn(state);
      if (!result.isError) state.persist();
      return result;
    } finally {
      state.close();
    }
  });
}

// ---------------------------------------------------------------------------

const validate: Tool = {
  name: "validate_template",
  title: "干跑校验容器模板",
  description:
    "校验一份容器模板，**不落库**。提交之前先跑这个 —— 拿到的错误是给模型读的，" +
    "改完再 define。这是自我修正内循环的入口。",
  schema: z.object({ spec: z.unknown() }),
  handler: (_ctx, args) => {
    const r = validateTemplate(args.spec);
    return r.code === 0 ? ok(r.text) : err(r.text);
  },
};

const define: Tool = {
  name: "define_template",
  title: "注册容器模板或契约",
  description:
    "把一份定义注册进对象库，返回精确版本引用（`id@N`）。" +
    "kind 默认 container_template；端口载荷 schema 用 message_contract。" +
    "注册期全量校验：结构、连接、预算、子槽入口一处不合就整份拒绝，不会半份落库。",
  schema: z.object({
    id: z.string().min(1),
    spec: z.unknown(),
    kind: z.string().optional(),
  }),
  handler: (ctx, args) =>
    writable(ctx, (s) => {
      const a = args as { id: string; spec: unknown; kind?: string };
      const ref = s.control.define(ctx.actor, a.id, a.spec, a.kind);
      return ok(`已注册 ${ref}`);
    }),
};

const createRun: Tool = {
  name: "create_run",
  title: "从场景建一个 run",
  description:
    "注册模板 + 建根 + 投入站消息，一次做完。一个状态目录只有一个根（C1），" +
    "所以这条只能成功一次。",
  schema: z.object({ scenario: z.unknown() }),
  handler: (ctx, args) => {
    const r = createRunCommand(ctx.dir, ctx.actor, args.scenario);
    return r.code === 0 ? ok(r.text) : err(r.text);
  },
};

const status: Tool = {
  name: "get_status",
  title: "查看实例树与阻塞原因",
  description:
    "实例树、每个实例的阻塞原因、在途消息、死锁环。卡住时先看这个 —— " +
    "「谁在等谁」是排查的起点。",
  schema: z.object({}),
  handler: (ctx) =>
    readOnly(ctx, (s) => {
      const root = s.registry.rootTrace;
      if (root === null) return ok("空状态：还没有根容器。用 create_run 建一个。");
      const control = s.control;
      const lines = [`run ${root}`, ""];
      for (const inst of control.subtree(ctx.actor, root)) {
        const blockers = control.blockers(ctx.actor, inst.traceid);
        lines.push(
          `${inst.traceid}  ${inst.status}  seq=${inst.seq} gen=${inst.generation}` +
            (blockers.length > 0 ? `  阻塞：${blockers.join("；")}` : ""),
        );
      }
      const queued = control
        .subtree(ctx.actor, root)
        .flatMap((i) => control.messages(ctx.actor, i.traceid))
        .filter((m) => m.state === "QUEUED");
      lines.push("", `在途消息 ${queued.length} 条`);
      for (const m of queued) {
        lines.push(`  → ${m.target.traceid}/${m.target.node}.${m.target.port}`);
      }
      return ok(lines.join("\n"));
    }),
};

const send: Tool = {
  name: "send_message",
  title: "往端点投一条消息",
  description:
    "把载荷投到某个实例的 receive 端口。**人的放行也走这条** —— " +
    "等待就是阻塞锁，放行就是往它等的端点投消息，没有单独的审批机制。",
  schema: z.object({
    traceid: z.string().min(1),
    node: z.string().min(1),
    port: z.string().min(1),
    payload: z.unknown().optional(),
  }),
  handler: (ctx, args) =>
    writable(ctx, (s) => {
      const a = args as { traceid: string; node: string; port: string; payload?: unknown };
      if (!s.registry.has(a.traceid)) {
        return err(`没有实例 ${a.traceid}。先跑 get_status 看有哪些。`);
      }
      const id = s.control.send(
        ctx.actor,
        { traceid: a.traceid, node: a.node, port: a.port },
        (a.payload ?? {}) as Json,
      );
      return ok(`已投递 ${id} → ${a.traceid}/${a.node}.${a.port}`);
    }),
};

const spawn: Tool = {
  name: "spawn_child",
  title: "在已声明的子槽里建子实例",
  description:
    "从父实例的**已声明子槽**建一个子实例。槽是模板里写死的 —— " +
    "建得出哪些子容器由定义决定，不由调用方决定（第一不变量）。",
  schema: z.object({
    parent: z.string().min(1),
    slot: z.string().min(1),
    segment: z.string().min(1),
  }),
  handler: (ctx, args) =>
    writable(ctx, (s) => {
      const a = args as { parent: string; slot: string; segment: string };
      const child = s.control.spawn(ctx.actor, a.parent, a.slot, a.segment);
      return ok(`已建子实例 ${child.traceid}`);
    }),
};

const advance: Tool = {
  name: "advance",
  title: "推进到静止（只跑内置 handler）",
  description:
    "把同步 handler 节点推到没活可干，然后收敛够条件的实例。" +
    `**不跑 agent 节点** —— 那要起进程、可能出网、可能花钱，不该由一次工具调用悄悄发生。` +
    `可用内置 handler：${BUILTIN_NAMES.join("、")}。`,
  schema: z.object({}),
  handler: (ctx) =>
    writable(ctx, (s) => {
      const root = s.registry.rootTrace;
      if (root === null) return err("空状态：没有根容器可推进。");
      for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) {
        s.runtime.registerHandler(name, fn);
      }
      const results = s.control.run(ctx.actor, root);
      const settled = s.control.settleAll(ctx.actor, root);
      s.runtime.checkInvariants();
      const failures = results.filter(
        (r) => "reason" in r && (r as { retrying?: boolean }).retrying !== true,
      );
      const text = `提交 ${results.length} 次，失败 ${failures.length} 次，终结 ${settled.length} 个实例。`;
      return failures.length > 0
        ? err(
            `${text}\n` +
              failures
                .map((f) => {
                  const x = f as { traceid: string; nodeId: string; reason: string };
                  return `  ${x.traceid}/${x.nodeId}：${x.reason}`;
                })
                .join("\n"),
          )
        : ok(text);
    }),
};

const readObject: Tool = {
  name: "read_object",
  title: "读一个对象版本",
  description:
    "`id` 取最新版，`id@N` 取指定版。C5 之下「这个东西经历了什么」全在版本历史里，" +
    "所以这是主要的观测面。",
  schema: z.object({ ref: z.string().min(1) }),
  handler: (ctx, args) =>
    readOnly(ctx, (s) => {
      const ref = (args as { ref: string }).ref;
      const at = ref.lastIndexOf("@");
      const v = at === -1 ? s.control.head(ctx.actor, ref) : s.control.read(ctx.actor, ref);
      return ok(JSON.stringify(v, null, 2));
    }),
};

const listVersions: Tool = {
  name: "list_versions",
  title: "一个对象的版本历史",
  description: "汇聚 / 计数 / 择优都靠版本历史 —— `plan@3` 就是第三轮。",
  schema: z.object({ objectId: z.string().min(1) }),
  handler: (ctx, args) =>
    readOnly(ctx, (s) => {
      const id = (args as { objectId: string }).objectId;
      const versions = s.control.history(ctx.actor, id);
      if (versions.length === 0) return err(`没有对象 ${id}`);
      return ok(
        [
          `${id}（${versions.length} 版）：`,
          ...versions.map(
            (v) => `@${v.version}  ${v.kind}  ${v.content_hash.slice(0, 12)}  ${JSON.stringify(v.body)}`,
          ),
        ].join("\n"),
      );
    }),
};

const truncate: Tool = {
  name: "truncate_instance",
  title: "强制截断实例及其子树",
  description:
    "推进 generation 栅栏、丢弃在途消息、释放锁、级联到子树。" +
    "卡死时的救急口 —— 迟到的结果会因为对不上栅栏而作废。",
  schema: z.object({ traceid: z.string().min(1), reason: z.string().optional() }),
  handler: (ctx, args) =>
    writable(ctx, (s) => {
      const a = args as { traceid: string; reason?: string };
      if (!s.registry.has(a.traceid)) return err(`没有实例 ${a.traceid}`);
      const r = s.control.truncate(ctx.actor, a.traceid, a.reason ?? "经 MCP 截断");
      return ok(
        `已截断 ${r.traceid}（generation ${r.generation}）：丢弃消息 ${r.truncatedMessages} 条，` +
          `释放锁 ${r.releasedLocks} 把，级联 ${r.cascaded.length} 个子实例。`,
      );
    }),
};

const causes: Tool = {
  name: "explain_message",
  title: "这条消息由哪些消息导致",
  description:
    "从提交快照的 produced → consumed 反查。这是 traceid 表达不了的那半边因果：" +
    "扇出后子消息 traceid 相同却各有前因，汇聚时一条输出有多个前因。",
  schema: z.object({ messageId: z.string().min(1) }),
  handler: (ctx, args) =>
    readOnly(ctx, (s) => {
      const root = s.registry.rootTrace;
      if (root === null) return err("空状态：没有根容器。");
      const id = (args as { messageId: string }).messageId;
      const list = s.control.causesOf(ctx.actor, root, id);
      return ok(
        list.length === 0
          ? `${id} 没有记录在案的前因（可能是外部投递的起点）。`
          : [`${id} 的前因：`, ...list.map((c) => `  ← ${c}`)].join("\n"),
      );
    }),
};

export const TOOLS: readonly Tool[] = [
  validate,
  createRun,
  define,
  status,
  send,
  spawn,
  advance,
  readObject,
  listVersions,
  truncate,
  causes,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);
