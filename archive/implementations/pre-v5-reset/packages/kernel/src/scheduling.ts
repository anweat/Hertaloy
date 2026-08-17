/**
 * Nodeflow V5 —— 调度与执行（对 Python nodeflow_scheduling.py 的 TS 移植）
 *
 * 选取/claim 是同步临界区（单线程天然原子），execute 是锁外 async；
 * 三段式 claim/execute/apply；冲突域是 NodeInstance + 消费的消息集合。
 *
 * V5 P1 修复（白名单 delta，不复制 Python 已知 bug）：
 *   - P1-2  allowed_emit_ports 精确语义：默认 = 声明了 emit 的端口；
 *           无任何 emit 声明时退化为全部端口；receive-only 永不可 emit
 *   - P1-4  seq 只由 apply/control 推进；claim 只写 ExecutionRecord
 */
import { InvariantError, defaultUsage } from "./core.js";
import type { ExecutionRequest, ExecutionResult, ExecutionBackend, InstanceState, MessageState, Unit } from "./core.js";
import type { RuntimeLike } from "./runtime-like.js";
import { compileAgentPrompt, emitSchemaFor, endpointRef, prefixFingerprint, resolveSpec } from "./definitions.js";
import { kernelToolDefs } from "./kernel-tools.js";
import { estimateSpecTokens, fitContext } from "./budget.js";

export const SERVO_OPS = new Set(["set", "map", "drop"]);

const KERNEL_KINDS = new Set(["run", "annotation", "context_summary", "graph_template", "graph_template_proposal"]);

// ---------------------------------------------------------------------------
// 排空入口
// ---------------------------------------------------------------------------

export async function step(rt: RuntimeLike, gids?: string[], maxCommits = 1): Promise<number> {
  let done = 0;
  while (done < maxCommits && (await dispatchOnce(rt, gids))) done += 1;
  return done;
}

export async function drain(rt: RuntimeLike, gids?: string[]): Promise<void> {
  let guard = 0;
  while (await dispatchOnce(rt, gids)) {
    guard += 1;
    if (guard > 10_000) throw new InvariantError("drain did not converge");
  }
}

