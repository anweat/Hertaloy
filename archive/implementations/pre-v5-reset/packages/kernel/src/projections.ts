/**
 * Nodeflow V5 —— 观察投影（对 Python nodeflow_projections.py 的 TS 移植）
 *
 * 只读。任何写入都不属于这里。返回副本/frozen，不暴露可写引用。
 */
import { InvariantError } from "./core.js";
import type { ExecutionRecordView, ObjectVersion, QueueView, Usage } from "./core.js";
import type { RuntimeLike } from "./runtime-like.js";
import { deepFreeze, resolveSpec } from "./definitions.js";

export function graphStatus(rt: RuntimeLike, gid: string): string {
  return rt.st.instances.get(gid)!.status;
}

export function nodePersistentState(rt: RuntimeLike, gid: string, nodeId: string): Readonly<Record<string, unknown>> {
  return deepFreeze({ ...rt.st.instances.get(gid)!.nodes.get(nodeId)!.persistent });
}

export function nodeExecutions(rt: RuntimeLike, gid: string, nodeId: string): ExecutionRecordView[] {
  return [...rt.st.records.values()]
    .filter((r) => r.gid === gid && r.nodeId === nodeId)
    .map((r) => ({ executionId: r.executionId, graphInstanceId: r.gid, nodeId: r.nodeId, status: r.status as ExecutionRecordView["status"] }));
}

export function childrenOf(rt: RuntimeLike, gid: string, slotId: string): string[] {
  return [...(rt.st.instances.get(gid)!.children[slotId] ?? [])];
}

/** WARM_POOL 忙时临时扩容、等待回收的孤儿实例。 */
export function overflowChildren(rt: RuntimeLike, gid: string, slotId: string): string[] {
  return [...(rt.st.instances.get(gid)!.overflow[slotId] ?? [])];
}

/** 该节点当前上下文构成（只含 head+tail；某次调用实际收到的读 backend 记录）。 */
export function contextOf(rt: RuntimeLike, gid: string, nodeId: string): { head: string[]; tail: string[] } {
  const inst = rt.st.instances.get(gid)!;
  const st = inst.nodes.get(nodeId)!;
  return { head: [...inst.head], tail: [...st.tail] };
}

export function agentSpecOf(rt: RuntimeLike, gid: string, nodeId: string): Readonly<Record<string, unknown>> {
  const inst = rt.st.instances.get(gid)!;
  const st = inst.nodes.get(nodeId)!;
  if (st.lastSpec) return deepFreeze(structuredClone(st.lastSpec));
  const tpl = rt.st.templates.get(inst.templateRef)!;
  const node = (tpl.nodes as Record<string, Record<string, unknown>>)[nodeId]!;
  return deepFreeze(resolveSpec(rt, String(node.spec)));
}

export function artifactVersions(rt: RuntimeLike, oid: string): number[] {
  return rt.store.history(oid).map((ov) => ov.version);
}

export function searchCards(rt: RuntimeLike, opts: { kind?: string; tags?: string[]; query?: string }): string[] {
  const wanted = new Set(opts.tags ?? []);
  const out: string[] = [];
  const entries = [...rt.st.cards.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, versions] of entries) {
    const [k] = key.split("/", 2);
    if (opts.kind != null && k !== opts.kind) continue;
    for (const version of [...versions.keys()].sort((a, b) => a - b)) {
      const cardTags = new Set<string>();
      for (const [tag, refs] of rt.st.cardTags) {
        if (refs.has(`${key}@${version}`)) cardTags.add(tag);
      }
      if (wanted.size && ![...wanted].every((t) => cardTags.has(t))) continue;
      if (opts.query) {
        const body = versions.get(version)!;
        const hay = `${key.split("/")[1]} ${String(body.summary ?? "")} ${String(body.text ?? "")}`;
        if (!hay.toLowerCase().includes(opts.query.toLowerCase())) continue;
      }
      out.push(`${key}@${version}`);
    }
  }
  return out;
}

export function graphTemplateVersions(rt: RuntimeLike, templateId: string): ObjectVersion[] {
  return rt.store.history(`graph_template/${templateId}`);
}

export function templateLayout(rt: RuntimeLike, templateRef: string): unknown {
  return rt.st.layouts.get(templateRef) ?? {};
}

export function graphTemplateProposal(rt: RuntimeLike, proposalId: string): ObjectVersion {
  return rt.store.head(`graph_template_proposal/${proposalId}`);
}

