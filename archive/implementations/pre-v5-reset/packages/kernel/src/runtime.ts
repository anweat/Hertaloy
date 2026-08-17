/**
 * Nodeflow V5 —— Runtime（对 Python nodeflow_v4.py 的 TS 移植）
 *
 * 实例层、消息入口、控制面，以及各模块的组合。
 * 对外 API 与 V4 对齐：register_* / instantiate / send / publish / subscribe /
 * step / drain / control / approve / 各种投影。
 */
import { AuthorizationError, InvariantError, ObjectStore, Principal, principalParse, principalStr, newKernelState } from "./core.js";
import type { ExecutionBackend, ExecutionRequest, InstanceState, KernelState, ObjectVersion } from "./core.js";
import type { RuntimeLike } from "./runtime-like.js";
import * as definitions from "./definitions.js";
import * as budget from "./budget.js";
import * as scheduling from "./scheduling.js";
import * as projections from "./projections.js";
import * as kernelTools from "./kernel-tools.js";
import { ControlPlane } from "./control.js";

export type { InvariantError, AuthorizationError, ObjectStore };
export type { ExecutionBackend, ExecutionRequest, KernelState, ObjectVersion };

export interface DraftDoc {
  draft_id: string;
  spec: Record<string, unknown>;
  layout: Record<string, unknown>;
  updated_at: string;
  updated_by: string;
}

export class Runtime implements RuntimeLike {
  st: KernelState;
  store: ObjectStore;
  controlPlane: ControlPlane;

  // ---- 配置（与 Python Runtime 常量一致） ----
  maxOutputRetries = 3;
  defaultMaxFanout = 32; // evaluator 未声明上限时的兜底
  defaultMaxAttempts = 3; // 失败重试上限（#7）
  charsPerToken = 2.2; // 拉丁字符（校准系数，改前先跑 test_context_budget）
  cjkCharsPerToken = 0.9; // CJK 密度高得多，分开算
  truncationOrder: Array<"transient" | "tail" | "messages"> = ["transient", "tail", "messages"];
  minKeep: Partial<Record<"transient" | "tail" | "messages", number>> = { messages: 1 };

  // ---- 持久化挂载点 ----
  onCommit: ((rt: RuntimeLike, ov: ObjectVersion) => void) | null = null;
  onChange: ((rt: RuntimeLike) => void) | null = null;

  /** 草稿工作区（画布）：spec + layout 分离，不进入语义注册表。 */
  drafts = new Map<string, DraftDoc>();
  onDraftChange: ((draft: DraftDoc) => void) | null = null;

  constructor() {
    this.st = newKernelState();
    this.store = new ObjectStore();
    this.controlPlane = new ControlPlane(this);
  }

  // ------------------------------------------------------------------
  // id / 挂载
  // ------------------------------------------------------------------

  nid(prefix: string): string {
    const id = `${prefix}-${String(this.st.ids).padStart(5, "0")}`;
    this.st.ids += 1;
    return id;
  }

  bumpIdCounter(): void {
    let seen = 0;
    const keys = [
      ...[...this.st.instances.keys()],
      ...[...this.st.messages.keys()],
      ...[...this.st.records.keys()],
    ];
    for (const entries of this.st.subs.values()) keys.push(...entries.map(([sid]) => sid));
    for (const key of keys) {
      const tail = key.split("-").pop() ?? "";
      if (/^\d+$/.test(tail)) seen = Math.max(seen, Number(tail));
    }
    this.st.ids = seen + 1;
  }

  setBackend(backend: ExecutionBackend): void {
    this.st.backend = backend;
    // 内核工具桥（P0-6）：subprocess 类 backend 在执行中回调编排面
    const b = backend as unknown as { kernelToolHandler?: (eid: string, name: string, args: Record<string, unknown>) => unknown };
    if (b && typeof b === "object") {
      b.kernelToolHandler = (eid, name, args) => this.dispatchKernelTool(eid, name, args);
    }
  }

  // ------------------------------------------------------------------
  // 内部写入口（projections._append_object / v4._notify_change）
  // ------------------------------------------------------------------

