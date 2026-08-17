/**
 * Nodeflow V5 —— 定义层（对 Python nodeflow_definitions.py 的 TS 移植）
 *
 * 卡片、AgentSpec 编译、模板、契约、端点、Servo、主题、策略、handler。
 * 注册即快照；连接期校验在此发生。
 *
 * 深只读：注册时 structuredClone 入库，读取 deepFreeze 出库（边界 B1/B6）。
 * 全部函数以 RuntimeLike 为第一参数（模块级职责划分，与 V4 mixin 等价）。
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@nodeflow/contracts";
import { AuthorizationError, InvariantError, ObjectStore, Principal, principalParse, principalStr, ALLOWED_NODE_KINDS } from "./core.js";
import type { HandlerFn, RuntimeLike } from "./runtime-like.js";

export const SERVO_OPS = new Set(["set", "map", "drop"]);

// ---------------------------------------------------------------------------
// 深只读
// ---------------------------------------------------------------------------

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export function cloneIn<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// 卡片 / 装配面
// ---------------------------------------------------------------------------

export function registerCard(
  rt: RuntimeLike,
  opts: { kind: string; cardId: string; version: number; body: Record<string, unknown>; tags?: string[] }
): string {
  const { kind, cardId, version, body, tags = [] } = opts;
  if (!["skill", "mcp", "rules", "prompt"].includes(kind)) {
    throw new InvariantError(`unknown card kind: ${kind}`);
  }
  const key = `${kind}/${cardId}`;
  const slot = rt.st.cards.get(key) ?? new Map<number, Record<string, unknown>>();
  if (slot.has(version)) {
    throw new InvariantError(`card version already exists: ${kind}/${cardId}@${version}`);
  }
  slot.set(version, cloneIn(body));
  rt.st.cards.set(key, slot);
  const ref = `${kind}/${cardId}@${version}`;
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag) throw new InvariantError(`card tag 必须是非空字符串：${JSON.stringify(tag)}`);
    const set = rt.st.cardTags.get(tag) ?? new Set<string>();
    set.add(ref);
    rt.st.cardTags.set(tag, set);
  }
  return ref;
}

export function latestCardVersion(rt: RuntimeLike, kind: string, cardId: string): number {
  const slot = rt.st.cards.get(`${kind}/${cardId}`);
  if (!slot) throw new InvariantError(`unknown card: ${kind}/${cardId}`);
  return Math.max(...slot.keys());
}

export function cardBody(rt: RuntimeLike, kind: string, cardId: string, version: number): Readonly<Record<string, unknown>> {
  const slot = rt.st.cards.get(`${kind}/${cardId}`);
  const body = slot?.get(version);
  if (!body) throw new InvariantError(`unknown card version: ${kind}/${cardId}@${version}`);
  return deepFreeze(body);
}

function normalizeTools(tools: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    if (typeof t === "string") out.push({ name: t });
    else if (t && typeof t === "object") out.push({ ...(t as Record<string, unknown>) });
    else throw new InvariantError(`工具声明必须是字符串名或映射：${JSON.stringify(t)}`);
  }
  return out;
}

export function compileAgentSpec(
  rt: RuntimeLike,
  opts: { specId: string; model: string; cards?: Array<[string, string] | [string, string, number]>; tools?: unknown[] }
): Record<string, unknown> {
  const { specId, model, cards = [], tools = [] } = opts;
  const declared: Array<[string, string, number | null]> = [];
  for (const entry of cards) {
    if (entry.length === 2) {
      declared.push([entry[0], entry[1], null]);
    } else {
      const [kind, cid, ver] = entry as [string, string, number];
      if (!rt.st.cards.get(`${kind}/${cid}`)?.has(ver)) {
        throw new InvariantError(`unknown card version: ${kind}/${cid}@${ver}`);
      }
      declared.push([kind, cid, ver]);
    }
  }
  const spec = { spec_id: specId, model, declared_cards: declared, tools: normalizeTools(tools) };
  rt.st.specs.set(specId, spec);
  const resolved = resolveSpec(rt, specId);
  collectTools(rt, resolved); // 编译期就校验工具全集（#8），而不是等到第一次 claim
  return resolved;
}

export function registerCharacter(
  rt: RuntimeLike,
  opts: { characterId: string; cards: Array<[string, string] | [string, string, number]>; tools?: unknown[] }
): string {
  const { characterId, cards, tools = [] } = opts;
  if (rt.st.characters.has(characterId)) throw new InvariantError(`character 已存在：${characterId}`);
  const declared: Array<[string, string, number | null]> = [];
  for (const entry of cards) {
    const kind = entry[0];
    if (!["skill", "mcp", "rules", "prompt"].includes(kind)) {
      throw new InvariantError(`unknown card kind: ${JSON.stringify(kind)}；character 只能引用 skill/mcp/rules/prompt 卡片`);
    }
    if (entry.length === 2) {
      declared.push([kind, entry[1], null]);
    } else {
      const ver = (entry as [string, string, number])[2];
      if (!rt.st.cards.get(`${kind}/${entry[1]}`)?.has(ver)) {
        throw new InvariantError(`unknown card version: ${kind}/${entry[1]}@${ver}`);
      }
      declared.push([kind, entry[1], ver]);
    }
  }
  rt.st.characters.set(characterId, { cards: declared, tools: normalizeTools(tools) });
  return characterId;
}

export function expandCharacter(rt: RuntimeLike, characterId: string): { cards: Array<[string, string, number | null]>; tools: Array<Record<string, unknown>> } {
  const ch = rt.st.characters.get(characterId);
  if (!ch) throw new InvariantError(`unknown character: ${characterId}`);
  return { cards: [...ch.cards], tools: ch.tools.map((t) => ({ ...t })) };
}

export function resolveSpec(rt: RuntimeLike, specId: string): Record<string, unknown> {
  const spec = rt.st.specs.get(specId);
  if (!spec) throw new InvariantError(`unknown spec: ${specId}`);
  const refs: string[] = [];
  const table: Record<string, number> = {};
  for (const [kind, cid, ver] of spec.declared_cards) {
    const v = ver ?? latestCardVersion(rt, kind, cid);
    refs.push(`${kind}/${cid}@${v}`);
    table[`${kind}/${cid}`] = v;
  }
  return { spec_id: specId, model: spec.model, card_refs: refs, cards: table, tools: spec.tools.map((t) => ({ ...t })) };
}

/** 工具全集：显式声明 + MCP 卡片工具；内核保留名不可占用，跨来源重名显式报错（#8）。 */
export function collectTools(rt: RuntimeLike, resolved: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  const claimed = new Map<string, string>();
  const add = (name: unknown, description: unknown, source: string, raw: Record<string, unknown> | undefined) => {
    if (typeof name !== "string" || !name) throw new InvariantError(`${source} 的工具名必须是字符串：${JSON.stringify(name)}`);
    if (KERNEL_TOOL_NAMES.has(name)) {
      throw new InvariantError(`${source} 的工具 ${JSON.stringify(name)} 占用了内核保留名；保留名：${[...KERNEL_TOOL_NAMES].sort().join(", ")}`);
    }
    if (claimed.has(name)) {
      throw new InvariantError(`工具名冲突：${JSON.stringify(name)} 同时来自 ${claimed.get(name)} 与 ${source}；请在卡片/spec 里改名，不要依赖加载顺序`);
    }
    claimed.set(name, source);
    tools.push({
      name,
      description: String(description ?? ""),
      source,
      defer_loading: true, // 不变量 X：工具集编译期声明齐全，运行期只启用不新增
      parameters:
        (raw && (raw.parameters ?? raw.input_schema)) ??
        { type: "object", properties: {} },
    });
  };

  const declaredTools = (resolved.tools ?? []) as Array<Record<string, unknown>>;
  for (const t of [...declaredTools].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))) {
    add(t.name, t.description, `spec/${String(resolved.spec_id ?? "?")}`, t);
  }

  const cards = (resolved.cards ?? {}) as Record<string, number>;
  const byKind = new Map<string, Array<[string, number]>>();
  for (const [key, ver] of Object.entries(cards)) {
    const [kind, cid] = key.split("/", 2);
    byKind.set(kind, [...(byKind.get(kind) ?? []), [cid, ver]]);
  }
  for (const [cid, v] of (byKind.get("mcp") ?? []).sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = cardBody(rt, "mcp", cid, v);
    for (const t of (body.tools ?? []) as Array<Record<string, unknown>>) {
      add(t.name, t.summary, `mcp/${cid}@${v}`, t);
    }
  }
  return tools;
}