export function artifact(rt: RuntimeLike, oid: string, version: number): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(rt.store.get(oid, version).body));
}

export function annotations(rt: RuntimeLike, gid: string): ObjectVersion[] {
  return rt.store.history(`annotation/${gid}`);
}

export function searchAnnotations(rt: RuntimeLike, opts: { tags?: string[]; objectRefs?: Record<string, string> | string[]; gid?: string | null; fields?: Record<string, unknown> }): ObjectVersion[] {
  const wantedTags = new Set(opts.tags ?? []);
  const wantedRefs = new Set(
    opts.objectRefs
      ? Array.isArray(opts.objectRefs)
        ? opts.objectRefs
        : Object.values(opts.objectRefs)
      : []
  );
  const wantedFields = opts.fields ?? {};
  const out: ObjectVersion[] = [];
  for (const [oid, versions] of rt.store.allObjects()) {
    if (!oid.startsWith("annotation/")) continue;
    if (opts.gid != null && oid !== `annotation/${opts.gid}`) continue;
    for (const ov of versions) {
      const body = ov.body;
      const annTags = new Set((((body.fields ?? {}) as Record<string, unknown>).tags ?? []) as string[]);
      if (wantedTags.size && ![...wantedTags].every((t) => annTags.has(t))) continue;
      const annRefs = new Set(Object.values((body.object_refs ?? {}) as Record<string, string>));
      if (wantedRefs.size && ![...wantedRefs].every((r) => annRefs.has(r))) continue;
      const annFields = (body.fields ?? {}) as Record<string, unknown>;
      if (Object.entries(wantedFields).some(([k, v]) => annFields[k] !== v)) continue;
      out.push(ov);
    }
  }
  return out;
}

export function queue(rt: RuntimeLike, topicId: string): QueueView {
  if (!rt.st.topics.has(topicId)) throw new InvariantError(`unknown topic: ${topicId}`);
  let depth = 0;
  for (const m of rt.st.messages.values()) {
    if (m.topic === topicId && m.state === "QUEUED") depth += 1;
  }
  return {
    topicId,
    depth,
    subscriberEndpoints: (rt.st.subs.get(topicId) ?? []).map(([, t]) => t),
  };
}

export function usage(rt: RuntimeLike, gid: string): Usage {
  const acc: Record<string, number> = {};
  for (const ov of rt.store.history(`run/${gid}`)) {
    const u = ov.body.usage;
    if (!u || typeof u !== "object") continue;
    for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
      acc[k] = (acc[k] ?? 0) + Number(v ?? 0);
    }
  }
  return {
    inTokens: acc.in_tokens ?? 0,
    outTokens: acc.out_tokens ?? 0,
    cost: acc.cost ?? 0,
    wallClockSeconds: acc.wall_clock_seconds ?? 0,
    toolCalls: acc.tool_calls ?? 0,
    compactions: acc.compactions ?? 0,
  };
}

/** 压缩不是特性，是图切分错误的告警信号。 */
export function contextAlerts(rt: RuntimeLike, gid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const ov of rt.store.history(`run/${gid}`)) {
    const body = ov.body;
    const u = body.usage as Record<string, unknown> | undefined;
    if (u && typeof u === "object" && (u.compactions ?? 0) > 0) {
      out.push({
        kind: "compaction",
        node: body.node,
        execution: body.execution,
        compactions: u.compactions,
        reason: "上下文压缩发生 —— 该节点承担的任务过大，应拆分",
      });
    }
    const trims = body.context_trims;
    if (Array.isArray(trims) && trims.length) {
      out.push({
        kind: "truncation",
        node: body.node,
        execution: body.execution,
        trims: [...trims],
        reason: "为塞进预算裁剪了上下文 —— 与压缩同级的失败信号",
      });
    }
  }
  return out;
}

export function commitSeq(rt: RuntimeLike, gid: string): number {
  return rt.st.instances.get(gid)!.seq;
}

export function runSnapshots(rt: RuntimeLike, gid: string): ObjectVersion[] {
  return rt.store.history(`run/${gid}`);
}

export function messagesOf(rt: RuntimeLike, gid: string): Array<{ mid: string; target: [string, string, string]; state: string; mkind: string; attempts: number }> {
  return [...rt.st.messages.values()]
    .filter((m) => m.target[0] === gid)
    .map((m) => ({ mid: m.mid, target: m.target, state: m.state, mkind: m.mkind, attempts: m.attempts }));
}