  appendObject(
    oid: string,
    body: Record<string, unknown>,
    opts: { kind?: string; provenance?: { graph_instance_id?: string | null; node_id?: string | null; execution_id?: string | null; at_seq: number; derived_from?: string[] } } = {}
  ): ObjectVersion {
    let kind = opts.kind;
    if (!kind) {
      kind = oid.startsWith("run/") ? "run" : oid.startsWith("annotation/") ? "annotation" : "object";
    }
    const ov = this.store.put(oid, kind, body, opts.provenance ?? null);
    // 每条 RunSnapshot 恰好对应一次提交 —— 持久化挂在这里，一处覆盖全部提交路径
    if (kind === "run" && this.onCommit) this.onCommit(this, ov);
    return ov;
  }

  notifyChange(): void {
    // 无 RunSnapshot 的提交边界（claim/release/订阅增删）也要落盘（P0-4/P0-5）
    if (this.onChange) this.onChange(this);
  }

  authorize(inst: InstanceState, actor: Principal | string): Principal {
    // actor 由可信边界注入，payload 不能自封身份（#10）
    const principal = principalParse(actor);
    if (!inst.controllers.has(principalStr(principal))) {
      throw new AuthorizationError(
        `principal ${principalStr(principal)} 无权控制 ${inst.gid}；可信主体：${JSON.stringify([...inst.controllers].sort())}`
      );
    }
    return principal;
  }

  contract(ref: string | null): Record<string, unknown> | null {
    if (ref == null) return null;
    if (!ref.includes("@")) throw new InvariantError(`契约引用必须精确到版本：${JSON.stringify(ref)}`);
    const schema = this.st.contracts.get(ref);
    if (!schema) throw new InvariantError(`未注册的契约：${ref}`);
    return schema;
  }

  // ------------------------------------------------------------------
  // 实例化
  // ------------------------------------------------------------------

  instantiate(templateRef: string, opts: { owner: string; params?: Record<string, unknown> | null; controllers?: string[] }): string {
    return this.instantiateLocked(templateRef, opts.owner, opts.params ?? {}, opts.controllers ?? []);
  }

  instantiateLocked(templateRef: string, owner: string, params?: Record<string, unknown> | null, controllers?: string[]): string {
    const tpl = this.st.templates.get(templateRef);
    if (!tpl) {
      throw new InvariantError(`未知模板：${templateRef}；模板必须先注册（register_graph_template）`);
    }
    const gid = this.nid("gi");
    const inst: InstanceState = {
      gid,
      templateRef,
      owner,
      status: "OPEN",
      seq: 0,
      params: { ...(params ?? {}) },
      nodes: new Map(),
      head: [...((params as Record<string, unknown> | undefined)?.context_head as string[] | undefined) ?? []],
      children: {},
      poolCursor: {},
      controllers: new Set([principalStr(principalParse(owner)), "system:core", ...(controllers ?? []).map((c) => principalStr(principalParse(c)))]),
      overflow: {},
    };
    for (const nodeId of Object.keys((tpl.nodes ?? {}) as Record<string, unknown>)) {
      inst.nodes.set(nodeId, { persistent: {}, tail: [], transient: [], lastContext: null, lastSpec: null, version: 0, sessionHandle: null });
    }
    this.st.instances.set(gid, inst);
    // 模板级订阅声明在实例化时解析成具体订阅
    for (const sub of (tpl.subscriptions ?? []) as Array<{ topic: string; endpoint: string }>) {
      const [nodeId, ep] = sub.endpoint.split(".", 2);
      this.subscribe(sub.topic, [gid, nodeId!, ep!]);
    }
    // R0 物化写入初始提交记录（FOUNDATION §5.3）。seq 仍为 0。
    this.appendObject(`run/${gid}`, {
      seq: 0,
      node: null,
      materialized: templateRef,
      owner,
      edges_traversed: [],
      endpoint: null,
    }, { kind: "run", provenance: { graph_instance_id: gid, at_seq: 0 } });
    return gid;
  }