/** 并发排空：claim/apply 同步串行，execute 异步并行；同节点由信号量串行化。 */
export async function drainConcurrent(rt: RuntimeLike, gids?: string[], opts: { workers?: number; poll?: number; timeout?: number } = {}): Promise<void> {
  const { workers = 4, poll = 5, timeout = 120_000 } = opts;
  const scope = gids && gids.length ? new Set(gids) : null;
  const semaphores = new Map<string, Promise<void>>();
  const nodeKey = (gid: string, nodeId: string) => `${gid}/${nodeId}`;
  const acquire = async (gid: string, nodeId: string): Promise<() => void> => {
    const key = nodeKey(gid, nodeId);
    const prev = semaphores.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((res) => (release = res));
    semaphores.set(key, prev.then(() => cur));
    await prev;
    return release;
  };

  const deadline = Date.now() + timeout;
  let inflight = 0;
  const errors: unknown[] = [];
  const workersAlive = Array.from({ length: workers }, async () => {
    while (!errors.length) {
      if (Date.now() > deadline) {
        errors.push(new InvariantError("drainConcurrent 超时"));
        return;
      }
      const { unit, busy } = takeUnit(rt, scope);
      if (!unit) {
        if (!busy && inflight === 0) return;
        await sleep(poll);
        continue;
      }
      inflight += 1;
      const release = await acquire(unit.inst.gid, unit.nodeId);
      void runUnit(rt, unit)
        .catch((err) => errors.push(err))
        .finally(() => {
          release();
          inflight -= 1;
        });
    }
  });
  await Promise.all(workersAlive);
  if (errors.length) throw errors[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// 选取 / 执行
// ---------------------------------------------------------------------------

interface TakeResult {
  unit: Unit | null;
  busy: boolean;
}

export function takeUnit(rt: RuntimeLike, scope: Set<string> | null): TakeResult {
  for (const msg of rt.st.messages.values()) {
    if (msg.state !== "QUEUED") continue;
    const [gid, nodeId] = msg.target;
    if (scope && !scope.has(gid)) continue;
    const inst = rt.st.instances.get(gid);
    if (!inst || inst.status !== "OPEN") continue;
    const node = (rt.st.templates.get(inst.templateRef)?.nodes as Record<string, Record<string, unknown>>)?.[nodeId];
    if (!node) continue;
    const kind = String(node.kind ?? "");

    if (kind === "strategy") {
      const sel = selectForStrategy(rt, inst, nodeId, node);
      if (!sel) continue; // 未就绪，让给别的消息
      const { batch, discard, selCtx } = sel;
      for (const m of batch) m.state = "CLAIMED";
      for (const m of discard) m.state = "CLAIMED"; // DISCARD 同批消费，不进 handler
      const ev = (node.evaluator ?? {}) as Record<string, unknown>;
      if (ev.kind === "model") {
        // 模型驱动的判断也是一次执行，必须走三段式在锁外跑
        const eid = claim(rt, inst, nodeId, node, batch, String(ev.spec));
        rt.st.inflight += 1;
        return { unit: { kind: "model_strategy", inst, nodeId, node, batch, executionId: eid, discard, selectionCtx: selCtx }, busy: true };
      }
      rt.st.inflight += 1;
      return { unit: { kind: "strategy", inst, nodeId, node, batch, discard, selectionCtx: selCtx }, busy: true };
    }
    if (kind === "agent") {
      const eid = claim(rt, inst, nodeId, node, [msg]);
      rt.st.inflight += 1;
      return { unit: { kind: "agent", inst, nodeId, node, msg, executionId: eid, discard: [], selectionCtx: {} }, busy: true };
    }
    msg.state = "CLAIMED";
    rt.st.inflight += 1;
    return { unit: { kind: "simple", inst, nodeId, node, msg, discard: [], selectionCtx: {} }, busy: true };
  }
  return { unit: null, busy: rt.st.inflight > 0 };
}

export async function dispatchOnce(rt: RuntimeLike, gids?: string[]): Promise<boolean> {
  const scope = gids && gids.length ? new Set(gids) : null;
  const { unit } = takeUnit(rt, scope);
  if (!unit) return false;
  await runUnit(rt, unit);
  return true;
}

/** agent 的执行在"锁外"—— 单线程下即异步段。 */
export async function runUnit(rt: RuntimeLike, unit: Unit): Promise<void> {
  try {
    if (unit.kind === "agent") {
      const rec = rt.st.records.get(unit.executionId!)!;
      let result: ExecutionResult;
      try {
        result = await executeWithRetry(rt, rec); // 锁外，可能数分钟
      } catch {
        release(rt, unit.executionId!, "FAILED", "FAILED"); // backend 抛异常也是一次失败
        return;
      }
      if (result.termination === "CANCELLED") {
        release(rt, unit.executionId!, "CANCELLED");
      } else if (result.termination === "FAILED" || result.termination === "INVALID_OUTPUT" || result.termination === "BUDGET") {
        release(rt, unit.executionId!, "FAILED", result.termination);
      } else {
        const inst = rt.st.instances.get(rec.gid)!;
        const st = inst.nodes.get(rec.nodeId)!;
        if (st.version !== rec.baseNodeVersion) {
          // 乐观并发冲突：他人先提交，本执行作废；输入退回 QUEUED 重新认领
          release(rt, unit.executionId!, "FAILED", "FAILED");
          return;
        }
        try {
          applyExecution(rt, unit.executionId!, result);
        } catch {
          release(rt, unit.executionId!, "FAILED", "APPLY_REJECTED"); // 提交被拒：终态 FAILED 并经 on_error 进图
        }
      }
    } else if (unit.kind === "model_strategy") {
      const rec = rt.st.records.get(unit.executionId!)!;
      let result: ExecutionResult;
      try {
        result = await executeWithRetry(rt, rec); // 锁外
      } catch {
        release(rt, unit.executionId!, "FAILED", "FAILED");
        return;
      }
      if (result.termination !== "DONE") {
        release(rt, unit.executionId!, result.termination === "CANCELLED" ? "CANCELLED" : "FAILED", result.termination);
      } else if (
        rt.st.instances.get(rec.gid)!.status !== "OPEN" ||
        rt.st.instances.get(rec.gid)!.nodes.get(rec.nodeId)!.version !== rec.baseNodeVersion
      ) {
        // 终态气密 + 节点级冲突域：模型 evaluator 与 agent 同规
        release(rt, unit.executionId!, "FAILED", "APPLY_REJECTED");
      } else {
        try {
          rec.status = "APPLIED";
          // 模型的输出提案 → decision.emit，其余一律不接受。
          // 计量与观测必须随本次策略提交进入 RunSnapshot。
          handleStrategy(rt, unit.inst, unit.nodeId, unit.node, unit.batch!, {
            decision: { emit: Object.fromEntries(result.emissions) },
            trusted: false,
            discard: unit.discard,
            selectionCtx: unit.selectionCtx,
            executionMeta: {
              execution: unit.executionId,
              usage: result.usage,
              observations: result.observations,
              context_trims: rec.contextTrims,
              context: {
                head: [...rec.request!.context.head],
                messages: [...rec.request!.context.messages],
                tail: [...rec.request!.context.tail],
              },
            },
          });
        } catch {
          release(rt, unit.executionId!, "FAILED", "APPLY_REJECTED");
        }
      }
    } else if (unit.kind === "strategy") {
      try {
        handleStrategy(rt, unit.inst, unit.nodeId, unit.node, unit.batch!, {
          discard: unit.discard,
          selectionCtx: unit.selectionCtx,
        });
      } catch (err) {
        if (err instanceof InvariantError) throw err; // 契约/evaluator 守门违规是确定的编程错误
        failUnitMessages(rt, unit, err as Error);
      }
    } else {
      try {
        handle(rt, unit.msg!);
      } catch (err) {
        if (err instanceof InvariantError) throw err;
        failUnitMessages(rt, unit, err as Error);
      }
    }
  } finally {
    rt.st.inflight -= 1;
  }
}

/** 受信 handler 抛异常：消息进 FAILED 终态 + 失败快照，不滞留 CLAIMED（P0-7）。 */
export function failUnitMessages(rt: RuntimeLike, unit: Unit, exc: Error): void {
  const msgs = unit.kind === "simple" ? [unit.msg!] : [...(unit.batch ?? []), ...unit.discard];
  for (const m of msgs) {
    if (m.state === "QUEUED" || m.state === "CLAIMED") m.state = "FAILED";
  }
  const reason = `HANDLER_FAILED:${exc.name}:${exc.message}`;
  raiseIntoGraph(rt, unit.inst, unit.nodeId, unit.node, msgs, reason, 0);
}

// ---------------------------------------------------------------------------
// 策略选择与处理
// ---------------------------------------------------------------------------

export function selectForStrategy(rt: RuntimeLike, inst: InstanceState, nodeId: string, node: Record<string, unknown>): { batch: MessageState[]; discard: MessageState[]; selCtx: Record<string, unknown> } | null {
  const policy = rt.st.policies.get(String(node.policy))!;
  const byEp = new Map<string, MessageState[]>();
  for (const m of rt.st.messages.values()) {
    if (m.state === "QUEUED" && m.target[0] === inst.gid && m.target[1] === nodeId) {
      byEp.set(m.target[2], [...(byEp.get(m.target[2]) ?? []), m]);
    }
  }
  if (!byEp.size) return null;
  const readiness = String(policy.readiness ?? "ANY");
  if (readiness === "ALL_REQUIRED") {
    const required = (policy.required_inputs ?? []) as string[];
    if (!required.every((ep) => byEp.get(ep)?.length)) return null;
  }
  // ALL_REQUIRED 未声明 selection 时默认 ONE_PER_INPUT，ANY 默认 FIRST
  const selection = String(policy.selection ?? (readiness === "ALL_REQUIRED" ? "ONE_PER_INPUT" : "FIRST"));
  const selCtx: Record<string, unknown> = { selection };
  let batch: MessageState[];
  const discard: MessageState[] = [];

  if (selection === "FIRST") {
    batch = [byEp.values().next().value![0]!];
  } else if (selection === "TOP_ONE") {
    const candidates = [...byEp.values()].flat();
    const rankField = String(policy.rankField ?? "rank");
    let selected: MessageState;
    try {
      selected = candidates.reduce((a, b) => ((a.payload as Record<string, unknown>)[rankField] as number) >= ((b.payload as Record<string, unknown>)[rankField] as number) ? a : b);
    } catch (err) {
      throw new InvariantError(`TOP_ONE 按 ${JSON.stringify(rankField)} 排序失败：${(err as Error).message}；请检查 policy.rankField 与消息 payload`);
    }
    batch = [selected];
    if (String(policy.unselected ?? "RETAIN") === "DISCARD") {
      discard.push(...candidates.filter((m) => m !== selected));
    }
  } else if (selection === "ONE_PER_INPUT") {
    const required = (policy.required_inputs ?? []) as string[];
    batch = required.map((ep) => byEp.get(ep)![0]!);
  } else if (selection === "CROSS_ALL") {
    const required = (policy.required_inputs ?? []) as string[];
    if (required.length !== 2) throw new InvariantError(`CROSS_ALL 当前要求恰好两个 required_inputs，得到 ${JSON.stringify(required)}`);
    const left = byEp.get(required[0]!)!;
    const right = byEp.get(required[1]!)!;
    batch = [...left, ...right];
    selCtx.crossPairs = left.flatMap((l) => right.map((r) => [l.payload, r.payload]));
  } else {
    throw new InvariantError(`unsupported strategy selection: ${selection}`);
  }
  return { batch, discard, selCtx };
}

const DECISION_KEYS = new Set(["emit", "items", "annotate"]);
const MODEL_DECISION_KEYS = new Set(["emit"]);

/** 校验 evaluator 的返回，拒绝一切未声明的东西。 */
export function guardDecision(node: Record<string, unknown>, policy: Record<string, unknown>, decision: unknown, opts: { trusted: boolean; extraPorts?: Set<string> }): Record<string, unknown> {
  const { trusted, extraPorts = new Set() } = opts;
  const allowedKeys = trusted ? DECISION_KEYS : MODEL_DECISION_KEYS;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new InvariantError(`evaluator 必须返回映射，得到 ${decision === null ? "null" : typeof decision}`);
  }
  const d = decision as Record<string, unknown>;
  const unknown = Object.keys(d).filter((k) => !allowedKeys.has(k));
  if (unknown.length) {
    throw new InvariantError(
      `evaluator 返回了不允许的字段：${JSON.stringify(unknown.sort())}；允许：${JSON.stringify([...allowedKeys].sort())}` +
        (trusted ? "" : "（模型驱动的 evaluator 只能选择端口，不能构造）")
    );
  }
  const declared = new Set([...Object.keys((node.endpoints ?? {}) as Record<string, unknown>), ...extraPorts]);
  const emit = (d.emit ?? {}) as unknown;
  if (!emit || typeof emit !== "object" || Array.isArray(emit)) {
    throw new InvariantError("decision.emit 必须是 {port: payload}");
  }
  const bad = Object.keys(emit as Record<string, unknown>).filter((p) => !declared.has(p));
  if (bad.length) {
    throw new InvariantError(`evaluator 选择了未声明的端口：${JSON.stringify(bad.sort())}；可用：${JSON.stringify([...declared].sort())}`);
  }
  const items = (d.items ?? []) as unknown;
  if (Array.isArray(items) && items.length) {
    const outPolicy = (policy.output ?? {}) as Record<string, unknown>;
    if (outPolicy.mode !== "FANOUT_TO_SLOT") throw new InvariantError("policy 未声明 FANOUT_TO_SLOT，不得返回 items");
    if (!Array.isArray(items)) throw new InvariantError("decision.items 必须是列表");
    const cap = (outPolicy.max_items as number) ?? 32;
    if (items.length > cap) throw new InvariantError(`fan-out 数量 ${items.length} 超过上限 ${cap}`);
  }
  const ann = d.annotate;
  if (ann != null) {
    if (!ann || typeof ann !== "object" || Array.isArray(ann)) throw new InvariantError("decision.annotate 必须是映射");
    const unknownKeys = Object.keys(ann as Record<string, unknown>).filter((k) => k !== "object_refs" && k !== "fields");
    if (unknownKeys.length) throw new InvariantError(`annotate 含未声明字段：${JSON.stringify(unknownKeys.sort())}`);
    for (const [name, ref] of Object.entries(((ann as Record<string, unknown>).object_refs ?? {}) as Record<string, unknown>)) {
      const s = String(ref);
      const idx = s.lastIndexOf("@");
      if (idx <= 0 || !/^\d+$/.test(s.slice(idx + 1))) {
        throw new InvariantError(`annotate.object_refs[${JSON.stringify(name)}] = ${JSON.stringify(ref)} 不是精确版本引用（不变量 V4，形如 plan@2）`);
      }
    }
  }
  return d;
}

export function handleStrategy(
  rt: RuntimeLike,
  inst: InstanceState,
  nodeId: string,
  node: Record<string, unknown>,
  batch: MessageState[],
  opts: {
    decision?: Record<string, unknown> | null;
    trusted?: boolean;
    discard?: MessageState[];
    selectionCtx?: Record<string, unknown>;
    executionMeta?: Record<string, unknown>;
  } = {}
): void {
  const { decision = null, trusted = true, discard = [], selectionCtx = {}, executionMeta = null } = opts;
  const tpl = rt.st.templates.get(inst.templateRef)!;
  for (const m of batch) m.state = "CLAIMED";
  for (const m of discard) m.state = "CLAIMED";
  const policy = rt.st.policies.get(String(node.policy))!;
  const readiness = String(policy.readiness ?? "ANY");
  const selection = String(policy.selection ?? (readiness === "ALL_REQUIRED" ? "ONE_PER_INPUT" : "FIRST"));
  let payloads: Record<string, unknown>;
  if (selection === "CROSS_ALL") {
    payloads = {};
    for (const m of batch) {
      (payloads[m.target[2]] as unknown[] | undefined) ??= [];
      (payloads[m.target[2]] as unknown[]).push(m.payload);
    }
  } else {
    // FIRST / TOP_ONE / ONE_PER_INPUT：每个端点恰好一条，给单值
    payloads = {};
    for (const m of batch) payloads[m.target[2]] = m.payload;
  }
  const ctx = nodeCtx(rt, inst, nodeId);
  ctx.selection = selection;
  if (selectionCtx.crossPairs) ctx.crossPairs = selectionCtx.crossPairs;

  let decisionResolved: Record<string, unknown>;
  if (decision == null) {
    const evaluator = rt.st.handlers.get(String(node.handler ?? ""));
    decisionResolved = (evaluator ? evaluator(payloads, ctx) : {}) ?? {};
  } else {
    decisionResolved = decision;
  }

  const outPolicy = (policy.output ?? {}) as Record<string, unknown>;
  const outMode = String(outPolicy.mode ?? "");
  if (outMode === "CROSS") {
    // CROSS 的 left/right 是候选集合，不是路由端口：只允许受信 handler 经它们提交候选
    decisionResolved = guardDecision(node, policy, decisionResolved, {
      trusted,
      extraPorts: new Set([String(outPolicy.left), String(outPolicy.right)]),
    });
  } else {
    decisionResolved = guardDecision(node, policy, decisionResolved, { trusted });
  }
  const emit = { ...((decisionResolved.emit ?? {}) as Record<string, unknown>) };
  let emitFinal: Record<string, unknown> = emit;
  let stagedIds: string[] = [];
  if (outMode === "WAIT_ALL") {
    const res = stageStrategyOutputs(rt, inst, nodeId, outPolicy, emit, batch);
    emitFinal = res.emit;
    stagedIds = res.stagedIds;
  } else if (outMode === "CROSS") {
    emitFinal = crossStrategyOutputs(outPolicy, emit);
  }
  // 默认 / EMIT_EACH / FANOUT_TO_SLOT：emit 原样路由。

  const spawned: string[] = [];
  // 先把全部端口 prepare 完（纯函数，可能抛）—— 校验失败时子容器还没实例化，扇出与路由一起保持原子。
  const prepared: Array<[string, string, string, unknown]> = [];
  for (const [port, payload] of Object.entries(emitFinal)) {
    const drafts = Array.isArray(payload) ? (payload as unknown[]) : [payload]; // 列表 payload 按 V2 语义逐项扇出
    for (const draft of drafts) {
      prepared.push(...prepareRoute(rt, tpl, nodeId, port, draft));
    }
  }

  if (outMode === "FANOUT_TO_SLOT") {
    const slotId = String(outPolicy.slot);
    const slot = (tpl.slots as Record<string, Record<string, unknown>>)[slotId]!;
    const [entryNode, entryEp] = String(slot.entry).split(".", 2);
    for (const item of (decisionResolved.items ?? []) as unknown[]) {
      const child = rt.spawnChild(inst, slotId, slot);
      spawned.push(child);
      rt.newMessage([child, entryNode!, entryEp!], item);
    }
  }
  const traversed = materializeRoute(rt, inst, prepared);

  // 循环锚点 = Strategy 配置 + 一条 Annotation（ObjectVersion(kind="annotation")）。
  if ("annotate" in decisionResolved) {
    const ann = decisionResolved.annotate as Record<string, unknown>;
    const refs = { ...((ann.object_refs ?? {}) as Record<string, string>) };
    rt.appendObject(`annotation/${inst.gid}`, {
      object_refs: refs,
      fields: { ...((ann.fields ?? {}) as Record<string, unknown>) },
    }, {
      kind: "annotation",
      provenance: {
        graph_instance_id: inst.gid,
        node_id: nodeId,
        at_seq: inst.seq + 1,
        derived_from: Object.values(refs),
      },
    });
  }

  for (const m of batch) m.state = "CONSUMED";
  for (const m of discard) m.state = "CONSUMED";
  inst.seq += 1;
  const snapshot: Record<string, unknown> = {
    seq: inst.seq,
    node: nodeId,
    endpoint: Object.keys(payloads).sort().join(","),
    message: batch.map((m) => m.mid).join(","),
    discarded: discard.map((m) => m.mid).join(","),
    staged_message_ids: stagedIds,
    selection,
    topic: null,
    edges_traversed: traversed,
    spawned,
    payload: payloads,
  };
  if (executionMeta) snapshot.__execution_meta = executionMeta;
  rt.appendObject(`run/${inst.gid}`, snapshot, {
    kind: "run",
    provenance: { graph_instance_id: inst.gid, node_id: nodeId, at_seq: inst.seq },
  });
}

function stageStrategyOutputs(rt: RuntimeLike, inst: InstanceState, nodeId: string, outPolicy: Record<string, unknown>, emit: Record<string, unknown>, batch: MessageState[]): { emit: Record<string, unknown>; stagedIds: string[] } {
  const required = (outPolicy.required_outputs ?? []) as string[];
  if (!required.length) throw new InvariantError("WAIT_ALL 需要 required_outputs");
  const policyState = (inst.nodes.get(nodeId)!.persistent.policy_state ??= {}) as Record<string, unknown>;
  const staged = (policyState.staged_outputs ??= {}) as Record<string, unknown[]>;
  const stagedIds = (policyState.staged_message_ids ??= []) as string[];
  for (const [port, raw] of Object.entries(emit)) {
    const items = Array.isArray(raw) ? (raw as unknown[]) : [raw];
    (staged[port] ??= []).push(...items);
  }
  for (const m of batch) {
    if (!stagedIds.includes(m.mid)) stagedIds.push(m.mid);
  }
  if (required.some((port) => !(staged[port]?.length))) return { emit: {}, stagedIds: [...stagedIds] };
  const ready: Record<string, unknown> = {};
  for (const port of required) ready[port] = [...(staged[port] ?? [])];
  policyState.staged_outputs = {};
  policyState.staged_message_ids = [];
  return { emit: ready, stagedIds: [...stagedIds] };
}

/** CROSS(left,right,target)：同一轮 handler 返回的两组候选做笛卡尔积。 */
export function crossStrategyOutputs(outPolicy: Record<string, unknown>, emit: Record<string, unknown>): Record<string, unknown> {
  const leftName = String(outPolicy.left);
  const rightName = String(outPolicy.right);
  const targetName = String(outPolicy.target);
  if (!(leftName && rightName && targetName)) throw new InvariantError("CROSS 需要 left/right/target");
  const leftKey = String(outPolicy.leftKey ?? "left");
  const rightKey = String(outPolicy.rightKey ?? "right");
  const leftRaw = emit[leftName];
  const rightRaw = emit[rightName];
  if (leftRaw == null || rightRaw == null) {
    throw new InvariantError(`CROSS 需要 handler 同时返回 ${JSON.stringify(leftName)} 与 ${JSON.stringify(rightName)}`);
  }
  const leftItems = Array.isArray(leftRaw) ? (leftRaw as unknown[]) : [leftRaw];
  const rightItems = Array.isArray(rightRaw) ? (rightRaw as unknown[]) : [rightRaw];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(emit)) {
    if (k !== leftName && k !== rightName) out[k] = v;
  }
  out[targetName] = leftItems.flatMap((l) => rightItems.map((r) => ({ [leftKey]: l, [rightKey]: r })));
  return out;
}