/** 五段 prompt 编译：rules → 角色 → MCP 列表 → skill 索引 → 输出契约。 */
export function compileAgentPrompt(rt: RuntimeLike, resolved: Record<string, unknown>, node: Record<string, unknown>): { prompt: string; tools: Array<Record<string, unknown>> } {
  const cards = (resolved.cards ?? {}) as Record<string, number>;
  const byKind = new Map<string, Array<[string, number]>>();
  for (const [key, ver] of Object.entries(cards)) {
    const [kind, cid] = key.split("/", 2);
    byKind.set(kind, [...(byKind.get(kind) ?? []), [cid, ver]]);
  }
  const parts: string[] = [];
  const tools = collectTools(rt, resolved);

  // [a] rules 全量前置 —— 必须遵守
  const rules: string[] = [];
  for (const [c, v] of (byKind.get("rules") ?? []).sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = String(cardBody(rt, "rules", c, v).text ?? "");
    if (text) rules.push(text);
  }
  if (rules.length) parts.push("# 规则（必须遵守）\n" + rules.join("\n\n"));

  // [b] 角色。节点级 systemPrompt 视作一张内联的 prompt 卡。
  const roles: string[] = [];
  for (const [c, v] of (byKind.get("prompt") ?? []).sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = String(cardBody(rt, "prompt", c, v).text ?? "");
    if (text) roles.push(text);
  }
  if (node.systemPrompt) roles.push(String(node.systemPrompt));
  if (roles.length) parts.push("# 角色\n" + roles.join("\n\n"));

  // [c] mcp 可用列表：名称 + 摘要，不含全量 schema
  const mcpLines: string[] = [];
  for (const [cid, v] of (byKind.get("mcp") ?? []).sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = cardBody(rt, "mcp", cid, v);
    for (const t of (body.tools ?? []) as Array<Record<string, unknown>>) {
      mcpLines.push(`- ${t.name}：${String(t.summary ?? "")}`);
    }
  }
  if (mcpLines.length) parts.push("# 可用 MCP 工具\n" + mcpLines.join("\n"));

  // [d] skill 压缩索引：只放 summary，全文运行期按需追加到 tail
  const skillLines: string[] = [];
  for (const [cid, v] of (byKind.get("skill") ?? []).sort((a, b) => a[0].localeCompare(b[0]))) {
    skillLines.push(`- skill/${cid}@${v}：${String(cardBody(rt, "skill", cid, v).summary ?? "")}`);
  }
  if (skillLines.length) parts.push("# 可用 skill（需要时索取全文）\n" + skillLines.join("\n"));

  // [e] 输出契约 —— 由 emit 端点的 contract 生成，不是人写的
  const endpoints = (node.endpoints ?? {}) as Record<string, Record<string, unknown>>;
  const emitPorts = Object.entries(endpoints).filter(([, d]) => d && "emit" in d).map(([ep]) => ep);
  const ports = emitPorts.length ? emitPorts : Object.keys(endpoints);
  const lines: string[] = [];
  for (const ep of [...ports].sort()) {
    const ref = endpointRef(node, ep, "emit", "PUSH");
    if (ref) {
      const [fields, required] = fieldsOf(rt.contract(ref));
      lines.push(`- ${ep}：${ref} 字段 ${[...fields].sort()}（必需 ${[...required].sort()}）`);
    } else {
      lines.push(`- ${ep}`);
    }
  }
  if (lines.length) parts.push("# 输出契约\n完成后调用 emit 输出，port 只能取以下之一：\n" + lines.join("\n"));

  return { prompt: parts.join("\n\n"), tools };
}