  requireEndpointLocked(gid: string, nodeId: string, ep: string, where: string): void {
    // 入口校验：发送/订阅的目标必须是已声明实例上的已声明端点（P0-8）
    const inst = this.st.instances.get(gid);
    if (!inst) {
      throw new InvariantError(`${where}：未知实例 ${JSON.stringify(gid)}；可用实例：${JSON.stringify([...this.st.instances.keys()].sort())}`);
    }
    const tpl = this.st.templates.get(inst.templateRef);
    const node = ((tpl?.nodes ?? {}) as Record<string, Record<string, unknown>>)[nodeId];
    if (!node) {
      throw new InvariantError(`${where}：实例 ${gid} 没有节点 ${JSON.stringify(nodeId)}。可用节点：${JSON.stringify(Object.keys((tpl?.nodes ?? {}) as Record<string, unknown>).sort())}`);
    }
    if (!(ep in ((node.endpoints ?? {}) as Record<string, unknown>))) {
      throw new InvariantError(`${where}：节点 ${gid}/${nodeId} 没有端点 ${JSON.stringify(ep)}。可用端点：${JSON.stringify(Object.keys((node.endpoints ?? {}) as Record<string, unknown>).sort())}`);
    }
  }

  // ------------------------------------------------------------------
  // 消息入口
  // ------------------------------------------------------------------

  send(target: [string, string, string] | string[], payload: unknown): string {
    if (!Array.isArray(target) || target.length !== 3) {
      throw new InvariantError(`send target 必须形如 [gid, node_id, endpoint]，得到 ${JSON.stringify(target)}`);
    }
    const [gid, nodeId, ep] = target.map(String) as [string, string, string];
    const inst = this.st.instances.get(gid);
    if (!inst) throw new InvariantError(`未知实例：${gid}`);
    if (inst.status !== "OPEN") throw new InvariantError(`instance ${gid} is not OPEN（${inst.status}）`);
    this.requireEndpointLocked(gid, nodeId, ep, "send");
    return this.newMessage([gid, nodeId, ep], payload);
  }

  newMessage(
    target: [string, string, string],
    payload: unknown,
    opts: { callback?: [string, string, string] | null; topic?: string | null; mkind?: "DATA" | "REPLY"; exitPort?: string | null; requestId?: string | null } = {}
  ): string {
    const mid = this.nid("msg");
    // 入站快照：调用方事后修改原对象不得污染已入队的消息
    this.st.messages.set(mid, {
      mid,
      target,
      payload: structuredClone(payload),
      state: "QUEUED",
      callback: opts.callback ?? null,
      topic: opts.topic ?? null,
      mkind: opts.mkind ?? "DATA",
      attempts: 0,
      exitPort: opts.exitPort ?? null,
      requestId: opts.requestId ?? null,
    });
    return mid;
  }

  publish(topicId: string, payload: unknown, opts: { callback?: [string, string, string] | null; requestId?: string | null } = {}): string {
    const ids = this.publishLocked(topicId, payload, opts);
    return ids[0] ?? "";
  }