// ---------------------------------------------------------------------------
// 简单节点处理（start/plain/subflow/approval/end）
// ---------------------------------------------------------------------------

export function handleSubflow(rt: RuntimeLike, inst: InstanceState, tpl: Record<string, unknown>, node: Record<string, unknown>, msg: MessageState): Record<string, unknown> {
  if (msg.mkind === "REPLY") {
    return { [String(node.return_port ?? "out")]: msg.payload };
  }
  const slotId = String(node.slot);
  const slot = (tpl.slots as Record<string, Record<string, unknown>>)[slotId]!;
  const child = rt.spawnChild(inst, slotId, slot);
  if (rt.st.instances.get(child)!.status !== "OPEN") {
    msg.state = "QUEUED"; // 输入恢复，不制造永远等待的子调用
    // RuntimeError 而非 InvariantError：可恢复运行故障，进 handler 失败通道（P0-7）
    throw new Error(`bound child ${child} is not OPEN`);
  }
  const [entryNode, entryEp] = String(slot.entry).split(".", 2);
  const exitDecl = (slot.exit ?? {}) as Record<string, unknown>;
  const exitPort = exitDecl.endpoint ? String(exitDecl.endpoint).split(".").pop() ?? null : null;
  rt.newMessage([child, entryNode!, entryEp!], msg.payload, {
    callback: [inst.gid, nodeId, msg.target[2]],
    exitPort,
    requestId: msg.requestId,
  });
  return {};
}

