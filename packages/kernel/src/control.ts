/**
 * 控制面 —— **可信边界**（FOUNDATION_V5.md §11）。
 *
 * 权限检查放在这一层，不穿进内核签名。理由有三：
 *
 *   1. §11.3 要求 `Principal` **必须由可信边界注入** —— 那个边界就是这里，
 *      注入一次即可，不必让每个内核方法都多一个参数。
 *   2. Runtime 保持**纯引擎**：它不知道谁在调它，也就不可能被"payload 里
 *      自称的 actor"骗到。
 *   3. 权限是数据（授权表），换策略不用改内核。
 *
 * 操作按 DDL / DML / DQL 分类，`scope` 复用同一套段边界前缀判定。
 */

import {
  ContainerTemplate,
  containerOf,
  formatPrincipal,
  type Endpoint,
  type Json,
  type OpClass,
  type PermissionTable,
  type Principal,
  type ObjectVersion,
  type Ref,
  type TraceId,
} from "@nodeflow/contracts";
import { AuthorizationError, InvariantError } from "./errors.js";
import { type Obligation, deadlocks as cyclesOf } from "./obligations.js";
import type { AuthzLog } from "./authz-log.js";

import {
  type ContainerInstance,
  type ExecutionSpecValidator,
  InstanceRegistry,
  registerContainerTemplate,
  prepareContainerTemplate,
} from "./instances.js";
import type { ObjectStore } from "./store.js";
import type {
  ExecutionRecord,
  Message,
  Runtime,
  StepFailure,
  StepResult,
  TruncationResult,
} from "./runtime.js";

/**
 * 注入给控制面的东西。**收成一个对象而不是继续加位置参数** ——
 * 第 6 个位置参数就是没人记得住顺序的开始。
 *
 * 两样都是缝：换掉一条不变量都不破（判据见 `scheduling.ts` 开头）。
 */
export interface ControlPlaneDeps {
  /** 授权决策日志。**必填** —— 理由见 `authz-log.ts`。 */
  readonly log: AuthzLog;
  /** 执行面声明的注册期校验。不给就只剩契约层那条凭据扫描。 */
  readonly validateExecutionSpec?: ExecutionSpecValidator;
}

/** 操作 → 类别的映射表。**这张表就是分层本身**，不散在各处 if 里。 */
export const OPERATION_CLASS = {
  define: "DDL",
  send: "DML",
  run: "DML",
  spawn: "DML",
  truncate: "DML",
  settle: "DML",
  query: "DQL",
} as const satisfies Record<string, OpClass>;

export type Operation = keyof typeof OPERATION_CLASS;

export class ControlPlane {
  readonly #runtime: Runtime;
  readonly #registry: InstanceRegistry;
  readonly #store: ObjectStore;
  readonly #permissions: PermissionTable;
  readonly #deps: ControlPlaneDeps;

  /**
   * `log` **必填，没有默认值**。
   *
   * `RunState.control` 是每次访问现构造的 —— 一个"默认内存实现"会在每次构造时
   * 新开一份，于是日志每次都是空的，而调用方看不出任何异常。那正是
   * "两端各自都绿、中间没人走"。必填就逼每个构造点当场决定日志去哪。
   */
  constructor(
    runtime: Runtime,
    registry: InstanceRegistry,
    store: ObjectStore,
    permissions: PermissionTable,
    deps: ControlPlaneDeps,
  ) {
    this.#runtime = runtime;
    this.#registry = registry;
    this.#store = store;
    this.#permissions = permissions;
    this.#deps = deps;
  }