  publishLocked(topicId: string, payload: unknown, opts: { callback?: [string, string, string] | null; requestId?: string | null } = {}): string[] {
    const topic = this.st.topics.get(topicId);
    if (!topic) throw new InvariantError(`unknown topic: ${topicId}`);
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "edgeId" in (payload as Record<string, unknown>)) {
      throw new InvariantError("消息不得指定下游边（不变量 M1）");
    }
    // 主题 request contract 运行期校验（#13）：声明了就执行，只接受或拒绝
    scheduling.validatePayloadSchema(this, topic.request_contract ?? null, payload, `topic ${topicId} 请求`);
    const rid = opts.requestId ?? this.nid("req");
    const ids: string[] = [];
    for (const [, target] of this.st.subs.get(topicId) ?? []) {
      const inst = this.st.instances.get(target[0]);
      if (!inst || inst.status === "CLOSED") {
        // CLOSED 是终态：投递只会制造永不到达的死信 —— 跳过。PAUSED 仍接收。
        continue;
      }
      // 每个订阅者拿独立 payload 副本；同一请求共享 request_id
      ids.push(this.newMessage(target, structuredClone(payload), { callback: opts.callback ?? null, topic: topicId, requestId: rid }));
    }
    return ids;
  }

  subscribe(topicId: string, target: [string, string, string] | string[]): string {
    if (!this.st.topics.has(topicId)) throw new InvariantError(`unknown topic: ${topicId}`);
    if (!Array.isArray(target) || target.length !== 3) {
      throw new InvariantError(`订阅 target 必须形如 [gid, node_id, endpoint]，得到 ${JSON.stringify(target)}`);
    }
    const [gid, nodeId, ep] = target.map(String) as [string, string, string];
    const inst = this.st.instances.get(gid);
    if (!inst) throw new InvariantError(`订阅 target 引用了未知实例 ${JSON.stringify(gid)}`);
    if (inst.status === "CLOSED") throw new InvariantError(`实例 ${gid} 已 CLOSED（终态），不得新增订阅`);
    this.requireEndpointLocked(gid, nodeId, ep, "订阅 target");
    const sid = this.nid("sub");
    this.st.subs.set(topicId, [...(this.st.subs.get(topicId) ?? []), [sid, [gid, nodeId, ep]]]);
    this.notifyChange(); // 订阅增删是提交边界，必须立即落盘（P0-5）
    return sid;
  }

  unsubscribe(subscriptionId: string): void {
    let changed = false;
    for (const [topic, entries] of this.st.subs) {
      const remaining = entries.filter(([sid]) => sid !== subscriptionId);
      if (remaining.length !== entries.length) changed = true;
      this.st.subs.set(topic, remaining);
    }
    if (changed) this.notifyChange(); // 删除必须持久化，否则重启后幽灵订阅复活（P0-5）
  }

  instanceBusy(gid: string): boolean {
    // WARM_POOL 复用前的隔离检查：池实例忙时不复用，避免遗留消息混入新调用
    for (const m of this.st.messages.values()) {
      if (m.target[0] === gid && (m.state === "QUEUED" || m.state === "CLAIMED" || m.state === "AWAITING")) return true;
    }
    return false;
  }

  spawnChild(inst: InstanceState, slotId: string, slot: Record<string, unknown>): string {
    return scheduling.spawnChild(this, inst, slotId, slot);
  }

  // ------------------------------------------------------------------
  // 上下文追加
  // ------------------------------------------------------------------

  appendContextTail(gid: string, nodeId: string, ref: string): void {
    // 运行期发现的卡片追加到该实例的 tail。不回写模板。
    this.st.instances.get(gid)!.nodes.get(nodeId)!.tail.push(ref);
  }

  appendContextTransient(gid: string, nodeId: string, item: unknown): void {
    // 本轮临时上下文：下一次 claim 时进入 transient，之后自动清空
    this.st.instances.get(gid)!.nodes.get(nodeId)!.transient.push(item);
  }

  collectOrphans(gid: string, opts: { slotId?: string | null; actor: Principal | string }): Promise<string[]> {
    const inst = this.st.instances.get(gid)!;
    this.authorize(inst, opts.actor);
    const collected: string[] = [];
    const slots = opts.slotId != null ? [opts.slotId] : Object.keys(inst.overflow);
    const closing: Promise<void>[] = [];
    for (const sid of slots) {
      const remaining: string[] = [];
      for (const child of inst.overflow[sid] ?? []) {
        if (this.instanceBusy(child)) {
          remaining.push(child);
          continue;
        }
        // 孤儿的 controllers 是 service:{父实例 gid} + system:core；以父实例身份关闭子实例
        closing.push(this.control(child, "close", { actor: `service:${inst.gid}` }));
        collected.push(child);
      }
      inst.overflow[sid] = remaining;
    }
    return Promise.all(closing).then(() => collected);
  }

  // ------------------------------------------------------------------
  // 控制面（全部留提交事实，不是旁路 API）
  // ------------------------------------------------------------------

  async control(gid: string, action: string, opts: { actor: Principal | string }): Promise<void> {
    const inst = this.st.instances.get(gid)!;
    this.authorize(inst, opts.actor);
    const status = inst.status;
    if (action === "close") {
      if (status === "CLOSED") return; // 终态幂等：重复 close 不产生第二次状态变更
      inst.status = "CLOSED";
    } else if (action === "pause") {
      if (status === "CLOSED") {
        throw new InvariantError(`${gid} 已 CLOSED（终态），不得 pause；CLOSED 不能复活为 PAUSED/OPEN`);
      }
      if (status === "PAUSED") throw new InvariantError(`${gid} 已 PAUSED，不得重复 pause`);
      for (const rec of this.st.records.values()) {
        if (rec.gid === gid && rec.status === "RUNNING") await scheduling.cancelExecution(this, rec.executionId);
      }
      inst.status = "PAUSED";
    } else if (action === "resume") {
      if (status === "CLOSED") {
        throw new InvariantError(`${gid} 已 CLOSED（终态），不得 resume；CLOSED 不能复活为 PAUSED/OPEN`);
      }
      if (status === "OPEN") throw new InvariantError(`${gid} 已 OPEN，不得重复 resume`);
      inst.status = "OPEN";
    } else {
      throw new InvariantError(`unknown control action: ${action}`);
    }
    inst.seq += 1;
    this.appendObject(`run/${gid}`, {
      seq: inst.seq,
      node: null,
      control: action,
      actor: String(opts.actor),
      edges_traversed: [],
      endpoint: null,
    }, { kind: "run", provenance: { graph_instance_id: gid, at_seq: inst.seq } });
  }

  approve(gid: string, nodeId: string, opts: { actor: Principal | string; decision: "allow" | "deny"; payload?: unknown }): void {
    const inst = this.st.instances.get(gid);
    if (!inst) throw new InvariantError(`未知实例：${gid}`);
    if (inst.status !== "OPEN") throw new InvariantError(`${gid} 已 ${inst.status}，拒绝审批路由（终态气密）`);
    const tpl = this.st.templates.get(inst.templateRef)!;
    const node = (tpl.nodes as Record<string, Record<string, unknown>>)[nodeId]!;
    const actor = String(opts.actor);
    const allowed = (node.authorized_actors ?? null) as string[] | null;
    if (allowed != null && !allowed.includes(actor)) {
      throw new AuthorizationError(`actor ${JSON.stringify(actor)} 不在 ${nodeId} 的授权名单内：${JSON.stringify(allowed)}`);
    }
    const pending = (inst.nodes.get(nodeId)!.persistent.pending ?? []) as string[];
    if (!pending.length) throw new InvariantError(`${nodeId} 没有待审批项`);
    const mid = pending.shift()!;
    const msg = this.st.messages.get(mid)!;
    const out = opts.payload === undefined ? msg.payload : opts.payload;
    const port = opts.decision === "allow" ? String(node.approve_port ?? "out") : String(node.deny_port ?? "denied");
    const traversed = scheduling.route(this, inst, tpl, nodeId, port, out);
    msg.state = "CONSUMED";
    inst.seq += 1;
    this.appendObject(`run/${gid}`, {
      seq: inst.seq,
      node: nodeId,
      endpoint: msg.target[2],
      decision: opts.decision,
      actor,
      edges_traversed: traversed,
      payload: out,
    }, { kind: "run", provenance: { graph_instance_id: gid, node_id: nodeId, at_seq: inst.seq } });
  }

  // ------------------------------------------------------------------
  // 内核工具桥
  // ------------------------------------------------------------------

  dispatchKernelTool(executionId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
    return kernelTools.dispatchKernelTool(this, executionId, name, args);
  }

  // ------------------------------------------------------------------
  // 草稿（画布工作区）
  // ------------------------------------------------------------------

  createDraft(draftId: string, spec: Record<string, unknown>, layout: Record<string, unknown>): string {
    if (this.drafts.has(draftId)) throw new InvariantError(`draft 已存在：${draftId}`);
    const draft: DraftDoc = { draft_id: draftId, spec: structuredClone(spec), layout: structuredClone(layout), updated_at: new Date().toISOString(), updated_by: "system" };
    this.drafts.set(draftId, draft);
    this.onDraftChange?.(draft);
    return draftId;
  }

  saveDraft(draftId: string, spec: Record<string, unknown> | null, layout: Record<string, unknown> | null): DraftDoc {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new InvariantError(`draft 不存在：${draftId}`);
    if (spec != null) draft.spec = structuredClone(spec);
    if (layout != null) draft.layout = structuredClone(layout);
    draft.updated_at = new Date().toISOString();
    this.onDraftChange?.(draft);
    return structuredClone(draft);
  }

  publishDraft(draftId: string, templateId: string): string {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new InvariantError(`draft 不存在：${draftId}`);
    const spec = structuredClone(draft.spec);
    spec.template_id = templateId;
    if (Object.keys(draft.layout).length) spec._layout = structuredClone(draft.layout);
    // 首次发布走 register（@1），已存在走 publish（@n）；内容寻址幂等
    const ref = `${templateId}@1`;
    if (this.st.templates.has(ref)) {
      return definitions.publishGraphTemplate(this, templateId, spec);
    }
    return definitions.registerGraphTemplate(this, templateId, spec);
  }

  // ------------------------------------------------------------------
  // 调度入口（scheduling.ts 委托）
  // ------------------------------------------------------------------

  step(gids?: string[], maxCommits = 1): Promise<number> {
    return scheduling.step(this, gids, maxCommits);
  }

  drain(...gids: string[]): Promise<void> {
    return scheduling.drain(this, gids);
  }

  drainConcurrent(gids?: string[], opts?: { workers?: number; poll?: number; timeout?: number }): Promise<void> {
    return scheduling.drainConcurrent(this, gids, opts);
  }

  beginExecution(gid: string, nodeId: string): [string, ExecutionRequest] | null {
    return scheduling.beginExecution(this, gid, nodeId);
  }

  cancelExecution(executionId: string): Promise<void> {
    return scheduling.cancelExecution(this, executionId);
  }

  reclaimStaleExecutions(): string[] {
    return scheduling.reclaimStaleExecutions(this);
  }

  // ------------------------------------------------------------------
  // 定义层委托（definitions.ts）
  // ------------------------------------------------------------------

  registerCard(opts: { kind: string; cardId: string; version: number; body: Record<string, unknown>; tags?: string[] }): string {
    return definitions.registerCard(this, opts);
  }

  cardBody(kind: string, cardId: string, version: number): Readonly<Record<string, unknown>> {
    return definitions.cardBody(this, kind, cardId, version);
  }

  compileAgentSpec(opts: { specId: string; model: string; cards?: Array<[string, string] | [string, string, number]>; tools?: unknown[] }): Record<string, unknown> {
    return definitions.compileAgentSpec(this, opts);
  }

  registerCharacter(opts: { characterId: string; cards: Array<[string, string] | [string, string, number]>; tools?: unknown[] }): string {
    return definitions.registerCharacter(this, opts);
  }

  expandCharacter(characterId: string): { cards: Array<[string, string, number | null]>; tools: Array<Record<string, unknown>> } {
    return definitions.expandCharacter(this, characterId);
  }

  resolveSpec(specId: string): Record<string, unknown> {
    return definitions.resolveSpec(this, specId);
  }

  registerGraphTemplate(templateId: string, spec: Record<string, unknown>): string {
    return definitions.registerGraphTemplate(this, templateId, spec);
  }

  publishGraphTemplate(templateId: string, spec: Record<string, unknown>, derivedFrom: string[] = []): string {
    return definitions.publishGraphTemplate(this, templateId, spec, derivedFrom);
  }

  proposeGraphTemplate(opts: { proposalId: string; templateId: string; spec: Record<string, unknown>; proposer: Principal | string; requiredApprovers?: string[]; derivedFrom?: string[] }): string {
    return definitions.proposeGraphTemplate(this, opts);
  }

  approveGraphTemplate(proposalId: string, opts: { actor: Principal | string; modifications?: Record<string, unknown> | null }): string {
    return definitions.approveGraphTemplate(this, proposalId, opts);
  }

  registerContract(contractId: string, version: number, schema: Record<string, unknown>): string {
    return definitions.registerContract(this, contractId, version, schema);
  }

  registerTopic(topicId: string, opts: { requestContract?: Record<string, unknown> | null; replyContract?: Record<string, unknown> | null }): string {
    return definitions.registerTopic(this, topicId, opts);
  }

  registerTransform(transformId: string, opts: { role: string; body: Record<string, unknown> }): string {
    return definitions.registerTransform(this, transformId, opts);
  }

  registerPolicy(policyId: string, spec: Record<string, unknown>): string {
    return definitions.registerPolicy(this, policyId, spec);
  }

  registerHandler(name: string, fn: (payloads: Record<string, unknown>, ctx: { gid: string; state: Record<string, unknown>; publish: (oid: string, body: Record<string, unknown>) => ObjectVersion }) => Record<string, unknown> | void): string {
    return definitions.registerHandler(this, name, fn);
  }

  // ------------------------------------------------------------------
  // 预算委托（budget.ts）
  // ------------------------------------------------------------------

  estimateTextTokens(text: string): number {
    return budget.estimateTextTokens(this, text);
  }

  estimateTokens(ctx: { head: string[]; messages: unknown[]; tail: string[]; transient: unknown[]; meta?: Record<string, unknown>[] }): number {
    return budget.estimateTokens(this, ctx);
  }

  estimateSpecTokens(spec: Record<string, unknown>): number {
    return budget.estimateSpecTokens(this, spec);
  }

  fitContext(ctx: { head: string[]; messages: unknown[]; tail: string[]; transient: unknown[]; meta?: Record<string, unknown>[] }, b: number | null | undefined, opts: { gid: string; nodeId: string; overhead?: number }): budget.FitResult {
    return budget.fitContext(this, ctx, b, opts);
  }

  // ------------------------------------------------------------------
  // 投影委托（projections.ts）
  // ------------------------------------------------------------------

  graphStatus(gid: string): string {
    return projections.graphStatus(this, gid);
  }

  nodePersistentState(gid: string, nodeId: string): Readonly<Record<string, unknown>> {
    return projections.nodePersistentState(this, gid, nodeId);
  }

  nodeExecutions(gid: string, nodeId: string) {
    return projections.nodeExecutions(this, gid, nodeId);
  }

  childrenOf(gid: string, slotId: string): string[] {
    return projections.childrenOf(this, gid, slotId);
  }

  overflowChildren(gid: string, slotId: string): string[] {
    return projections.overflowChildren(this, gid, slotId);
  }

  contextOf(gid: string, nodeId: string): { head: string[]; tail: string[] } {
    return projections.contextOf(this, gid, nodeId);
  }

  agentSpecOf(gid: string, nodeId: string): Readonly<Record<string, unknown>> {
    return projections.agentSpecOf(this, gid, nodeId);
  }

  artifactVersions(oid: string): number[] {
    return projections.artifactVersions(this, oid);
  }

  searchCards(opts: { kind?: string; tags?: string[]; query?: string }): string[] {
    return projections.searchCards(this, opts);
  }

  graphTemplateVersions(templateId: string): ObjectVersion[] {
    return projections.graphTemplateVersions(this, templateId);
  }

  templateLayout(templateRef: string): unknown {
    return projections.templateLayout(this, templateRef);
  }

  graphTemplateProposal(proposalId: string): ObjectVersion {
    return projections.graphTemplateProposal(this, proposalId);
  }

  artifact(oid: string, version: number): Readonly<Record<string, unknown>> {
    return projections.artifact(this, oid, version);
  }

  annotations(gid: string): ObjectVersion[] {
    return projections.annotations(this, gid);
  }

  searchAnnotations(opts: { tags?: string[]; objectRefs?: Record<string, string> | string[]; gid?: string | null; fields?: Record<string, unknown> }): ObjectVersion[] {
    return projections.searchAnnotations(this, opts);
  }

  queue(topicId: string) {
    return projections.queue(this, topicId);
  }

  usage(gid: string) {
    return projections.usage(this, gid);
  }

  contextAlerts(gid: string): Array<Record<string, unknown>> {
    return projections.contextAlerts(this, gid);
  }

  commitSeq(gid: string): number {
    return projections.commitSeq(this, gid);
  }

  runSnapshots(gid: string): ObjectVersion[] {
    return projections.runSnapshots(this, gid);
  }

  messagesOf(gid: string) {
    return projections.messagesOf(this, gid);
  }
}