/** 调用式复用：slot 只绑定已存在 child；PER_CALL / WARM_POOL(n) / SINGLETON。 */
export function spawnChild(rt: RuntimeLike, inst: InstanceState, slotId: string, slot: Record<string, unknown>): string {
  if (inst.status !== "OPEN") throw new InvariantError(`${inst.gid} 已 ${inst.status}，不得创建新子实例`);
  const mode = String(slot.instantiation ?? "PER_CALL");
  const bucket = (inst.children[slotId] ??= []);
  if (mode === "SINGLETON" && bucket.length) return bucket[0]!;
  if (mode.startsWith("WARM_POOL")) {
    const cap = Number(mode.split("(")[1]!.replace(")", ""));
    if (bucket.length >= cap) {
      const cursor = inst.poolCursor[slotId] ?? 0;
      const child = bucket[cursor % cap]!;
      if (rt.instanceBusy(child)) {
        // 池满且目标实例仍忙：隔离优先 —— 临时新建独立实例并登记为 overflow 孤儿
        const orphan = rt.instantiateLocked(String(slot.template), `service:${inst.gid}`);
        (inst.overflow[slotId] ??= []).push(orphan);
        return orphan;
      }
      inst.poolCursor[slotId] = cursor + 1;
      // 只复用执行资源，不复用状态：清空 persistentState
      for (const st of rt.st.instances.get(child)!.nodes.values()) st.persistent = {};
      return child;
    }
  }
  const child = rt.instantiateLocked(String(slot.template), `service:${inst.gid}`);
  bucket.push(child);
  return child;
}

