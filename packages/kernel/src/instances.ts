/**
 * 实例树 —— 容器 is-a 实例。
 *
 * 对应 FOUNDATION_V5.md：
 *   C1 根容器唯一，不由任何模板创建
 *   C2 traceid 是实例路径，容器是层级发生器
 *   C4 实例终身 pin 创建时的定义版本，不做热迁移
 *
 * **寻址**：一段。`Endpoint` 是 `{instance, port}`，而 `instance` 就是路径 ——
 * 容器嵌套产生层级，节点占最后一段（V6 阶段 1b）。容器由 `parentTrace` 派生。
 *
 * 这里原来写的是"节点用 `(容器 traceid, node_id)` 寻址，不产生更深的 traceid 段，
 * 所以 node_id 的字符集不受 traceid 段规则约束"—— **两句都不再成立**：
 * 节点 id 就是路径的一段，字符集与 traceid 段并成了一套（见 `NodeId`）。
 *
 * **纯转发边暂不物化为实例对象**：它在本阶段没有任何状态、永不持锁、随容器生死（C3），
 * 物化一个空对象是纯开销。等运行时动态边出现（容器工具编辑内网）再物化 —— 那时它才有生命周期。
 */

import {
  type AliasBinding,
  MessageContract,
  ContainerTemplate,
  TemplateOverlay,
  type TemplateIssue,
  applyOverlay,
  isOverlay,
  type Json,
  type JsonObject,
  type Port,
  type Ref,
  type TraceId,
  TRACE_SEGMENT_PATTERN,
  childTrace,
  isDescendantOf,
  formatContractIssues,
  validateContainerTemplate,
  validateContract,
  type ObjectVersion,
} from "@nodeflow/contracts";
import { extractPortVars, formatExtractionFailures } from "./extract.js";
import { InvariantError, TemplateValidationError, invariant } from "./errors.js";
import { ObjectStore, deepFreeze } from "./store.js";
import type { Snapshotable } from "./tx.js";
import {
  type MaterializedBinding,
  checkAliases,
  checkRootAliases,
  childBindings,
  rootBindings,
} from "./aliases/index.js";

export type InstanceStatus = "OPEN" | "TERMINAL";

export interface ContainerInstance {
  readonly traceid: TraceId;
  /** 终身 pin（C4）：创建时定版，永不迁移。要新版就创建新实例。 */
  readonly templateRef: Ref;
  readonly status: InstanceStatus;
  /**
   * 截断栅栏（设计门 4 / 不变量 L3）。
   *
   * 强制截断的气密性靠这个数，不靠 `backend.cancel` —— 后者只是 best effort，
   * 远端可能已经在返回路上。截断时推进 generation，迟到的结果因为对不上而必然作废。
   */
  readonly generation: number;
  /**
   * 提交序号。**只由提交推进**（apply / 同步 commit），claim 不推进 ——
   * 否则 RunSnapshot 的 seq 会出现空洞。
   */
  readonly seq: number;
  /** 从父容器的哪个子槽创建的。根实例没有。回程通知要靠它找 `exit` 声明。 */
  readonly slot?: string;
  /**
   * **物化的别名绑定表** —— 创建时算一次，此后不变（见 `aliases.ts`）。
   *
   * 与 `templateRef` 的 pin 同一条论证（C4 / §5.1）：lazy 地每次读走祖先链，
   * 祖先事后改绑定就会让在途实例的寻址漂掉。物化之后**实例自给自足**，
   * 解析不依赖任何其他实例的定义 —— 这是租户能跨进程的前提。
   */
  readonly bindings: readonly MaterializedBinding[];
}

export class InstanceRegistry implements Snapshotable {
  readonly #store: ObjectStore;
  readonly #instances = new Map<TraceId, ContainerInstance>();
  #root: TraceId | null = null;

