/**
 * 执行面窄接口 —— 编排面 ↔ 执行面的唯一契约。
 *
 * 对应 FOUNDATION_V5.md §14"直接继承"：这一层在 V4 已被真实模型验证过，
 * 语义保留，只换成 V5 的实例与变量模型。
 *
 * 五种终止原因**不能混成一种**，因为它们的后续处理不同：
 *   DONE            应用输出
 *   CANCELLED       是意图不是故障 —— 不重试
 *   BUDGET          是意图不是故障 —— 不重试
 *   INVALID_OUTPUT  模型没按 schema 输出 —— 重试
 *   FAILED          真故障 —— 重试
 */

import { z } from "zod";
import { Json, JsonObject } from "./json.js";
import { TraceId } from "./identity.js";
import type { ArtifactSubmission } from "./object.js";

export const TERMINATIONS = [
  "DONE",
  "CANCELLED",
  "BUDGET",
  "INVALID_OUTPUT",
  "FAILED",
] as const;

export type Termination = (typeof TERMINATIONS)[number];
export const Termination = z.enum(TERMINATIONS);

/** 不重试的终止原因：它们表达意图，不是故障。 */
export const NON_RETRYABLE: readonly Termination[] = ["CANCELLED", "BUDGET"];

export const ExecutionLimits = z
  .object({
    tokenBudget: z.number().int().positive().optional(),
    wallClockSeconds: z.number().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict();

export type ExecutionLimits = z.infer<typeof ExecutionLimits>;

export const Usage = z
  .object({
    inTokens: z.number().int().nonnegative().default(0),
    outTokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    wallClockSeconds: z.number().nonnegative().default(0),
    toolCalls: z.number().int().nonnegative().default(0),
    /**
     * 非零 = **图切分错误的告警信号**，不是正常统计项。
     * V5 里预算在注册期就求和过了（B1），所以这里非零意味着估算系数漂移，
     * 属观测，不参与裁决。
     */
    compactions: z.number().int().nonnegative().default(0),
  })
  .strict();

export type Usage = z.infer<typeof Usage>;

export const EMPTY_USAGE: Usage = {
  inTokens: 0,
  outTokens: 0,
  costUsd: 0,
  wallClockSeconds: 0,
  toolCalls: 0,
  compactions: 0,
};

/** `allowed_emit_ports` 由拓扑推导，不是用户可填字段 —— 第一不变量的落地点。 */
export const OutputContract = z
  .object({ allowedEmitPorts: z.array(z.string()).readonly() })
  .strict();

export type OutputContract = z.infer<typeof OutputContract>;

export interface ExecutionRequest {
  readonly executionId: string;
  readonly traceid: TraceId;
  readonly nodeId: string;
  readonly agentSpec: JsonObject;
  /** 编译好的调用上下文 —— bind 段 + 端口 servo 提出的变量。 */
  readonly vars: Readonly<Record<string, Json>>;
  readonly outputContract: OutputContract;
  readonly limits: ExecutionLimits;
}

export interface ExecutionResult {
  readonly executionId: string;
  /** 输出提案：端口名 → 载荷。**永远不含目标地址**。 */
  readonly emissions: Readonly<Record<string, Json>>;
  readonly artifacts?: readonly ArtifactSubmission[];
  readonly usage?: Usage;
  readonly termination: Termination;
  readonly diagnostics?: JsonObject;
}

export interface ExecutionBackend {
  run(request: ExecutionRequest): Promise<ExecutionResult>;
  /** best effort —— 气密性靠 generation fence，不靠这个（不变量 L3）。 */
  cancel(executionId: string): Promise<void>;
}