/** 由 emit 端点契约推导 OutputContract.schema（INTERFACES §2.3）。 */
export function emitSchemaFor(rt: RuntimeLike, node: Record<string, unknown>): Record<string, unknown> {
  const endpoints = (node.endpoints ?? {}) as Record<string, Record<string, unknown>>;
  const emitPorts = Object.entries(endpoints).filter(([, d]) => d && "emit" in d).map(([ep]) => ep);
  const ports = emitPorts.length ? emitPorts : Object.keys(endpoints);
  const variants: Array<Record<string, unknown>> = [];
  for (const ep of [...ports].sort()) {
    const ref = endpointRef(node, ep, "emit", "PUSH");
    if (!ref) continue;
    const payloadSchema = { ...rt.contract(ref) } as Record<string, unknown>;
    payloadSchema.type ??= "object";
    variants.push({
      type: "object",
      properties: { port: { const: ep }, payload: payloadSchema },
      required: ["port", "payload"],
      "x-nodeflow-contract": ref,
    });
  }
  return {
    type: "object",
    properties: {
      port: { type: "string", enum: [...ports].sort() },
      payload: variants.length ? { oneOf: variants } : { type: "object" },
    },
    required: ["port", "payload"],
  };
}

/** 稳定前缀指纹（不变量 X）。 */
export function prefixFingerprint(spec: Record<string, unknown>): string {
  const blob =
    String(spec.systemPrompt ?? "") +
    stableStringify(spec.tools ?? []) +
    stableStringify(spec.kernel_tools ?? []);
  return createHash("sha256").update(blob, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// 契约 / 端点 / Servo 符号推演
// ---------------------------------------------------------------------------

export function registerContract(rt: RuntimeLike, contractId: string, version: number, schema: Record<string, unknown>): string {
  const ref = `${contractId}@${version}`;
  if (rt.st.contracts.has(ref)) throw new InvariantError(`契约已存在，不可覆盖：${ref}`);
  rt.st.contracts.set(ref, cloneIn(schema)); // 边界 B1b：快照
  return ref;
}

export function endpointRef(node: Record<string, unknown>, epName: string, direction: "receive" | "emit", operation = "PUSH"): string | null {
  // 端点不是永久的 input/output 两类；方向来自本次 operation。未声明 = 未约束。
  const ep = (node.endpoints as Record<string, Record<string, unknown>> | undefined)?.[epName];
  if (!ep || typeof ep !== "object") return null;
  const block = ep[direction];
  if (!block || typeof block !== "object") return null;
  const entry = (block as Record<string, unknown>)[operation];
  if (entry && typeof entry === "object") {
    return (entry as Record<string, unknown>).contract != null ? String((entry as Record<string, unknown>).contract) : null;
  }
  return typeof entry === "string" ? entry : null;
}

export function fieldsOf(schema: Record<string, unknown> | null | undefined): [Set<string>, Set<string>] {
  if (!schema) return [new Set(), new Set()];
  return [
    new Set(Object.keys((schema.properties ?? {}) as Record<string, unknown>)),
    new Set((schema.required ?? []) as string[]),
  ];
}

export function servoFields(rt: RuntimeLike, fields: Set<string>, transformId: string | null | undefined): Set<string> {
  if (!transformId) return new Set(fields);
  const t = rt.st.transforms.get(transformId);
  if (!t) throw new InvariantError(`未注册的 transform：${transformId}`);
  const body = t.body as Record<string, unknown>;
  const out = new Set(fields);
  for (const [src, dst] of Object.entries((body.map ?? {}) as Record<string, string>)) {
    if (out.has(src)) out.delete(src);
    out.add(dst);
  }
  for (const k of Object.keys((body.set ?? {}) as Record<string, unknown>)) out.add(k);
  for (const k of (body.drop ?? []) as string[]) out.delete(k);
  return out;
}

// ---------------------------------------------------------------------------
// 模板注册 / 发布 / 提案 / 审批
// ---------------------------------------------------------------------------

export function registerGraphTemplate(rt: RuntimeLike, templateId: string, spec: Record<string, unknown>): string {
  if (templateId.includes("@")) {
    throw new InvariantError(`模板 id 不得含 '@'（版本由内核追加）：${JSON.stringify(templateId)}`);
  }
  const ref = `${templateId}@1`;
  if (rt.st.templates.has(ref)) {
    throw new InvariantError(`模板已存在，发布后不可变：${ref}。要演进请用 publish_graph_template（版本化通道）`);
  }
  for (const [nodeId, node] of Object.entries((spec.nodes ?? {}) as Record<string, Record<string, unknown>>)) {
    const kind = String(node.kind ?? "");
    if (!ALLOWED_NODE_KINDS.has(kind)) {
      throw new InvariantError(
        `unsupported node kind ${JSON.stringify(kind)} at ${JSON.stringify(nodeId)}; 循环锚点是 strategy 的配置，不是节点种类（FOUNDATION §5.6）`
      );
    }
  }
  validateTemplate(rt, templateId, spec); // 全引用校验
  validateEdges(rt, templateId, spec); // 连接期校验
  const stored = cloneIn(spec);
  const layout = stored._layout;
  delete stored._layout; // _layout 不进入语义层（边界 Lb）：无损存到侧表
  rt.st.templates.set(ref, stored);
  rt.st.layouts.set(ref, cloneIn(layout) ?? {});
  rt.appendObject(`graph_template/${templateId}`, { template_id: templateId, template_ref: ref, spec: stored }, { kind: "graph_template" });
  return ref;
}

export function publishGraphTemplate(rt: RuntimeLike, templateId: string, spec: Record<string, unknown>, derivedFrom: string[] = []): string {
  if (templateId.includes("@")) {
    throw new InvariantError(`模板 id 不得含 '@'（版本由内核追加）：${JSON.stringify(templateId)}`);
  }
  validateTemplate(rt, templateId, spec);
  validateEdges(rt, templateId, spec);
  const stored = cloneIn(spec);
  const layout = stored._layout;
  delete stored._layout;
  const oid = `graph_template/${templateId}`;
  // 定义级幂等按 spec 内容判断（template_ref 随版本变化，不能参与哈希）
  for (const ov of rt.store.history(oid)) {
    if (JSON.stringify((ov.body.spec ?? {})) === JSON.stringify(stored)) return String(ov.body.template_ref);
  }
  const nextVersion = rt.store.history(oid).length + 1;
  const ref = `${templateId}@${nextVersion}`;
  rt.appendObject(oid, { template_id: templateId, template_ref: ref, spec: stored }, {
    kind: "graph_template",
    provenance: { at_seq: 0, derived_from: derivedFrom },
  });
  rt.st.templates.set(ref, stored);
  rt.st.layouts.set(ref, cloneIn(layout) ?? {});
  return ref;
}

export function proposeGraphTemplate(
  rt: RuntimeLike,
  opts: { proposalId: string; templateId: string; spec: Record<string, unknown>; proposer: Principal | string; requiredApprovers?: string[]; derivedFrom?: string[] }
): string {
  const { proposalId, templateId, spec, proposer, requiredApprovers = [], derivedFrom = [] } = opts;
  if (templateId.includes("@") || proposalId.includes("@")) {
    throw new InvariantError("template_id / proposal_id 不得含 '@'");
  }
  const principal = principalParse(proposer);
  const oid = `graph_template_proposal/${proposalId}`;
  const existing = rt.store.history(oid);
  if (existing.length && (existing[existing.length - 1]!.body.status ?? "") === "pending") {
    throw new InvariantError(`提案已存在且仍在 pending：${proposalId}；先审批或新建 proposal_id`);
  }
  const ov = rt.appendObject(
    oid,
    {
      proposal_id: proposalId,
      template_id: templateId,
      spec: cloneIn(spec),
      status: "pending",
      proposer: principalStr(principal),
      required_approvers: requiredApprovers.map((a) => principalStr(principalParse(a))),
      derived_from: [...derivedFrom],
    },
    { kind: "graph_template_proposal", provenance: { at_seq: 0, derived_from: derivedFrom } }
  );
  return ov.ref;
}

export function approveGraphTemplate(rt: RuntimeLike, proposalId: string, opts: { actor: Principal | string; modifications?: Record<string, unknown> | null }): string {
  const { actor, modifications } = opts;
  const oid = `graph_template_proposal/${proposalId}`;
  const head = rt.store.head(oid);
  const body = head.body;
  if (body.status !== "pending") {
    throw new InvariantError(`提案 ${proposalId} 已 ${String(body.status)}，不可重复审批`);
  }
  const principal = principalParse(actor);
  const required = (body.required_approvers ?? []) as string[];
  if (required.length && !required.includes(principalStr(principal))) {
    throw new AuthorizationError(
      `principal ${principalStr(principal)} 不在提案 ${proposalId} 的审批名单内：${required}`
    );
  }
  const spec = modifications ? (modifications as Record<string, unknown>) : (body.spec as Record<string, unknown>);
  const templateId = String(body.template_id);
  const ref = publishGraphTemplate(rt, templateId, spec, [head.ref, ...((body.derived_from ?? []) as string[])]);
  rt.appendObject(oid, { ...body, status: "approved", approver: principalStr(principal), template_ref: ref }, {
    kind: "graph_template_proposal",
    provenance: { at_seq: 0, derived_from: [head.ref] },
  });
  return ref;
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export function registerTopic(rt: RuntimeLike, topicId: string, opts: { requestContract?: Record<string, unknown> | null; replyContract?: Record<string, unknown> | null }): string {
  if (rt.st.topics.has(topicId)) {
    throw new InvariantError(`topic 已存在，不可覆盖：${JSON.stringify(topicId)}。要演进请注册新 id 或走定义版本化通道`);
  }
  rt.st.topics.set(topicId, {
    request_contract: opts.requestContract ? cloneIn(opts.requestContract) : null,
    reply_contract: opts.replyContract ? cloneIn(opts.replyContract) : null,
  });
  rt.st.subs.set(topicId, []);
  return topicId;
}

export function registerTransform(rt: RuntimeLike, transformId: string, opts: { role: string; body: Record<string, unknown> }): string {
  if (rt.st.transforms.has(transformId)) throw new InvariantError(`transform 已存在，不可覆盖：${JSON.stringify(transformId)}`);
  rt.st.transforms.set(transformId, { role: opts.role, body: cloneIn(opts.body) });
  return transformId;
}

export function registerPolicy(rt: RuntimeLike, policyId: string, spec: Record<string, unknown>): string {
  if (rt.st.policies.has(policyId)) throw new InvariantError(`policy 已存在，不可覆盖：${JSON.stringify(policyId)}`);
  rt.st.policies.set(policyId, cloneIn(spec)); // 边界 B1c：快照
  return policyId;
}

export function registerHandler(rt: RuntimeLike, name: string, fn: HandlerFn): string {
  if (rt.st.handlers.has(name)) {
    throw new InvariantError(`handler 已存在，不可覆盖：${JSON.stringify(name)}。测试/装配若要替换，请用新名字`);
  }
  rt.st.handlers.set(name, fn);
  return name;
}

// ---------------------------------------------------------------------------
// 模板全引用校验（注册期一次完成）
// ---------------------------------------------------------------------------

export function validateTemplate(rt: RuntimeLike, templateId: string, spec: Record<string, unknown>): void {
  const nodes = (spec.nodes ?? {}) as Record<string, Record<string, unknown>>;
  if (!Object.keys(nodes).length) throw new InvariantError(`模板 ${templateId} 没有节点`);
  const slots = (spec.slots ?? {}) as Record<string, Record<string, unknown>>;

  const epExists = (nodeId: string, ep: string, where: string): void => {
    const node = nodes[nodeId];
    if (!node) throw new InvariantError(`${where}：节点 ${JSON.stringify(nodeId)} 不存在。可用节点：${JSON.stringify(Object.keys(nodes).sort())}`);
    if (!(ep in ((node.endpoints ?? {}) as Record<string, unknown>))) {
      throw new InvariantError(`${where}：节点 ${JSON.stringify(nodeId)} 没有端点 ${JSON.stringify(ep)}。可用端点：${JSON.stringify(Object.keys((node.endpoints ?? {}) as Record<string, unknown>).sort())}`);
    }
  };

  for (const [nodeId, node] of Object.entries(nodes)) {
    const kind = String(node.kind ?? "");
    const endpoints = node.endpoints as Record<string, unknown> | undefined;
    if (!endpoints || typeof endpoints !== "object" || !Object.keys(endpoints).length) {
      throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 必须声明非空 endpoints（统一端点模型）`);
    }
    // 内核工具桥能力只在 agent 节点上声明；其它 kind 声明即拒（第一不变量）
    if (kind !== "agent" && (node.publish_topics != null || node.spawn_slots != null)) {
      throw new InvariantError(`节点 ${JSON.stringify(nodeId)}（kind=${kind}）不得声明 publish_topics/spawn_slots：内核工具桥只对 agent 节点开放`);
    }
    if (kind === "agent") {
      const specId = String(node.spec ?? "");
      if (!rt.st.specs.has(specId)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 引用的 agent spec ${JSON.stringify(specId)} 未注册；先 compile_agent_spec。可用 spec：${JSON.stringify([...rt.st.specs.keys()].sort())}`);
      }
      const pt = node.publish_topics;
      if (pt != null) {
        if (typeof pt !== "object" || Array.isArray(pt)) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 publish_topics 必须是 {topic: callback_endpoint} 映射`);
        }
        for (const [topic, cbEp] of Object.entries(pt as Record<string, unknown>)) {
          if (!rt.st.topics.has(topic)) {
            throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 publish_topics 引用了未注册 topic ${JSON.stringify(topic)}；先 register_topic。可用 topic：${JSON.stringify([...rt.st.topics.keys()].sort())}`);
          }
          epExists(nodeId, String(cbEp), `节点 ${JSON.stringify(nodeId)} 的 publish_topics[${topic}]`);
        }
      }
      const ss = node.spawn_slots;
      if (ss != null) {
        if (!Array.isArray(ss)) throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 spawn_slots 必须是 slot id 列表`);
        for (const slotId of ss) {
          if (!(slotId in slots)) {
            throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 spawn_slots 引用了未声明 slot ${JSON.stringify(slotId)}。可用 slots：${JSON.stringify(Object.keys(slots).sort())}`);
          }
        }
      }
    } else if (kind === "plain") {
      if (!rt.st.handlers.has(String(node.handler ?? ""))) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 引用的 handler ${JSON.stringify(node.handler)} 未注册；可用 handler：${JSON.stringify([...rt.st.handlers.keys()].sort())}`);
      }
    } else if (kind === "strategy") {
      const policyId = String(node.policy ?? "");
      if (!rt.st.policies.has(policyId)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 引用的 policy ${JSON.stringify(policyId)} 未注册；可用 policy：${JSON.stringify([...rt.st.policies.keys()].sort())}`);
      }
      const ev = (node.evaluator ?? {}) as Record<string, unknown>;
      if (ev.kind === "model") {
        if (!rt.st.specs.has(String(ev.spec ?? ""))) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 model evaluator 引用了未注册 spec ${JSON.stringify(ev.spec)}`);
        }
      } else if (!rt.st.handlers.has(String(node.handler ?? ""))) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 引用的 handler ${JSON.stringify(node.handler)} 未注册；model evaluator 请声明 evaluator.kind='model'`);
      }
      const policy = rt.st.policies.get(policyId)!;
      const readiness = String(policy.readiness ?? "ANY");
      if (!["ANY", "ALL_REQUIRED"].includes(readiness)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 policy 未实现的 readiness：${JSON.stringify(readiness)}`);
      }
      const selection = String(policy.selection ?? (readiness === "ALL_REQUIRED" ? "ONE_PER_INPUT" : "FIRST"));
      if (!["FIRST", "TOP_ONE", "ONE_PER_INPUT", "CROSS_ALL"].includes(selection)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 policy 未实现的 selection：${JSON.stringify(selection)}`);
      }
      const needsRequired = readiness === "ALL_REQUIRED" || selection === "ONE_PER_INPUT" || selection === "CROSS_ALL";
      const required = policy.required_inputs;
      if (needsRequired) {
        if (!Array.isArray(required) || !required.length) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：${readiness}/${selection} 必须给出 required_inputs`);
        }
        for (const ep of required) epExists(nodeId, String(ep), `节点 ${JSON.stringify(nodeId)} 的 required_inputs`);
      }
      if (selection === "CROSS_ALL" && required.length !== 2) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：CROSS_ALL 要求恰好两个 required_inputs，得到 ${JSON.stringify(required)}`);
      }
      if (selection === "TOP_ONE") {
        if (typeof policy.rankField !== "string" && policy.rankField != null) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：TOP_ONE 的 rankField 必须是字符串`);
        }
        const unselected = String(policy.unselected ?? "RETAIN");
        if (!["RETAIN", "DISCARD"].includes(unselected)) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：TOP_ONE 的 unselected 必须是 RETAIN | DISCARD`);
        }
      }
      const out = (policy.output ?? {}) as Record<string, unknown>;
      const mode = String(out.mode ?? "");
      if (mode === "FANOUT_TO_SLOT") {
        const slotId = String(out.slot ?? "");
        if (!(slotId in slots)) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：FANOUT_TO_SLOT 指向未声明的 slot ${JSON.stringify(slotId)}。可用 slots：${JSON.stringify(Object.keys(slots).sort())}`);
        }
        const cap = out.max_items;
        if (cap != null && (typeof cap !== "number" || cap <= 0)) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：max_items 必须是正整数，得到 ${JSON.stringify(cap)}`);
        }
      } else if (mode === "WAIT_ALL") {
        const reqOuts = out.required_outputs;
        if (!Array.isArray(reqOuts) || !reqOuts.length) {
          throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：WAIT_ALL 必须给出 required_outputs`);
        }
        for (const ep of reqOuts) epExists(nodeId, String(ep), `节点 ${JSON.stringify(nodeId)} 的 required_outputs`);
      } else if (mode === "CROSS") {
        for (const key of ["left", "right", "target"]) {
          if (typeof out[key] !== "string") throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：CROSS 必须给出字符串 ${key}`);
        }
        epExists(nodeId, String(out.target), `节点 ${JSON.stringify(nodeId)} 的 CROSS target`);
      } else if (mode !== "" && mode !== "EMIT_EACH") {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)}：未实现的 output mode ${JSON.stringify(mode)}`);
      }
    } else if (kind === "subflow") {
      const slotId = String(node.slot ?? "");
      if (!(slotId in slots)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 引用的 slot ${JSON.stringify(slotId)} 未声明；可用 slots：${JSON.stringify(Object.keys(slots).sort())}`);
      }
      const rp = String(node.return_port ?? "reply");
      if (rp !== "reply") epExists(nodeId, rp, `节点 ${JSON.stringify(nodeId)} 的 return_port`);
    } else if (kind === "start") {
      epExists(nodeId, String(node.emit ?? "io"), `节点 ${JSON.stringify(nodeId)} 的 emit`);
    } else if (kind === "approval") {
      const allowed = node.authorized_actors;
      if (allowed != null && !Array.isArray(allowed)) {
        throw new InvariantError(`节点 ${JSON.stringify(nodeId)} 的 authorized_actors 必须是列表`);
      }
    }
  }

  for (const [slotId, slot] of Object.entries(slots)) {
    if (!slot || typeof slot !== "object") throw new InvariantError(`slot ${JSON.stringify(slotId)} 必须是映射`);
    const childRef = String(slot.template ?? "");
    const child = rt.st.templates.get(childRef);
    if (!child) {
      throw new InvariantError(`slot ${JSON.stringify(slotId)} 引用的模板 ${JSON.stringify(childRef)} 未注册（先注册子模板）；可用模板：${JSON.stringify([...rt.st.templates.keys()].sort())}`);
    }
    const mode = String(slot.instantiation ?? "PER_CALL");
    const m = /^WARM_POOL\((\d+)\)$/.exec(mode);
    if (mode !== "PER_CALL" && mode !== "SINGLETON" && !m) {
      throw new InvariantError(`slot ${JSON.stringify(slotId)} 的 instantiation ${JSON.stringify(mode)} 不合法；应为 PER_CALL | WARM_POOL(n) | SINGLETON`);
    }
    if (m && Number(m[1]) <= 0) throw new InvariantError(`slot ${JSON.stringify(slotId)} 的 WARM_POOL(n) 需要 n>0`);
    const entry = String(slot.entry ?? "");
    if (!entry.includes(".")) throw new InvariantError(`slot ${JSON.stringify(slotId)} 的 entry 必须形如 node.endpoint`);
    const [enode, eep] = entry.split(".", 2);
    const cnode = ((child.nodes ?? {}) as Record<string, Record<string, unknown>>)[enode!];
    if (!cnode || !(eep! in ((cnode.endpoints ?? {}) as Record<string, unknown>))) {
      throw new InvariantError(`slot ${JSON.stringify(slotId)} 的 entry ${JSON.stringify(entry)} 在子模板 ${childRef} 中不存在`);
    }
    const exitDecl = slot.exit as Record<string, unknown> | undefined;
    if (exitDecl) {
      const xep = String(exitDecl.endpoint ?? "").split(".");
      const childNodes = (child.nodes ?? {}) as Record<string, Record<string, unknown>>;
      if (xep.length !== 2 || !childNodes[xep[0]!] || !(xep[1]! in ((childNodes[xep[0]!]!.endpoints ?? {}) as Record<string, unknown>))) {
        throw new InvariantError(`slot ${JSON.stringify(slotId)} 的 exit.endpoint 在子模板中不存在：${JSON.stringify(exitDecl.endpoint)}`);
      }
    }
  }

  for (const sub of (spec.subscriptions ?? []) as Array<Record<string, unknown>>) {
    const topic = String(sub.topic ?? "");
    if (!rt.st.topics.has(topic)) {
      throw new InvariantError(`订阅引用了未注册的 topic ${JSON.stringify(topic)}；先 register_topic。可用 topic：${JSON.stringify([...rt.st.topics.keys()].sort())}`);
    }
    const endpoint = String(sub.endpoint ?? "");
    if (!endpoint.includes(".")) throw new InvariantError(`订阅 endpoint 必须形如 node.endpoint：${JSON.stringify(endpoint)}`);
    const [nid, ep] = endpoint.split(".", 2);
    epExists(nid!, ep!, `订阅 ${topic} 的 endpoint`);
  }
}

