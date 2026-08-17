/**
 * Nodeflow V5 —— 预置策略模板（对 Python nodeflow_presets.py 的 TS 移植）
 *
 * 这些是随产品附带的配置组合，不是内核类型：每个 preset 只是注册一条
 * policy + 一个普通 handler（或返回一段 approval 节点 dict），用户可改可弃。
 * fixed_rounds / threshold_loop 全部由 Strategy 配置 + Annotation 表达。
 */
import type { RuntimeLike } from "./runtime-like.js";
import { registerHandler, registerPolicy } from "./definitions.js";

function first(payloads: Record<string, unknown>): unknown {
  return Object.values(payloads)[0];
}

export interface PresetRef {
  policy: string;
  handler: string;
}

/** 按 payload.items 展开 N 个并行子容器（FANOUT_TO_SLOT）。 */
export function registerFanoutPreset(rt: RuntimeLike, opts: { policyId: string; handlerId: string; slot: string; maxItems?: number | null }): PresetRef {
  const { policyId, handlerId, slot, maxItems } = opts;
  registerPolicy(rt, policyId, {
    readiness: "ANY",
    output: { mode: "FANOUT_TO_SLOT", slot, ...(maxItems != null ? { max_items: maxItems } : {}) },
  });
  registerHandler(rt, handlerId, (payloads) => {
    const body = first(payloads);
    const items = body && typeof body === "object" ? ((body as Record<string, unknown>).items ?? []) : [];
    return { items: [...(items as unknown[])] };
  });
  return { policy: policyId, handler: handlerId };
}

/** 多路汇聚：每个必需端点各取一条，合并后从 out 输出。 */
export function registerReviewPreset(rt: RuntimeLike, opts: { policyId: string; handlerId: string; requiredInputs: string[] }): PresetRef {
  const { policyId, handlerId, requiredInputs } = opts;
  registerPolicy(rt, policyId, { readiness: "ALL_REQUIRED", required_inputs: [...requiredInputs], selection: "ONE_PER_INPUT" });
  registerHandler(rt, handlerId, (payloads) => ({ emit: { out: { merged: { ...payloads } } } }));
  return { policy: policyId, handler: handlerId };
}

/** 固定轮次循环：again 边跑 rounds 次后从 done 退出，每轮写 Annotation。 */
export function registerFixedRoundsPreset(rt: RuntimeLike, opts: { policyId: string; handlerId: string; rounds: number }): PresetRef {
  const { policyId, handlerId, rounds } = opts;
  registerPolicy(rt, policyId, { readiness: "ANY" });
  registerHandler(rt, handlerId, (payloads, ctx) => {
    const epoch = Number((ctx.state.epoch ?? 0)) + 1;
    ctx.state.epoch = epoch;
    return {
      annotate: { object_refs: {}, fields: { epoch, tags: ["fixed-rounds"] } },
      emit: { [epoch < rounds ? "again" : "done"]: first(payloads) },
    };
  });
  return { policy: policyId, handler: handlerId };
}

/** 阈值循环：payload[field] 达到阈值（max: >threshold）前走 again，否则 done。 */
export function registerThresholdLoopPreset(rt: RuntimeLike, opts: { policyId: string; handlerId: string; field: string; threshold: number; mode?: "max" | "min" }): PresetRef {
  const { policyId, handlerId, field, threshold, mode = "max" } = opts;
  registerPolicy(rt, policyId, { readiness: "ANY" });
  registerHandler(rt, handlerId, (payloads, ctx) => {
    const epoch = Number((ctx.state.epoch ?? 0)) + 1;
    ctx.state.epoch = epoch;
    const value = (first(payloads) as Record<string, unknown>)[field];
    const reached = mode === "max" ? Number(value) > threshold : Number(value) < threshold;
    return {
      annotate: { object_refs: {}, fields: { epoch, [field]: value, tags: ["threshold-loop"] } },
      emit: { [reached ? "done" : "again"]: first(payloads) },
    };
  });
  return { policy: policyId, handler: handlerId };
}

/** 人工放行节点配置（NodeDefinition 片段，不是 policy）。 */
export function approvalNodePreset(opts: { authorizedActors: string[]; approvePort?: string; denyPort?: string }): Record<string, unknown> {
  const { authorizedActors, approvePort = "out", denyPort = "denied" } = opts;
  return {
    kind: "approval",
    authorized_actors: [...authorizedActors],
    approve_port: approvePort,
    deny_port: denyPort,
    endpoints: { io: {}, [approvePort]: {}, [denyPort]: {} },
  };
}

/** 发现/画布可枚举的预置清单（只描述，不实例化）。 */
export const STRATEGY_PRESETS: Record<string, (rt: RuntimeLike, opts: Record<string, unknown>) => PresetRef> = {
  fanout: (rt, o) => registerFanoutPreset(rt, o as { policyId: string; handlerId: string; slot: string }),
  review: (rt, o) => registerReviewPreset(rt, o as { policyId: string; handlerId: string; requiredInputs: string[] }),
  fixed_rounds: (rt, o) => registerFixedRoundsPreset(rt, o as { policyId: string; handlerId: string; rounds: number }),
  threshold_loop: (rt, o) => registerThresholdLoopPreset(rt, o as { policyId: string; handlerId: string; field: string; threshold: number }),
};