  /** 实例都是冻结对象，浅拷贝即完整快照。 */
  snapshot(): unknown {
    return { instances: new Map(this.#instances), root: this.#root };
  }

  restore(snap: unknown): void {
    const s = snap as { instances: Map<TraceId, ContainerInstance>; root: TraceId | null };
    this.#instances.clear();
    for (const [k, v] of s.instances) this.#instances.set(k, v);
    this.#root = s.root;
  }

  constructor(store: ObjectStore) {
    this.#store = store;
  }

  get rootTrace(): TraceId | null {
    return this.#root;
  }

  /**
   * 创建根容器（C1）。
   *
   * 根**不由模板创建** —— `configRef` 指向的是启动配置 `root_config`，
   * 不是某个容器的 `children` 槽。只能成功一次。
   */
  createRoot(configRef: Ref, id = "root"): ContainerInstance {
    if (this.#root !== null) {
      throw new InvariantError(
        `根容器唯一且已存在：${this.#root}。子工作流应经 spawn 从已声明的 children 槽创建`,
      );
    }
    invariant(
      TRACE_SEGMENT_PATTERN.test(id),
      `根容器 id ${JSON.stringify(id)} 不是合法 traceid 段`,
    );
    const instance = this.#materialize(id, configRef);
    this.#root = id;
    return instance;
  }

  /**
   * 从父容器**已声明的** children 槽创建子容器。
   *
   * 第一不变量：只能选已声明的槽，不能构造模板引用。
   */
  /**
   * ⚠️ **这个不拿子容器锁。** 要拿锁的是 `Runtime.spawn`。
   *
   * 两个入口只差一件事，而那件事决定"父容器能不能提前收口"。直接调这里
   * 建出来的子实例**不会挡住父终止** —— 写夹具时踩到过：整份快照
   * 一把锁都没有，而看起来一切正常。
   *
   * 生产路径（ControlPlane / handler 的 ctx.spawn / MCP）全部走 Runtime，
   * 这里只留给注册表内部与真正不需要生命周期约束的场合。
   */
  spawn(parentTrace: TraceId, slot: string, segment: string): ContainerInstance {
    const parent = this.get(parentTrace);
    invariant(
      parent.status === "OPEN",
      `实例 ${parentTrace} 已 ${parent.status}，不得创建子实例`,
    );

    const parentTemplate = this.#template(parent.templateRef);
    const declared = parentTemplate.children[slot];
    if (declared === undefined) {
      const available = Object.keys(parentTemplate.children).sort().join(", ") || "（无）";
      throw new InvariantError(
        `容器 ${parentTrace} 未声明子槽 \`${slot}\`。可用子槽：${available}`,
      );
    }

    invariant(
      TRACE_SEGMENT_PATTERN.test(segment),
      `实例段 ${JSON.stringify(segment)} 不是合法 traceid 段`,
    );
    const trace = childTrace(parentTrace, segment);
    if (this.#instances.has(trace)) {
      throw new InvariantError(`实例已存在：${trace}`);
    }
    return this.#materialize(trace, declared.template, slot, parent, declared.bindings ?? []);
  }

  get(trace: TraceId): ContainerInstance {
    const found = this.#instances.get(trace);
    if (found === undefined) throw new InvariantError(`未知实例：${trace}`);
    return found;
  }

  has(trace: TraceId): boolean {
    return this.#instances.has(trace);
  }

  /** 解析实例 pin 住的模板。**永远走 pin 的 ref，不取 head**（C4）。 */
  template(trace: TraceId): ContainerTemplate {
    return this.#template(this.get(trace).templateRef);
  }

  /**
   * 这个容器有哪些**执行位点** —— 按节点声明序。
   *
   * 位点就是地址（V6 阶段 1b：`{instance, port}` 里的那个 `instance`），
   * 所以"有哪些位点"是个可以直接问的问题。此前它被**五处**各自算了一遍
   * （kernel 两处、state 一处、cli 两处），每处都是
   * `Object.keys(template(t).nodes)` 之后自己拼 `${t}/${n}` ——
   * 同一个概念散在三个包里，而拼法只要有一处写歪就是查不出来的空结果。
   *
   * 走 `childTrace` 而不是模板字符串：顺带把"节点 id 必须是合法路径段"这条
   * 在每次枚举时也过一遍。
   */
  sites(trace: TraceId): readonly TraceId[] {
    return Object.keys(this.template(trace).nodes).map((node) => childTrace(trace, node));
  }

  /**
   * 子树查询（C2）—— 前缀落在**段边界**上，`job-1` 不会捞到 `job-10`。
   * 含自身，按 traceid 字典序稳定排列。
   */
  subtree(trace: TraceId): readonly ContainerInstance[] {
    return [...this.#instances.values()]
      .filter((i) => isDescendantOf(i.traceid, trace))
      .sort((a, b) => (a.traceid < b.traceid ? -1 : a.traceid > b.traceid ? 1 : 0));
  }

  /** 直接子容器（不含更深层）。 */
  children(trace: TraceId): readonly ContainerInstance[] {
    const depth = trace.split("/").length;
    return this.subtree(trace).filter(
      (i) => i.traceid !== trace && i.traceid.split("/").length === depth + 1,
    );
  }

  setStatus(trace: TraceId, status: InstanceStatus): ContainerInstance {
    const current = this.get(trace);
    const next: ContainerInstance = { ...current, status };
    this.#instances.set(trace, Object.freeze(next));
    return next;
  }

  /** 推进提交序号，返回**新**序号。 */
  bumpSeq(trace: TraceId): number {
    const current = this.get(trace);
    const next: ContainerInstance = { ...current, seq: current.seq + 1 };
    this.#instances.set(trace, Object.freeze(next));
    return next.seq;
  }

  /** 推进截断栅栏（L3）。截断的第 0 步。 */
  bumpGeneration(trace: TraceId): ContainerInstance {
    const current = this.get(trace);
    const next: ContainerInstance = { ...current, generation: current.generation + 1 };
    this.#instances.set(trace, Object.freeze(next));
    return next;
  }

  #materialize(
    trace: TraceId,
    templateRef: Ref,
    slot?: string,
    parent?: ContainerInstance,
    slotBindings?: readonly AliasBinding[],
  ): ContainerInstance {
    const template = this.#template(templateRef);
    // 绑定表在这里算一次就定死 —— 与 templateRef 的 pin 同一时刻、同一理由
    const bindings =
      parent === undefined
        ? rootBindings(trace, template)
        : childBindings(trace, template, parent.traceid, parent.bindings, slotBindings ?? []);
    const instance: ContainerInstance = Object.freeze({
      traceid: trace,
      templateRef,
      status: "OPEN" as const,
      bindings,
      generation: 0,
      seq: 0,
      ...(slot === undefined ? {} : { slot }),
    });
    this.#instances.set(trace, instance);
    return instance;
  }

  /**
   * 解析后的模板按**版本对象本身**记住一份。
   *
   * 之前每次调用都对整份模板做一次 zod `safeParse`，而 `#pickWork` 对
   * **每一步的每一条排队消息**都调它 —— 于是 drain 是 M²/2 次全量解析。
   * 实测 1600 条消息 drain 要 31 秒，每条的成本随队列长度线性增长。
   *
   * 键用 `ObjectVersion` 而不是 ref 字符串，**过期在结构上不可能**：
   * 版本是深冻结的，每次 `put` 造一个新对象；事务回滚是把数组截短，
   * 被丢掉的那个对象再也拿不到。所以"同一个 ref 指向不同内容"这件事，
   * 在这里表现为**换了一个键**，而不是一条脏记录。
   *
   * 这不是记账 —— 记账会漂是因为两份拷贝各自维护，而这里的键就是内容本身。
   * 前端对固定版本的模板早就这么干了（"不可变、按版本寻址 ⇒ 拉一次，
   * 缓存永不失效"），内核这边反倒在重复解析同一份定义。
   *
   * `WeakMap` ⇒ 版本被丢掉时条目自己走，不留内存。
   */
  readonly #parsed = new WeakMap<ObjectVersion, ContainerTemplate>();

  #template(ref: Ref): ContainerTemplate {
    const version = this.#store.resolve(ref);
    const hit = this.#parsed.get(version);
    if (hit !== undefined) return hit;
    const parsed = ContainerTemplate.safeParse(version.body);
    if (!parsed.success) {
      throw new InvariantError(
        `模板 ${ref} 不是合法容器模板：${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("；")}`,
      );
    }
    // zod 解析生成新对象；原版本冻结不代表解析结果也冻结。
    deepFreeze(parsed.data);
    this.#parsed.set(version, parsed.data);
    return parsed.data;
  }
}

/**
 * 注册容器模板：**注册期跑全量校验**，通过才落版本。
 *
 * 这条修的是 V4 的实质缺陷 —— 那边 `propose` 完全不校验，
 * 校验只在 approve 时才经 publish 触发，等于人成了 AI 的语法检查器，
 * 自我修正的内循环不存在（FOUNDATION §14 缺陷 1）。
 */
/**
 * 执行面声明的校验器 —— **一条缝**。
 *
 * `agent` 段的 schema 归执行面（`@nodeflow/sandbox` 的 `AgentSpec`）：
 * `workspace` / `capabilities` / `profile` 全是"怎么跑"，契约层不该认识它们。
 * 但**搬走不等于推到运行期**：接上这个校验器，"workspace 既给 source 又给 from"
 * 这类错仍然在注册期被拒（§1：注册期拒绝，不做运行期救火）。
 *
 * 不给就只剩契约层那条凭据扫描（`NodeExecutionSpec`）—— 那条是对象库的规矩，
 * 永远在。
 *
 * 按判据它是合法的缝：**换掉它一条内核不变量都不破** —— 端口白名单、子槽、
 * 别名、预算全不经过它。
 */
export type ExecutionSpecValidator = (spec: unknown, where: string) => readonly string[];

export function registerContainerTemplate(
  store: ObjectStore,
  templateId: string,
  spec: unknown,
  kind = "container_template",
  validateExecutionSpec?: ExecutionSpecValidator,
): Ref {
  const prepared = prepareContainerTemplate(store, templateId, spec, kind, validateExecutionSpec);
  const version = store.put(templateId, prepared.kind, prepared.body,
    prepared.base === undefined ? undefined : { derived_from: [prepared.base] });
  return `${version.object_id}@${version.version}`;
}

/** 注册与干跑共用的纯校验/物化阶段，不写对象库。 */
export function prepareContainerTemplate(
  store: ObjectStore,
  templateId: string,
  spec: unknown,
  kind = "container_template",
  validateExecutionSpec?: ExecutionSpecValidator,
): { kind: string; body: JsonObject; base?: Ref } {
  if (templateId.length === 0 || templateId.includes("@")) {
    throw new TemplateValidationError("定义 id 必须非空且不得含 @", [
      { where: "id", code: "invalid_id", message: "定义 id 必须非空且不得含 @" },
    ]);
  }
  /**
   * **按 kind 分派校验。**
   *
   * 这个函数是"注册一份定义"的唯一入口，而定义不止容器模板一种：
   * 端口的 `contract` 指向的是 `message_contract` 对象。此前无论 kind 是什么
   * 都按 `ContainerTemplate` 校验 —— 于是**契约对象根本注册不进去**，
   * 端口的入站/出站校验虽然实现了，却没有任何入口能给它一份 schema。
   * 与 K5（AgentSpec）、E1（backend 没接线）是同一类：实现在，路不通。
   */
  if (kind === "message_contract") {
    const parsed = MessageContract.safeParse(spec);
    if (!parsed.success) {
      throw new TemplateValidationError(
        `契约 ${templateId} 结构非法：${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
          .join("；")}`,
        parsed.error.issues.map((i) => ({ where: i.path.join("."), code: i.code, message: i.message })),
      );
    }
    return { kind, body: parsed.data as unknown as JsonObject };
  }

  // 覆盖层：解析继承链 → 施加 → 校验合并结果 → 存成物化定义（§5.1）
  const overlay = isOverlay(spec) ? materializeOverlay(store, templateId, spec) : undefined;

  const parsed = ContainerTemplate.safeParse(overlay?.merged ?? spec);
  if (!parsed.success) {
    throw new TemplateValidationError(
      `模板 ${templateId} 结构非法：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
      parsed.error.issues.map((i) => ({ where: i.path.join("."), code: i.code, message: i.message })),
    );
  }
  const issues = [
    ...validateContainerTemplate(parsed.data),
    ...validateChildEntries(store, parsed.data),
    ...validateContractRefs(store, parsed.data),
    ...validateSignalPayloads(store, parsed.data),
    /**
     * 别名的注册期判定（`aliases.ts`）。跨模板的那半与 `validateChildEntries`
     * 同一个时机、同一条路 —— 父注册时它已经持有子模板的 ref。
     *
     * 只有**根配置**要求"一个别名都不欠"：非根模板还会被装进更外层，
     * 欠账由那时候的父来还。这正是 §3.1「根是递归的终止条件」。
     */
    ...validateExecutionSpecs(parsed.data, validateExecutionSpec),
    ...(kind === "root_config"
      ? checkRootAliases(templateId, parsed.data, (ref) => resolveTemplate(store, ref))
      : checkAliases(templateId, parsed.data, (ref) => resolveTemplate(store, ref)).issues),
  ];
  if (issues.length > 0) {
    throw new TemplateValidationError(
      [`模板 ${templateId} 连接期校验失败：`, ...issues.map((i) => `${i.where}：${i.message}`)]
        .join("\n  "),
      issues.map((i) => ({ ...i, code: "link_error" })),
    );
  }
  return {
    kind: overlay === undefined ? kind : "materialized",
    body: parsed.data as unknown as JsonObject,
    ...(overlay === undefined ? {} : { base: overlay.base }),
  };
}

/**
 * 资产名的合法形状：路径段，可多级，不得越出自己的命名空间。
 *
 * **首字符允许点号。**危险的是相对路径段本身（`.` 与 `..`），不是点号这个字符 ——
 * 那两个下面单独拒。原来把首字符的点一并禁掉，代价是 `.gitignore` 这类
 * 文件根本当不成产物；而落盘那侧（`state/paths.ts`）对它们早有处理：
 * 只在整段是 `.` / `..` 或 Windows 保留名时才转义首字符。
 */
const ASSET_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * 把资产名限定到实例的命名空间：`<traceid>/<name>`。
 *
 * 对应 FOUNDATION_V5.md §7.7。修掉的 bug 是：`ctx.put("results", …)` 原本写的是
 * **全局** object_id，`job-1/a` 与 `job-1/b` 会落到同一个对象上互相污染 ——
 * 而汇聚正是"策略节点不需要"的承重论据，单实例测试看不出来。
 *
 * `..` 与前导 `/` 一律拒绝：命名空间是安全边界，不是命名约定。
 */
export function namespacedId(trace: TraceId, name: string): string {
  const segments = name.split("/");
  for (const seg of segments) {
    if (!ASSET_SEGMENT.test(seg) || seg === "." || seg === "..") {
      throw new InvariantError(
        `资产名 ${JSON.stringify(name)} 非法：只允许多级标识符路径，` +
          `不得含空段、\`..\` 或前导 \`/\`（它必须落在实例 ${trace} 的命名空间内）`,
      );
    }
  }
  return `${trace}/${name}`;
}