/** 连接期校验：边一旦画上就要能跑通。 */
export function validateEdges(rt: RuntimeLike, templateId: string, spec: Record<string, unknown>): void {
  const nodes = (spec.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const strict = Boolean(spec.strict_contracts);
  for (const edge of (spec.edges ?? []) as Array<Record<string, unknown>>) {
    const from = String(edge.from ?? "");
    const to = String(edge.to ?? "");
    const eid = String(edge.id ?? `${from}->${to}`);
    const op = String(edge.operation ?? "PUSH");
    if (op !== "PUSH") {
      throw new InvariantError(
        `边 ${eid} 不合法：operation=${JSON.stringify(op)} 未实现。V4 边只支持 PUSH；需要调用语义请用 subflow 节点或队列 REQUEST + callback（不变量 M3）`
      );
    }
    const [srcNodeId, srcEp] = from.split(".", 2);
    const [tgtNodeId, tgtEp] = to.split(".", 2);
    if (nodes[srcNodeId!]?.kind === "end") {
      throw new InvariantError(`边 ${eid} 不合法：end 是终态汇点，不得有出边；关闭语义由控制面 control(close) 承担`);
    }
    for (const [nodeId, ep] of [[srcNodeId, srcEp], [tgtNodeId, tgtEp]] as Array<[string | undefined, string | undefined]>) {
      const node = nodes[nodeId!];
      if (!node) {
        throw new InvariantError(`边 ${eid} 不合法：节点 ${JSON.stringify(nodeId)} 不存在。可用节点：${JSON.stringify(Object.keys(nodes).sort())}`);
      }
      if (!(ep! in ((node.endpoints ?? {}) as Record<string, unknown>))) {
        throw new InvariantError(`边 ${eid} 不合法：节点 ${JSON.stringify(nodeId)} 没有端点 ${JSON.stringify(ep)}。可用端点：${JSON.stringify(Object.keys((node.endpoints ?? {}) as Record<string, unknown>).sort())}`);
      }
    }
    const srcRef = endpointRef(nodes[srcNodeId!]!, srcEp!, "emit", op);
    const tgtRef = endpointRef(nodes[tgtNodeId!]!, tgtEp!, "receive", op);

    const servo = edge.servo as string | undefined;
    if (servo != null) {
      const transform = rt.st.transforms.get(servo);
      if (!transform) {
        throw new InvariantError(`边 ${eid} 不合法：Servo ${JSON.stringify(servo)} 未注册。可用 transform：${JSON.stringify([...rt.st.transforms.keys()].sort())}`);
      }
      if (transform.role !== "EDGE_SERVO") {
        throw new InvariantError(`边 ${eid} 不合法：只有 EDGE_SERVO 能绑边，${servo} 的 role=${JSON.stringify(transform.role)}`);
      }
      const illegal = Object.keys(transform.body).filter((k) => !SERVO_OPS.has(k));
      if (illegal.length) {
        throw new InvariantError(`边 ${eid} 不合法：Servo 只能改 payload，不得触碰路由/操作/契约/关联：${JSON.stringify(illegal.sort())}`);
      }
    }

    if (srcRef == null || tgtRef == null) {
      if (strict) {
        throw new InvariantError(
          `边 ${eid} 不合法：模板声明了 strict_contracts，但 ${srcRef == null ? "源" : "目标"}端点未声明 ${op} 契约`
        );
      }
      continue; // 未声明 = 未约束
    }
    const [srcAll] = fieldsOf(rt.contract(srcRef));
    const [, tgtReq] = fieldsOf(rt.contract(tgtRef));
    const after = servoFields(rt, srcAll, servo);
    const missing = [...tgtReq].filter((f) => !after.has(f));
    if (missing.length) {
      throw new InvariantError(
        `边 ${eid} 不合法：\n` +
          `  源    ${from}  产出 ${srcRef}  ${JSON.stringify([...srcAll].sort())}\n` +
          `  Servo ${servo ?? "（无）"} 之后  ${JSON.stringify([...after].sort())}\n` +
          `  目标  ${to}  要求 ${tgtRef}  必需 ${JSON.stringify([...tgtReq].sort())}\n` +
          `  缺失字段：${JSON.stringify(missing.sort())}。可用的映射来源：${JSON.stringify([...after].sort())}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 内核工具保留名（卡片不得占用）
// ---------------------------------------------------------------------------

export const KERNEL_TOOL_NAMES = new Set(["emit", "read_artifact", "publish", "spawn"]);

export { ObjectStore };