/** 回程 REPLY —— 终态气密（R13）：callback 目标已非 OPEN 时不得滞留死信。 */
export function emitReply(rt: RuntimeLike, inst: InstanceState, gid: string, nodeId: string, msg: MessageState, payload: unknown): void {
  const cbGid = msg.callback![0];
  const cbInst = rt.st.instances.get(cbGid);
  // PAUSED 不是终态：reply 照常投递并保留，resume 后消费；只有 CLOSED / 不存在才拒绝（R13）。
  if (!cbInst || cbInst.status === "CLOSED") {
    inst.seq += 1;
    rt.appendObject(`run/${gid}`, {
      seq: inst.seq,
      node: nodeId,
      endpoint: msg.target[2],
      dropped_reply: { to: cbGid, reason: cbInst ? cbInst.status : "unknown" },
      payload,
    }, { kind: "run", provenance: { graph_instance_id: gid, node_id: nodeId, at_seq: inst.seq } });
    return;
  }
  if (msg.topic && rt.st.topics.has(msg.topic)) {
    validatePayloadSchema(rt, rt.st.topics.get(msg.topic)!.reply_contract ?? null, payload, `topic ${msg.topic} 回复`);
  }
  rt.newMessage(msg.callback!, payload, { mkind: "REPLY", requestId: msg.requestId });
}

export function handle(rt: RuntimeLike, msg: MessageState): void {
  const [gid, nodeId, ep] = msg.target;
  const inst = rt.st.instances.get(gid)!;
  const tpl = rt.st.templates.get(inst.templateRef)!;
  const node = (tpl.nodes as Record<string, Record<string, unknown>>)[nodeId]!;
  const kind = String(node.kind);
  if (kind === "approval") {
    // 停在此处等待授权主体答复；不提交、不路由
    msg.state = "AWAITING";
    const pending = (inst.nodes.get(nodeId)!.persistent.pending ??= []) as string[];
    pending.push(msg.mid);
    return;
  }
  msg.state = "CLAIMED";
  let traversed: string[] = [];
  let outputs: Record<string, unknown> = {};
  if (kind === "start") {
    outputs = { [String(node.emit ?? "io")]: msg.payload };
  } else if (kind === "plain") {
    const fn = rt.st.handlers.get(String(node.handler))!;
    outputs = fn(msg.payload as Record<string, unknown>, nodeCtx(rt, inst, nodeId)) ?? {};
  } else if (kind === "subflow") {
    outputs = handleSubflow(rt, inst, tpl, node, msg);
  } else if (kind === "end") {
    // end 是终态汇点：消费到达的数据消息、记录一次终态提交。
    // 关闭与 DRAIN 不在内核：instance 关闭只能由控制面 control(close) 授权执行。
    outputs = {};
  } else {
    throw new InvariantError(`node kind not implemented yet: ${kind}`);
  }

  // 回程端口由 slot.exit 声明（#9）；未声明时退回 "reply" 兼容默认
  const back = msg.exitPort ?? "reply";
  if (back in outputs && msg.callback) {
    const payload = outputs[back];
    delete outputs[back];
    emitReply(rt, inst, gid, nodeId, msg, payload);
  }

  traversed = routeAll(rt, inst, tpl, nodeId, outputs);

  msg.state = "CONSUMED";
  inst.seq += 1;
  rt.appendObject(`run/${gid}`, {
    seq: inst.seq,
    node: nodeId,
    endpoint: ep,
    message: msg.mid,
    topic: msg.topic,
    edges_traversed: traversed,
    payload: msg.payload,
  }, { kind: "run", provenance: { graph_instance_id: gid, node_id: nodeId, at_seq: inst.seq } });
}

// ---------------------------------------------------------------------------
// 契约校验（JSON Schema 子集）
// ---------------------------------------------------------------------------

export function validatePayload(rt: RuntimeLike, ref: string | null, payload: unknown, where: string): void {
  validatePayloadSchema(rt, rt.contract(ref), payload, where);
}

