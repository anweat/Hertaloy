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

export type InstanceStatus = "OPEN" | "TERMINAL";

export interface NodeInstance {
  readonly nodeId: string;
  /** 跨轮长期状态。本阶段恒为空对象，调度落地后才写入。 */
  readonly persistent: JsonObject;
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
}

export class InstanceRegistry {
  readonly #store: ObjectStore;
  readonly #instances = new Map<TraceId, ContainerInstance>();
  #root: TraceId | null = null;

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
      nodes.set(nodeId, Object.freeze({ nodeId, persistent: Object.freeze({}) }));
    }
    const instance: ContainerInstance = Object.freeze({
      traceid: trace,
      templateRef,
      status: "OPEN" as const,
      nodes,
      generation: 0,
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
  const parsed = ContainerTemplate.safeParse(spec);
  if (!parsed.success) {
    throw new InvariantError(
      `模板 ${templateId} 结构非法：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(根)"} ${i.message}`)
        .join("；")}`,
    );
  }
  const issues = validateContainerTemplate(parsed.data);
  if (issues.length > 0) {
    throw new InvariantError(
      `模板 ${templateId} 连接期校验失败：\n` +
        issues.map((i) => `  ${i.where}：${i.message}`).join("\n"),
    );
  }
  const version = store.put(templateId, kind, parsed.data as unknown as JsonObject);
  return `${version.object_id}@${version.version}`;
}
