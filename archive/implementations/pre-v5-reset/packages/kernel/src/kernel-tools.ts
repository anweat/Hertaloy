/**
 * Nodeflow V5 —— 内核工具桥（对 nodeflow_v4._kernel_tool_defs/_dispatch_kernel_tool 移植）
 *
 * 执行面回调编排面的唯一合法通道：
 *   - read_artifact 恒可用：只读，精确版本引用（V4），返回深拷贝 body
 *   - publish       仅在节点声明 publish_topics 时可用；topic 是枚举，
 *                    callback 落回声明端点（M3），共享 request_id
 *   - spawn         仅在节点声明 spawn_slots 时可用；slot 是枚举，
 *                   实例化后投递 entry
 * Agent 仍然只能**选**，不能构造地址/能力（第一不变量）。
 *
 * 内核工具只能回调内核：driver 不得本地实现 publish/spawn/read_artifact（红线 9）。
 */
import { InvariantError } from "./core.js";
import type { RuntimeLike } from "./runtime-like.js";

export function kernelToolDefs(node: Record<string, unknown>): Array<Record<string, unknown>> {
  if (node.kind !== "agent") return []; // 模型 evaluator 等非 agent 节点无内核工具桥
  const defs: Array<Record<string, unknown>> = [
    {
      name: "read_artifact",
      source: "kernel",
      description: "按精确版本引用读取 ObjectVersion 正文，如 plan@2。只读。",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "精确版本引用，形如 object_id@version" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  ];
  const topics = (node.publish_topics ?? {}) as Record<string, unknown>;
  if (Object.keys(topics).length) {
    defs.push({
      name: "publish",
      source: "kernel",
      description: "向预先声明的主题发布请求消息，回复回到本节点声明的回调端点。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: Object.keys(topics).sort() },
          payload: { type: "object" },
        },
        required: ["topic", "payload"],
        additionalProperties: false,
      },
    });
  }
  const slots = (node.spawn_slots ?? []) as string[];
  if (slots.length) {
    defs.push({
      name: "spawn",
      source: "kernel",
      description: "实例化一个预先声明的子容器 slot，并把 payload 投到其 entry。",
      parameters: {
        type: "object",
        properties: {
          slot: { type: "string", enum: [...slots].sort() },
          payload: { type: "object" },
        },
        required: ["slot", "payload"],
        additionalProperties: false,
      },
    });
  }
  return defs;
}

export interface KernelToolResult {
  [key: string]: unknown;
}

/** driver 执行中回调：只接受**本次执行**声明的内核工具。 */
export function dispatchKernelTool(rt: RuntimeLike, executionId: string, name: string, arguments_: Record<string, unknown>): KernelToolResult {
  const rec = rt.st.records.get(executionId);
  if (!rec || rec.status !== "RUNNING") {
    throw new InvariantError(`内核工具拒绝：execution ${executionId} 不在 RUNNING`);
  }
  const inst = rt.st.instances.get(rec.gid);
  if (!inst) throw new InvariantError(`内核工具拒绝：实例 ${rec.gid} 不存在`);
  if (inst.status !== "OPEN") {
    throw new InvariantError(`内核工具拒绝：实例 ${rec.gid} 已 ${inst.status}`);
  }
  const tpl = rt.st.templates.get(inst.templateRef);
  const node = ((tpl?.nodes ?? {}) as Record<string, Record<string, unknown>>)[rec.nodeId]!;
  const declared = new Set(kernelToolDefs(node).map((t) => String(t.name)));
  if (!declared.has(name)) {
    throw new InvariantError(`内核工具 ${JSON.stringify(name)} 未声明给节点 ${rec.nodeId}；可用：${JSON.stringify([...declared].sort())}`);
  }

  if (name === "read_artifact") {
    const ref = String(arguments_.ref ?? "");
    const ov = rt.store.resolve(ref);
    return {
      object_id: ov.object_id,
      version: ov.version,
      kind: ov.kind,
      body: structuredClone(ov.body),
    };
  }
  if (name === "publish") {
    const topics = (node.publish_topics ?? {}) as Record<string, string>;
    const topic = String(arguments_.topic ?? "");
    if (!(topic in topics)) {
      throw new InvariantError(`publish：topic ${JSON.stringify(topic)} 未声明；可用：${JSON.stringify(Object.keys(topics).sort())}`);
    }
    const callbackEp = topics[topic]!;
    // 回调落回本节点的已声明端点（M3）；agent 不构造地址
    const ids = rt.publishLocked(topic, (arguments_.payload ?? {}) as Record<string, unknown>, {
      callback: [rec.gid, rec.nodeId, callbackEp],
    });
    return { message_ids: ids };
  }
  if (name === "spawn") {
    const slots = (node.spawn_slots ?? []) as string[];
    const slotId = String(arguments_.slot ?? "");
    if (!slots.includes(slotId)) {
      throw new InvariantError(`spawn：slot ${JSON.stringify(slotId)} 未声明；可用：${JSON.stringify([...slots].sort())}`);
    }
    const slot = ((tpl?.slots ?? {}) as Record<string, Record<string, unknown>>)[slotId]!;
    const child = rt.spawnChild(inst, slotId, slot);
    const [entryNode, entryEp] = String(slot.entry).split(".", 2);
    const mid = rt.newMessage([child, entryNode!, entryEp!], arguments_.payload ?? {});
    return { child, message_id: mid };
  }
  throw new InvariantError(`unknown kernel tool: ${name}`);
}