export function validatePayloadSchema(rt: RuntimeLike, schema: Record<string, unknown> | null, payload: unknown, where: string, path = "$"): void {
  if (!schema) return;
  const types = schema.type;
  if (types) {
    const allowed = new Set(Array.isArray(types) ? (types as string[]) : [types as string]);
    const actual =
      payload === null ? "null"
      : typeof payload === "number" && Number.isInteger(payload) ? "integer"
      : typeof payload === "boolean" ? "boolean"
      : typeof payload === "number" ? "number"
      : Array.isArray(payload) ? "array"
      : typeof payload === "object" ? "object"
      : typeof payload;
    if (!allowed.has(actual)) {
      throw new InvariantError(`${where}${path}：类型应为 ${JSON.stringify([...allowed].sort())}，得到 ${actual}（${typeof payload}）`);
    }
  }
  checkValue(rt, schema, payload, `${where}${path}`);
  if (schema.type === "object") {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new InvariantError(`${where}${path}：要求对象，得到 ${typeof payload}`);
    }
    const p = payload as Record<string, unknown>;
    const missing = ((schema.required ?? []) as string[]).filter((k) => !(k in p));
    if (missing.length) throw new InvariantError(`${where}${path}：缺少必需字段 ${JSON.stringify(missing)}`);
    if (schema.additionalProperties === false) {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      const extra = Object.keys(p).filter((k) => !(k in props)).sort();
      if (extra.length) {
        throw new InvariantError(`${where}${path}：不允许字段 ${JSON.stringify(extra)}；允许：${JSON.stringify(Object.keys(props).sort())}`);
      }
    }
    for (const [k, ps] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
      if (k in p && ps && typeof ps === "object") {
        validatePayloadSchema(rt, ps as Record<string, unknown>, p[k], where, `${path}.${k}`);
      }
    }
  } else if (schema.type === "array" && Array.isArray(payload)) {
    const items = schema.items;
    if (items && typeof items === "object") {
      for (let i = 0; i < payload.length; i++) {
        validatePayloadSchema(rt, items as Record<string, unknown>, payload[i], where, `${path}[${i}]`);
      }
    }
  }
}