  /**
   * 授权检查。**默认拒绝**；拒绝时抛 `AuthorizationError` 并说清缺什么。
   *
   * `actor` 由调用方（服务端 session / MCP 环境变量）注入 ——
   * 绝不从 payload 或 arguments 里取。
   */
  #authorize(actor: Principal, op: Operation, target: string): void {
    this.check(actor, OPERATION_CLASS[op], target, op);
  }

  /** Runtime 的这些操作覆盖整树；子树权限不能冒充根权限。 */
  #authorizeRoot(actor: Principal, op: Operation, scope: TraceId): void {
    const root = this.#registry.rootTrace;
    this.#authorize(actor, op, root ?? scope);
    if (scope !== root) {
      throw new InvariantError(`此操作仅支持根实例 ${root ?? "（尚未创建）"}，不支持子树作用域 ${scope}`);
    }
  }

  /**
   * 授权决策的**唯一**落点 —— 放行和拒绝都记日志，然后拒绝的抛。
   *
   * 日志走注入的 `AuthzLog`：授权的正确性由 `decide` 加"拒绝就抛"给出，
   * 日志是**证据**不是判据 —— 换掉它一条不变量都不破，所以它是缝不是状态。
   *
   * 公开出来是给那些操作不在内核里、但决策必须在这儿做的调用方用的
   * （资源别名表、根授权表都住在 state 层，内核够不着）。
   * 分层因此保持原样：**操作留在它自己那一层，决策只有这一处**。
   * 这正是"没有第二个 Runtime"在授权上的形状。
   */
  check(actor: Principal, opClass: OpClass, target: string, op = opClass.toLowerCase()): void {
    const decision = this.#permissions.decide(actor, opClass, target);
    this.#deps.log.record({
      actor: formatPrincipal(actor),
      op,
      opClass,
      target,
      allowed: decision.allowed,
      reason: decision.reason,
    });
    if (!decision.allowed) throw new AuthorizationError(decision.reason);
  }

  // --- DDL ---------------------------------------------------------------

  /** 注册容器定义或覆盖层。scope 按**定义路径前缀**判定（对象级 GRANT）。 */
  define(actor: Principal, templateId: string, spec: unknown, kind?: string): Ref {
    this.#authorize(actor, "define", templateId);
    return registerContainerTemplate(
      this.#store,
      templateId,
      spec,
      kind,
      this.#deps.validateExecutionSpec,
    );
  }

  // --- DML ---------------------------------------------------------------

  /** 干跑可以解析任意定义引用，要求对象库的完整读取权；不要求写权限。 */
  validateDefinition(actor: Principal, id: string, spec: unknown, kind?: string) {
    this.#authorize(actor, "query", "*");
    return prepareContainerTemplate(this.#store, id, spec, kind, this.#deps.validateExecutionSpec);
  }

  /**
   * scope 按 **traceid 前缀**判定（行级安全）。
   *
   * 授权目标就是**地址本身**。V6 阶段 1b 之前地址是两段，这里只能拿容器那段去问；
   * 收成一段之后问的是投递点自己 —— 对容器级的 principal 判定完全相同
   * （前缀匹配覆盖子路径），而给节点级 principal 留出了正确的读数。
   */
  send(actor: Principal, target: Endpoint, payload: Json): string {
    this.#authorize(actor, "send", target.instance);
    return this.#runtime.send(target, payload);
  }

  spawn(actor: Principal, parent: TraceId, slot: string, segment: string): ContainerInstance {
    this.#authorize(actor, "spawn", parent);
    return this.#runtime.spawn(parent, slot, segment);
  }

  /** 同步驱动。授权按根实例判定 —— 驱动会跨整棵树。 */
  run(actor: Principal, scope: TraceId): readonly (StepResult | StepFailure)[] {
    this.#authorizeRoot(actor, "run", scope);
    return this.#runtime.drain();
  }

  /**
   * 驱动 **agent 节点**（异步）。
   *
   * 与 `run` 分成两条而不是合成一条：`run` 是同步的纯引擎推进，
   * `runAgents` 里面有 `await`，中间会跑外部进程、花钱、产生副作用。
   * 合成一条就得让所有调用方都变成 async，也会掩盖"这一步要花钱"这件事。
   */
  async runAgents(actor: Principal, scope: TraceId): Promise<readonly (StepResult | StepFailure)[]> {
    this.#authorizeRoot(actor, "run", scope);
    return await this.#runtime.drainAgents();
  }

  truncate(actor: Principal, trace: TraceId, reason: string): TruncationResult {
    this.#authorize(actor, "truncate", trace);
    return this.#runtime.truncate(trace, reason);
  }

  settle(actor: Principal, trace: TraceId): boolean {
    this.#authorize(actor, "settle", trace);
    return this.#runtime.settle(trace);
  }

  // --- DQL ---------------------------------------------------------------

  subtree(actor: Principal, trace: TraceId): readonly ContainerInstance[] {
    this.#authorize(actor, "query", trace);
    return this.#registry.subtree(trace);
  }

  /** 从获准子树的固定版本展开声明依赖；不枚举别的模板资产或版本。 */
  definitions(actor: Principal, scope?: TraceId) {
    const trace = scope ?? this.#registry.rootTrace;
    this.#authorize(actor, "query", trace ?? "*");
    const instances = trace === null ? [] : this.#registry.subtree(trace);
    const result: Record<string, {
      ref: Ref; kind: string; body: Json;
      usedBy: string[];
      dependencies: { ref: Ref; where: string }[];
    }> = {};
    const pending = instances.map((i) => i.templateRef);
    for (let at = 0; at < pending.length; at += 1) {
      const ref = pending[at]!;
      if (Object.hasOwn(result, ref)) continue;
      const version = this.#store.resolve(ref);
      const dependencies: { ref: Ref; where: string }[] = [];
      if (version.kind !== "message_contract") {
        const tpl = ContainerTemplate.parse(version.body);
        for (const [slot, child] of Object.entries(tpl.children)) {
          dependencies.push({ ref: child.template, where: `children.${slot}.template` });
        }
        for (const [node, decl] of Object.entries(tpl.nodes)) {
          for (const [port, spec] of Object.entries(decl.ports)) {
            if (spec.contract !== undefined) {
              dependencies.push({ ref: spec.contract, where: `nodes.${node}.ports.${port}.contract` });
            }
          }
        }
        for (const base of version.provenance.derived_from ?? []) {
          dependencies.push({ ref: base, where: "extends" });
        }
      }
      result[ref] = {
        ref, kind: version.kind, body: version.body,
        usedBy: instances.filter((i) => i.templateRef === ref).map((i) => i.traceid),
        dependencies,
      };
      pending.push(...dependencies.map((d) => d.ref));
    }
    return result;
  }

  /**
   * 等待图里的环 = 死锁。**只报警，不裁决**（观测不裁决）。
   *
   * 按作用域裁剪后再找环：**看不见的那一半也参与不了裁决**。一个横跨
   * 作用域内外的环，对只看得见半边的主体报不出来 —— 那是诚实的，
   * 报出一个它无法核实的结论才是假的。
   *
   * 此前 `status` 直接调 `runtime.locks.deadlocks()`，不授权也不裁剪：
   * 一个只被授权看子树的主体，能读到整棵树的等待环。
   */
  deadlocks(actor: Principal, scope?: TraceId): readonly (readonly TraceId[])[] {
    const trace = scope ?? this.#registry.rootTrace;
    this.#authorize(actor, "query", trace ?? "*");
    if (trace === null) return [];
    const inScope = (t: TraceId): boolean => t === trace || t.startsWith(`${trace}/`);
    return cyclesOf(this.#runtime.obligations().filter((o) => inScope(o.holder)));
  }

  blockers(actor: Principal, trace: TraceId): readonly string[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.terminationBlockers(trace);
  }

  /**
   * 未了结的义务 —— **结构化的那一份**。
   *
   * `blockers` 一直只给中文文案，而那份文案同时被当成了 `status --json` 的
   * 机器数据（审核指出：不能把中文字符串当机器协议）。
   *
   * 但结构化的形式**不是缺的东西** —— `Obligation` 本来就是
   * `{kind, holder, waitingOn, key, originNode}`，中文那份只是它的渲染。
   * 缺的是带授权的出口。这跟 `exportSnapshot` 曾经零调用方是同一个形状：
   * 事实在，路没通。
   */
  obligations(actor: Principal, trace: TraceId): readonly Obligation[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.obligations(trace);
  }

  /**
   * 按 id 查一次执行。
   *
   * `executionId` 是 `exec-1` 这种**每个 run 从 1 起**的号，不带 traceid，
   * 而授权按 traceid 前缀判。所以顺序只能是：先找到记录 → 拿它的 traceid → 授权。
   *
   * **找不到时按根授权**：这样一个只有子树权限的主体去探别人子树里的 id，
   * 拿到的是"无权"而不是"没有" —— 否则存在性本身成了泄漏面。代价是无权时
   * 分不出"没有"和"没权限"，而那正是应该的。
   */
  execution(actor: Principal, executionId: string): ExecutionRecord | undefined {
    const found = this.#runtime.records().find((r) => r.executionId === executionId);
    const target = found?.traceid ?? this.#registry.rootTrace ?? executionId;
    this.#authorize(actor, "query", target);
    // **缺席是答复，不是异常**：`InvariantError` 是给"不变量被破"用的，
    // 而"你查的 id 不存在"是一个正常结果，该由调用方决定怎么呈现。
    return found;
  }

  /** 按 id 查一条消息。授权规则与 `execution` 同（见那条的说明）。 */
  message(actor: Principal, messageId: string): Message | undefined {
    const found = this.#runtime.messages().find((m) => m.id === messageId);
    const target = found?.target.instance ?? this.#registry.rootTrace ?? messageId;
    this.#authorize(actor, "query", target);
    return found;
  }

  messages(actor: Principal, trace: TraceId): readonly Message[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.messages().filter((m) => containerOf(m.target) === trace);
  }

  records(actor: Principal, trace: TraceId): readonly ExecutionRecord[] {
    this.#authorize(actor, "query", trace);
    return this.#runtime.records().filter((r) => r.traceid === trace);
  }

  /**
   * 读一个对象版本。
   *
   * DQL 此前只覆盖了实例侧（子树 / 锁 / 消息 / 记录），**对象侧是空的** ——
   * 而 C5 之后"东西经历了什么"全在版本历史里，不给读法等于把主要的可观测面
   * 关在门外。target 用 object_id：它本来就是 traceid 命名空间，
   * 同一套段边界前缀判定直接通吃（行级安全覆盖到对象）。
   */
  read(actor: Principal, ref: Ref): ObjectVersion {
    this.#authorize(actor, "query", objectIdOf(ref));
    return this.#store.resolve(ref);
  }

  head(actor: Principal, objectId: string): ObjectVersion {
    this.#authorize(actor, "query", objectId);
    return this.#store.head(objectId);
  }

  history(actor: Principal, objectId: string): readonly ObjectVersion[] {
    this.#authorize(actor, "query", objectId);
    return this.#store.history(objectId);
  }

  /**
   * 因果查询：这条消息是由哪些消息导致的。
   *
   * RunSnapshot 存在的全部理由就是承担 traceid 表达不了的那半边因果 ——
   * 扇出后子消息 traceid 相同却各有前因，汇聚时一条输出有多个前因。
   * 查询早就实现了，只是一直没有出口，等于把主要的可观测面关在门外。
   */
  causesOf(actor: Principal, scope: TraceId, messageId: string): readonly string[] {
    this.#authorizeRoot(actor, "query", scope);
    return this.#runtime.causesOf(messageId);
  }

  /** 认领孤儿执行。见 `Runtime.reconcile` —— 复用失败路径，不是新状态机。 */
  reconcile(actor: Principal, scope: TraceId): readonly StepFailure[] {
    this.#authorizeRoot(actor, "run", scope);
    return this.#runtime.reconcile();
  }

  /** 把整树中够条件的实例收进终态，要求根实例权限。 */
  settleAll(actor: Principal, scope: TraceId): readonly TraceId[] {
    this.#authorizeRoot(actor, "settle", scope);
    return this.#runtime.settleAll();
  }
}

/** `id@3` → `id`。授权按对象身份判定，与具体第几版无关。 */
function objectIdOf(ref: Ref): string {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}
