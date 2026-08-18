/**
 * 实例树 —— 容器 is-a 实例。
 *
 * 对应 FOUNDATION_V5.md：
 *   C1 根容器唯一，不由任何模板创建
 *   C2 traceid 是实例路径，容器是层级发生器
 *   C4 实例终身 pin 创建时的定义版本，不做热迁移
 *
 * **寻址分工**：容器嵌套产生 traceid 层级；节点是容器**内部**的，
 * 用 `(容器 traceid, node_id)` 寻址（这正是 `Endpoint` 的形状），不产生更深的 traceid 段。
 * 所以 node_id 的字符集不受 traceid 段规则约束。
 *
 * **纯转发边暂不物化为实例对象**：它在本阶段没有任何状态、永不持锁、随容器生死（C3），
 * 物化一个空对象是纯开销。等运行时动态边出现（容器工具编辑内网）再物化 —— 那时它才有生命周期。
 */

import {
  ContainerTemplate,
  TemplateOverlay,
  type TemplateIssue,
  applyOverlay,
  isOverlay,
  type JsonObject,
  type Ref,
  type TraceId,
  TRACE_SEGMENT_PATTERN,
  childTrace,
  isDescendantOf,
  validateContainerTemplate,
} from "@nodeflow/contracts";
import { InvariantError, invariant } from "./errors.js";
import { ObjectStore } from "./store.js";
import type { Snapshotable } from "./tx.js";

export type InstanceStatus = "OPEN" | "TERMINAL";

/**
 * 节点实例。
 *
 * **没有 persistent 状态**（不变量 C5）：累加、计数、择优一律读版本历史。
 * 节点内私有状态是本项目一直在消灭的那类东西，而 ObjectStore 的版本历史
 * 已经是累加器 + 计数器 + 择优候选集，且更好——已版本化、可观测、跨实例可见。
 */
export interface NodeInstance {
  readonly nodeId: string;
}

export interface ContainerInstance {
  readonly traceid: TraceId;
  /** 终身 pin（C4）：创建时定版，永不迁移。要新版就创建新实例。 */
  readonly templateRef: Ref;
  readonly status: InstanceStatus;
  readonly nodes: ReadonlyMap<string, NodeInstance>;
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
    return this.#materialize(trace, declared.template);
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

  #materialize(trace: TraceId, templateRef: Ref): ContainerInstance {
    const template = this.#template(templateRef);
    const nodes = new Map<string, NodeInstance>();
    for (const nodeId of Object.keys(template.nodes)) {
      nodes.set(nodeId, Object.freeze({ nodeId }));
    }
    const instance: ContainerInstance = Object.freeze({
      traceid: trace,
      templateRef,
      status: "OPEN" as const,
      nodes,
      generation: 0,
      seq: 0,
    });
    this.#instances.set(trace, instance);
    return instance;
  }

  #template(ref: Ref): ContainerTemplate {
    const version = this.#store.resolve(ref);
    const parsed = ContainerTemplate.safeParse(version.body);
    if (!parsed.success) {
      throw new InvariantError(
        `模板 ${ref} 不是合法容器模板：${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("；")}`,
      );
    }
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
export function registerContainerTemplate(
  store: ObjectStore,
  templateId: string,
  spec: unknown,
  kind = "container_template",
): Ref {
  // 覆盖层：解析继承链 → 施加 → 校验合并结果 → 存成物化定义（§5.1）
  if (isOverlay(spec)) return materializeOverlay(store, templateId, spec);

  const parsed = ContainerTemplate.safeParse(spec);
  if (!parsed.success) {
    throw new InvariantError(
      `模板 ${templateId} 结构非法：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
    );
  }
  const issues = [
    ...validateContainerTemplate(parsed.data),
    ...validateChildEntries(store, parsed.data),
  ];
  if (issues.length > 0) {
    throw new InvariantError(
      [`模板 ${templateId} 连接期校验失败：`, ...issues.map((i) => `${i.where}：${i.message}`)]
        .join("\n  "),
    );
  }
  const version = store.put(templateId, kind, parsed.data as unknown as JsonObject);
  return `${version.object_id}@${version.version}`;
}

/** 资产名的合法形状：路径段，可多级，不得越出自己的命名空间。 */
const ASSET_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

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
    if (!ASSET_SEGMENT.test(seg) || seg === "..") {
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
function materializeOverlay(store: ObjectStore, templateId: string, spec: unknown): Ref {
  const parsedOverlay = TemplateOverlay.safeParse(spec);
  if (!parsedOverlay.success) {
    throw new InvariantError(
      `覆盖层 ${templateId} 结构非法：${parsedOverlay.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
    );
  }
  const overlay = parsedOverlay.data;

  let baseVersion;
  try {
    baseVersion = store.resolve(overlay.extends);
  } catch {
    throw new InvariantError(
      `覆盖层 ${templateId} 的 extends 指向未知定义：${overlay.extends}`,
    );
  }
  const base = ContainerTemplate.safeParse(baseVersion.body);
  if (!base.success) {
    throw new InvariantError(
      `覆盖层 ${templateId} 的基定义 ${overlay.extends} 不是合法容器模板`,
    );
  }

  const outcome = applyOverlay(base.data, overlay);
  if (!outcome.ok) {
    throw new InvariantError(
      [`覆盖层 ${templateId} 施加失败：`, ...outcome.issues.map((i) => `${i.where}：${i.message}`)].join("\n  "),
    );
  }

  // 合并结果必须过与基定义**同一套**连接期校验 —— 覆盖不是逃生舱
  const issues = validateContainerTemplate(outcome.merged);
  if (issues.length > 0) {
    throw new InvariantError(
      [`覆盖层 ${templateId} 的合并结果连接期校验失败：`, ...issues.map((i) => `${i.where}：${i.message}`)].join("\n  "),
    );
  }

  const version = store.put(
    templateId,
    "materialized",
    outcome.merged as unknown as JsonObject,
    { at_seq: 0, derived_from: [overlay.extends] },
  );
  return `${version.object_id}@${version.version}`;
}

/**
 * 跨模板校验：子槽的 `entry` 必须是子模板里已声明的 receive 端口。
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
    if (slot.entry === undefined) continue;
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