/** 字段取值校验（enum/const/pattern）。 */
export function checkValue(rt: RuntimeLike, ps: Record<string, unknown>, value: unknown, where: string): void {
  if ("enum" in ps && !(ps.enum as unknown[]).includes(value)) {
    throw new InvariantError(`${where}：值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(ps.enum)} 内`);
  }
  if ("const" in ps && value !== ps.const) {
    throw new InvariantError(`${where}：值必须等于 ${JSON.stringify(ps.const)}`);
  }
  if ("pattern" in ps) {
    if (!new RegExp(String(ps.pattern)).test(String(value))) {
      throw new InvariantError(`${where}：${JSON.stringify(value)} 不匹配 pattern ${JSON.stringify(ps.pattern)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 路由（两段式：先全部 prepare，再统一 materialize）
// ---------------------------------------------------------------------------

export function prepareRoute(rt: RuntimeLike, tpl: Record<string, unknown>, nodeId: string, port: string, payload: unknown): Array<[string, string, string, unknown]> {
  // 纯函数，零副作用。任一边失败 → 抛出，调用方尚未物化任何东西。
  const src = `${nodeId}.${port}`;
  const nodes = (tpl.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const prepared: Array<[string, string, string, unknown]> = [];
  for (const edge of (tpl.edges ?? []) as Array<Record<string, unknown>>) {
    if (edge.from !== src) continue;
    const eid = String(edge.id ?? `${edge.from}->${edge.to}`);
    const op = String(edge.operation ?? "PUSH");
    const [tgtNode, tgtEp] = String(edge.to).split(".", 2);
    const srcRef = endpointRef(nodes[nodeId] ?? {}, port, "emit", op);
    const tgtRef = endpointRef(nodes[tgtNode!] ?? {}, tgtEp!, "receive", op);
    let out: unknown = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : payload;
    validatePayload(rt, srcRef, out, `边 ${eid} 源端`);
    if (edge.servo) out = applyServo(rt, String(edge.servo), out);
    validatePayload(rt, tgtRef, out, `边 ${eid} 目标端（Servo 之后）`);
    prepared.push([eid, tgtNode!, tgtEp!, out]);
  }
  return prepared;
}

export function materializeRoute(rt: RuntimeLike, inst: InstanceState, prepared: Array<[string, string, string, unknown]>): string[] {
  const traversed: string[] = [];
  for (const [eid, tgtNode, tgtEp, out] of prepared) {
    rt.newMessage([inst.gid, tgtNode, tgtEp], out);
    traversed.push(eid);
  }
  return traversed;
}

/** 一次提交里的全部端口一起走两段式（边界 B5b）。 */
export function routeAll(rt: RuntimeLike, inst: InstanceState, tpl: Record<string, unknown>, nodeId: string, outputs: Record<string, unknown>): string[] {
  const prepared: Array<[string, string, string, unknown]> = [];
  for (const [port, payload] of Object.entries(outputs)) {
    prepared.push(...prepareRoute(rt, tpl, nodeId, port, payload));
  }
  return materializeRoute(rt, inst, prepared);
}

export function route(rt: RuntimeLike, inst: InstanceState, tpl: Record<string, unknown>, nodeId: string, port: string, payload: unknown): string[] {
  return routeAll(rt, inst, tpl, nodeId, { [port]: payload });
}

export function applyServo(rt: RuntimeLike, transformId: string, payload: unknown): unknown {
  const t = rt.st.transforms.get(transformId);
  if (!t) throw new InvariantError(`未注册的 transform：${transformId}`);
  if (t.role !== "EDGE_SERVO") throw new InvariantError("only EDGE_SERVO may bind to an edge");
  const illegal = Object.keys(t.body).filter((k) => !SERVO_OPS.has(k));
  if (illegal.length) {
    throw new InvariantError(`Servo 只能改 payload，不得触碰路由/操作/契约/关联：${JSON.stringify(illegal.sort())}`);
  }
  const body = t.body as Record<string, unknown>;
  const out: Record<string, unknown> =
    payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : { value: payload };
  for (const [k, v] of Object.entries((body.set ?? {}) as Record<string, unknown>)) out[k] = v;
  for (const [src, dst] of Object.entries((body.map ?? {}) as Record<string, string>)) {
    if (src in out) {
      out[dst] = out[src];
      delete out[src];
    }
  }
  return out;
}

export function nodeCtx(rt: RuntimeLike, inst: InstanceState, nodeId: string): Record<string, unknown> {
  return {
    gid: inst.gid,
    state: inst.nodes.get(nodeId)!.persistent,
    publish: (oid: string, body: Record<string, unknown>) => rt.appendObject(oid, body),
  };
}

// ---------------------------------------------------------------------------
// 三段式：claim / execute / apply
// ---------------------------------------------------------------------------

/** commit A —— 锁定输入，写 RUNNING 记录，推进节点级版本。 */
export function claim(rt: RuntimeLike, inst: InstanceState, nodeId: string, node: Record<string, unknown>, msgs: MessageState[], specId?: string): string {
  if (!rt.st.backend) throw new InvariantError("no execution backend configured");
  const st = inst.nodes.get(nodeId)!;
  // 休眠→唤醒时解析一次卡片版本，执行期间冻结
  const resolved = { ...resolveSpec(rt, specId ?? String(node.spec)) };
  // 卡片 + 输出契约 → system prompt 与工具全集（编译规则归内核）
  const { prompt, tools } = compileAgentPrompt(rt, resolved, node);
  resolved.systemPrompt = prompt;
  resolved.tools = tools;
  // 内核工具由节点声明推导：编译期定型，driver 执行中回调编排面（P0-6）
  resolved.kernel_tools = kernelToolDefs(node);
  resolved.prefix_hash = prefixFingerprint(resolved);
  const ctx = {
    head: [...inst.head],
    messages: msgs.map((m) => m.payload),
    tail: [...st.tail],
    transient: [...st.transient],
    meta: msgs.map((m) => ({ request_id: m.requestId, topic: m.topic, mkind: m.mkind })),
  };
  // transient 是本轮临时：进入请求后立即清空，下一轮不残留
  st.transient = [];
  // 预算在调用前处理：超预算是编排面的事，不该丢给 harness 去压缩
  const budget = ((node.limits as Record<string, unknown> | undefined)?.token_budget ?? null) as number | null;
  const fitted = fitContext(rt, ctx, budget, { gid: inst.gid, nodeId, overhead: estimateSpecTokens(rt, resolved) });
  st.lastContext = fitted.ctx;
  st.lastSpec = resolved;
  const eid = rt.nid("exec");
  // 工作区根：节点显式声明 > 实例 params.workspace_root > 当前目录。
  const workspaceRoot = String(node.workspace ?? (inst.params.workspace_root as string | undefined) ?? ".");
  const req: ExecutionRequest = {
    executionId: eid,
    agentSpec: resolved,
    context: fitted.ctx,
    origin: [inst.gid, nodeId],
    workspace: { root: workspaceRoot },
    outputContract: {
      schema: emitSchemaFor(rt, node),
      // V5 P1-2：默认 = 声明了 emit 的端口；无任何 emit 声明时退化为全部端口
      allowedEmitPorts: allowedEmitPorts(node),
    },
    resumeHandle: st.sessionHandle,
    limits: {},
  };
  for (const m of msgs) m.state = "CLAIMED";
  st.version += 1;
  // V5 P1-4：seq 只由 apply/control 推进 —— claim 不 bump
  rt.st.records.set(eid, {
    executionId: eid,
    gid: inst.gid,
    nodeId,
    status: "RUNNING",
    claimed: msgs.map((m) => m.mid),
    request: req,
    baseNodeVersion: st.version,
    contextTrims: fitted.trims,
  });
  // claim 是提交 A：RUNNING 记录 + CLAIMED 消息必须在此刻落盘（P0-4）
  rt.notifyChange();
  return eid;
}

export function allowedEmitPorts(node: Record<string, unknown>): string[] {
  const endpoints = (node.endpoints ?? {}) as Record<string, Record<string, unknown>>;
  const emitPorts = Object.entries(endpoints).filter(([, d]) => d && "emit" in d).map(([ep]) => ep);
  return emitPorts.length ? emitPorts : Object.keys(endpoints);
}

/** execute —— 事务外。输出不合 schema 在执行面内重试，不上升为协议错误。 */
export async function executeWithRetry(rt: RuntimeLike, rec: { request: ExecutionRequest }): Promise<ExecutionResult> {
  let result: ExecutionResult | null = null;
  for (let i = 0; i < rt.maxOutputRetries; i++) {
    result = await rt.st.backend!.run(rec.request);
    if (result.termination !== "INVALID_OUTPUT") return result;
  }
  return result!;
}

/** commit B —— base 检查只针对被 claim 的切片（节点级，非容器级）。 */
export function applyExecution(rt: RuntimeLike, executionId: string, result: ExecutionResult): void {
  const rec = rt.st.records.get(executionId);
  if (!rec) throw new InvariantError(`unknown execution: ${executionId}`);
  if (rec.status !== "RUNNING") throw new InvariantError(`execution is not RUNNING: ${rec.status}`);
  const inst = rt.st.instances.get(rec.gid);
  if (!inst) throw new InvariantError(`unknown instance: ${rec.gid}`);
  if (inst.status !== "OPEN") {
    throw new InvariantError(`${rec.gid} 已 ${inst.status}，拒绝提交在途执行（终态气密）`);
  }
  const st = inst.nodes.get(rec.nodeId)!;
  if (st.version !== rec.baseNodeVersion) throw new InvariantError("node-scoped base changed since claim");

  const tpl = rt.st.templates.get(inst.templateRef)!;
  const node = (tpl.nodes as Record<string, Record<string, unknown>>)[rec.nodeId]!;
  const allowed = rec.request!.outputContract.allowedEmitPorts;
  const claimed = rec.claimed.map((mid) => rt.st.messages.get(mid)!);
  const hasCallback = claimed.some((m) => m.callback);
  const outputs: Record<string, unknown> = {};
  for (const [port, payload] of result.emissions) {
    if (!allowed.includes(port)) {
      // "reply" 是回程通道，不是可自由选择的端口：只有本次输入确实携带 callback 时才放行
      if (!(port === "reply" && hasCallback)) {
        throw new InvariantError(`agent emitted undeclared port: ${port}`);
      }
    }
    outputs[port] = payload;
  }

  // ---- 校验段：全部纯函数，任一失败都不留副作用 --------------------------
  let reply: [[string, string, string], unknown, string | null] | null = null;
  if ("reply" in outputs) {
    const cbMsg = claimed.find((m) => m.callback);
    if (cbMsg) {
      const cb = cbMsg.callback!;
      const payload = outputs.reply;
      delete outputs.reply;
      if (cbMsg.topic && rt.st.topics.has(cbMsg.topic)) {
        validatePayloadSchema(rt, rt.st.topics.get(cbMsg.topic)!.reply_contract ?? null, payload, `topic ${cbMsg.topic} 回复`);
      }
      const cbInst = rt.st.instances.get(cb[0]);
      // PAUSED 保留投递，只有 CLOSED / 不存在才拒绝（R13）
      if (!cbInst || cbInst.status === "CLOSED") {
        throw new InvariantError(`REPLY 目标 ${cb[0]} 已 ${cbInst ? cbInst.status : "不存在"}，拒绝提交回程消息`);
      }
      reply = [cb, payload, cbMsg.requestId];
    }
  }
  const prepared: Array<[string, string, string, unknown]> = [];
  for (const [port, payload] of Object.entries(outputs)) {
    // 第一不变量的取值维度：即使该端口没有出边，emit 契约也必须在 apply 阶段校验
    const srcRef = endpointRef(node, port, "emit", "PUSH");
    validatePayload(rt, srcRef, payload, `端口 ${port} 源端`);
    prepared.push(...prepareRoute(rt, tpl, rec.nodeId, port, payload));
  }
  for (const [kind, oid] of result.artifacts) {
    if (KERNEL_KINDS.has(kind) || oid.startsWith("run/") || oid.startsWith("annotation/")) {
      throw new InvariantError(`backend 不得提交内核保留对象：kind=${JSON.stringify(kind)} oid=${JSON.stringify(oid)}；内核 kind 与 run//annotation/ 前缀归内核，用户 kind（plan/spec/…）自由`);
    }
  }

  // ---- 物化段：从这里开始不再抛 -------------------------------------------
  const produced: string[] = [];
  for (const [kind, oid, body] of result.artifacts) {
    const ov = rt.appendObject(oid, body, {
      kind,
      provenance: {
        graph_instance_id: rec.gid,
        node_id: rec.nodeId,
        execution_id: executionId,
        at_seq: inst.seq + 1,
        derived_from: [...rec.request!.context.head], // lineage 起点
      },
    });
    produced.push(ov.ref);
  }
  st.sessionHandle = result.sessionHandle;
  if (reply) {
    rt.newMessage(reply[0], reply[1], { mkind: "REPLY", requestId: reply[2] });
  }
  const traversed = materializeRoute(rt, inst, prepared);

  for (const m of claimed) m.state = "CONSUMED";
  rec.status = "APPLIED";
  inst.seq += 1;
  rt.appendObject(`run/${rec.gid}`, {
    seq: inst.seq,
    node: rec.nodeId,
    execution: executionId,
    endpoint: [...new Set(claimed.map((m) => m.target[2]))].sort().join(","),
    message: rec.claimed.join(","),
    topic: claimed.find((m) => m.topic)?.topic ?? null,
    edges_traversed: traversed,
    usage: result.usage,
    produced,
    context_trims: rec.contextTrims,
    observations: result.observations,
    payload: rec.request!.context.messages,
  }, {
    kind: "run",
    provenance: {
      graph_instance_id: rec.gid,
      node_id: rec.nodeId,
      execution_id: executionId,
      at_seq: inst.seq,
      derived_from: [...produced],
    },
  });
}

const RETRYABLE = new Set(["FAILED"]);

export function release(rt: RuntimeLike, executionId: string, status: "CANCELLED" | "FAILED", reason?: string): void {
  const rec = rt.st.records.get(executionId)!;
  rec.status = status;
  const msgs = rec.claimed.map((mid) => rt.st.messages.get(mid)!);
  if (status === "CANCELLED") {
    for (const m of msgs) m.state = "QUEUED"; // 取消是意图，工作留着
    rt.notifyChange(); // CANCELLED 事实也要持久化（P0-4）
    return;
  }
  const inst = rt.st.instances.get(rec.gid)!;
  const node = ((rt.st.templates.get(inst.templateRef)!.nodes ?? {}) as Record<string, Record<string, unknown>>)[rec.nodeId]!;
  const cap = ((node.limits as Record<string, unknown> | undefined)?.max_attempts as number | undefined) ?? rt.defaultMaxAttempts;
  const retryable = (reason ?? "FAILED") === "FAILED";
  for (const m of msgs) m.attempts += 1;
  if (retryable && msgs.every((m) => m.attempts < cap)) {
    for (const m of msgs) m.state = "QUEUED"; // 还能再试
    rt.notifyChange(); // 重试计数与回队状态要持久化（P0-4）
    return;
  }
  for (const m of msgs) m.state = "FAILED"; // 终态，不再被调度
  raiseIntoGraph(rt, inst, rec.nodeId, node, msgs, reason ?? "FAILED", cap);
}

/** 失败沿边进入图 —— 由策略节点决定怎么办，而不是静默消失。 */
export function raiseIntoGraph(rt: RuntimeLike, inst: InstanceState, nodeId: string, node: Record<string, unknown>, msgs: MessageState[], reason: string, attempts: number): void {
  const payload = {
    error: reason,
    node: nodeId,
    attempts: Math.max(...msgs.map((m) => m.attempts), 0),
    messages: msgs.map((m) => m.mid),
  };
  const errPort = node.on_error as string | undefined;
  const tpl = rt.st.templates.get(inst.templateRef)!;
  let traversed: string[] = [];
  if (errPort && inst.status === "OPEN") {
    traversed = route(rt, inst, tpl, nodeId, errPort, payload);
  } else if (errPort) {
    payload.dropped = inst.status; // 实例已非 OPEN：不再路由，错误只落 RunSnapshot
  }
  inst.seq += 1;
  rt.appendObject(`run/${inst.gid}`, {
    seq: inst.seq,
    node: nodeId,
    endpoint: null,
    failure: payload,
    edges_traversed: traversed,
  }, { kind: "run", provenance: { graph_instance_id: inst.gid, node_id: nodeId, at_seq: inst.seq } });
}

// ---------------------------------------------------------------------------
// 显式 claim / 取消 / 崩溃接管
// ---------------------------------------------------------------------------

/** 显式 claim（供调度器与测试分步驱动）。返回 [execution_id, request]。 */
export function beginExecution(rt: RuntimeLike, gid: string, nodeId: string): [string, ExecutionRequest] | null {
  const inst = rt.st.instances.get(gid)!;
  const node = ((rt.st.templates.get(inst.templateRef)!.nodes ?? {}) as Record<string, Record<string, unknown>>)[nodeId]!;
  const pending = [...rt.st.messages.values()].filter((m) => m.state === "QUEUED" && m.target[0] === gid && m.target[1] === nodeId);
  if (!pending.length) return null;
  const eid = claim(rt, inst, nodeId, node, pending.slice(0, 1));
  return [eid, rt.st.records.get(eid)!.request!];
}

export async function cancelExecution(rt: RuntimeLike, executionId: string): Promise<void> {
  const rec = rt.st.records.get(executionId);
  if (!rec || rec.status !== "RUNNING") return;
  if (rt.st.backend) await rt.st.backend.cancel(executionId);
  release(rt, executionId, "CANCELLED");
}

/** 崩溃接管：RUNNING 记录是唯一依据，输入退回 QUEUED 可被重新认领。 */
export function reclaimStaleExecutions(rt: RuntimeLike): string[] {
  const stale = [...rt.st.records.values()].filter((r) => r.status === "RUNNING").map((r) => r.executionId);
  for (const eid of stale) release(rt, eid, "FAILED", "FAILED");
  return stale;
}

export { defaultUsage };
export type { ExecutionBackend };