/**
 * **eager 物化继承**（不变量 C4 / §5.1）。
 *
 * 覆盖层在**注册时**就解析成一份完整定义并落成 `kind="materialized"` 的版本，
 * 实例 pin 的是这份物化产物。于是：
 *
 *   - 改基模板 → 发新版本 → **已有实例与已注册的物化定义都不受影响**
 *   - 物化产物本身是版本化对象 ⇒ 可回溯、可 diff、可作画布真相源
 *   - `provenance.derived_from` 记住基定义，继承链可追
 *
 * 选 eager 而不是 lazy 的理由：lazy 每次读走继承链，会**让 C4 的 pin 变成谎言**
 * —— 实例说自己定版了，读出来的东西却会随基模板变。
 *
 * 在注册时物化（而不是等到实例化）比设计稿更严一格：它让"注册即完整校验"
 * 这条继续成立，实例化只负责 pin 一个已经验证过的 ref。
 */
function materializeOverlay(
  store: ObjectStore,
  templateId: string,
  spec: unknown,
): { readonly merged: ContainerTemplate; readonly base: Ref } {
  const parsedOverlay = TemplateOverlay.safeParse(spec);
  if (!parsedOverlay.success) {
    throw new TemplateValidationError(
      `覆盖层 ${templateId} 结构非法：${parsedOverlay.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
      parsedOverlay.error.issues.map((i) => ({ where: i.path.join("."), code: i.code, message: i.message })),
    );
  }
  const overlay = parsedOverlay.data;

  let baseVersion;
  try {
    baseVersion = store.resolve(overlay.extends);
  } catch {
    throw new TemplateValidationError(
      `覆盖层 ${templateId} 的 extends 指向未知定义：${overlay.extends}`,
      [{ where: "extends", code: "missing_definition", message: `未知定义 ${overlay.extends}` }],
    );
  }
  const base = ContainerTemplate.safeParse(baseVersion.body);
  if (!base.success) {
    throw new TemplateValidationError(
      `覆盖层 ${templateId} 的基定义 ${overlay.extends} 不是合法容器模板`,
      [{ where: "extends", code: "invalid_definition", message: `${overlay.extends} 不是容器模板` }],
    );
  }

  const outcome = applyOverlay(base.data, overlay);
  if (!outcome.ok) {
    throw new TemplateValidationError(
      [`覆盖层 ${templateId} 施加失败：`, ...outcome.issues.map((i) => `${i.where}：${i.message}`)].join("\n  "),
      outcome.issues.map((i) => ({ ...i, code: "overlay_error" })),
    );
  }

  // 只负责物化；完整校验与落库回到注册入口，避免两条校验路径漂移。
  return { merged: outcome.merged, base: overlay.extends };
}

/**
 * 跨模板校验：端口的 `contract` 引用必须存在，且**正文得真是一份契约**。
 *
 * 此前完全不查，两种错法都很难发现：
 *   - 指向不存在的引用 → 注册成功，运行期解析失败，消息永久卡在 QUEUED
 *   - 指向一个**容器模板** → 端口校验拿它当 schema，于是**静默放行所有载荷**，
 *     形同虚设而没有任何迹象
 *
 * 查的是**正文能否解析成 MessageContract**，不是 kind 对不对。一开始写的是
 * 后者，当场撞红了一条老测试：它用 kind `contract` 存契约、一直工作良好 ——
 * 因为决定行为的从来就是正文。kind 是给人和工具看的标签，
 * **按标签判断能力**会既冤枉对的、又放过错的（kind 对而正文是垃圾的照样过）。
 * `MessageContract` 是 `.strict()` 的，容器模板正文一解析就炸，正好挡住那条。
 */
/**
 * `unavailable` 必须真的**吃得下** —— 注册期就判定。
 *
 * 声明"等不到回复时当作收到这个"只是一半；另一半是它得过得了自己 callback
 * 端口的两道关：**契约**与 **servo 提取**。过不了就是运行期一条 FAILED 消息，
 * 而请求方的 handler 根本不会被叫醒 —— 通知发了等于没发，而且**没有任何
 * 红灯**：发送侧绿的，接收侧绿的，中间没人走。
 *
 * 这两道关的输入在同一个模板里（callback 端口是**本节点**的，M3 已保证），
 * 所以不必读服务方的定义 —— 租户纪律不破。
 *
 * 顺带把子终止通知那条也一起判了：`children[slot].exit` 收的是内核造的
 * 固定形状 `{slot, traceid, status}`，此前**没有任何东西保证它对得上**，
 * 能通纯属模板作者猜对了字段名。
 */
function validateSignalPayloads(
  store: ObjectStore,
  tpl: ContainerTemplate,
): readonly TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  const fits = (port: Port, payload: Json, where: string, what: string): void => {
    if (port.direction !== "receive") return;
    if (port.contract !== undefined) {
      try {
        const schema = store.resolve(port.contract).body as unknown as MessageContract;
        const bad = validateContract(schema, payload);
        if (bad.length > 0) {
          issues.push({ where, message: `${what}过不了该端口的契约：${formatContractIssues(bad)}` });
          return;
        }
      } catch {
        // 契约引用本身有问题，validateContractRefs 会报，这里不重复
        return;
      }
    }
    const extracted = extractPortVars(port, payload);
    if (!extracted.ok) {
      issues.push({
        where,
        message:
          `${what}过不了该端口的 servo：${formatExtractionFailures(extracted.failures)}。` +
          "运行期这会让消息直接进 FAILED，而 handler 根本不会被叫醒",
      });
    }
  };

  for (const [nodeId, node] of Object.entries(tpl.nodes)) {
    for (const [portName, port] of Object.entries(node.ports)) {
      if (port.direction !== "emit" || port.callback === undefined) continue;
      const target = node.ports[port.callback];
      // callback 落点存不存在由 validateContainerTemplate 判（M3），这里只管形状
      if (target === undefined) continue;
      fits(
        target,
        port.unavailable as Json,
        `nodes.${nodeId}.ports.${portName}.unavailable`,
        "声明的 `unavailable` 载荷",
      );
    }
  }

  // 子终止通知：内核造的固定形状，落在父声明的 exit 端点上
  for (const [slot, child] of Object.entries(tpl.children)) {
    if (child.exit === undefined) continue;
    const port = tpl.nodes[child.exit.node]?.ports[child.exit.port];
    if (port === undefined) continue; // 端点存在性由别处判
    fits(
      port,
      { slot, traceid: `${slot}-示例`, status: "TERMINAL" },
      `children.${slot}.exit`,
      "子实例终止通知（内核形状 `{slot, traceid, status}`）",
    );
  }

  return issues;
}

function validateContractRefs(
  store: ObjectStore,
  tpl: ContainerTemplate,
): readonly TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const [nodeId, node] of Object.entries(tpl.nodes)) {
    for (const [portName, port] of Object.entries(node.ports)) {
      if (port.direction !== "receive" || port.contract === undefined) continue;
      const where = `nodes.${nodeId}.ports.${portName}.contract`;
      let body;
      try {
        body = store.resolve(port.contract).body;
      } catch {
        issues.push({ where, message: `契约引用 ${port.contract} 不存在` });
        continue;
      }
      if (!MessageContract.safeParse(body).success) {
        issues.push({
          where,
          message:
            `契约引用 ${port.contract} 的正文不是一份合法 MessageContract。` +
            "指错对象不会报错，只会让端口校验静默放行所有载荷",
        });
      }
    }
  }
  return issues;
}

/**
 * 跨模板校验：子模板必须存在；声明的 `entry` 必须是其中的 receive 端口。
 *
 * 纯结构校验留在 contracts（无依赖、可单测）；**需要解析引用的校验放这里**，
 * 因为只有内核持有 store。这条边界值得守住 —— 一旦 contracts 依赖 store，
 * 它就不再是可以独立给画布和 LLM 用的纯契约层了。
 */
function validateChildEntries(
  store: ObjectStore,
  tpl: ContainerTemplate,
): readonly TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const [slotId, slot] of Object.entries(tpl.children)) {
    let childTpl;
    try {
      childTpl = ContainerTemplate.parse(store.resolve(slot.template).body);
    } catch {
      issues.push({
        where: `children.${slotId}.template`,
        message: `子模板 ${slot.template} 无法解析为合法容器模板`,
      });
      continue;
    }
    if (slot.entry === undefined) continue;
    const node = childTpl.nodes[slot.entry.node];
    if (node === undefined) {
      issues.push({
        where: `children.${slotId}.entry`,
        message:
          `子模板 ${slot.template} 无节点 \`${slot.entry.node}\`。可用节点：` +
          `${Object.keys(childTpl.nodes).sort().join(", ") || "（无）"}`,
      });
      continue;
    }
    const port = node.ports[slot.entry.port];
    if (port === undefined || port.direction !== "receive") {
      issues.push({
        where: `children.${slotId}.entry`,
        message:
          `\`${slot.entry.node}.${slot.entry.port}\` 必须是子模板里已声明的 receive 端口。可用：` +
          `${
            Object.entries(node.ports)
              .filter(([, p]) => p.direction === "receive")
              .map(([n]) => n)
              .sort()
              .join(", ") || "（无）"
          }`,
      });
    }
  }
  return issues;
}

/** 按 ref 取一份容器模板；取不到（或不是模板）返回 undefined。 */
function resolveTemplate(store: ObjectStore, ref: Ref): ContainerTemplate | undefined {
  try {
    return ContainerTemplate.parse(store.resolve(ref).body);
  } catch {
    return undefined;
  }
}

/** 逐个 agent 节点跑执行面校验器。没给校验器就什么都不查。 */
function validateExecutionSpecs(
  tpl: ContainerTemplate,
  validate: ExecutionSpecValidator | undefined,
): readonly TemplateIssue[] {
  if (validate === undefined) return [];
  const issues: TemplateIssue[] = [];
  for (const [nodeId, node] of Object.entries(tpl.nodes)) {
    if (node.agent === undefined) continue;
    for (const message of validate(node.agent, `nodes.${nodeId}.agent`)) {
      issues.push({ where: `nodes.${nodeId}.agent`, message });
    }
  }
  return issues;
}
