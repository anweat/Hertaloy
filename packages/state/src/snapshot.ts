/**
 * 快照导出 —— 后端这一侧的出口，`@nodeflow/scene` 的输入。
 *
 * 它做两件事，都很小但都必要：
 *
 * 1. **脱掉存储编码。** head 落盘时把 Map 编码成 `{"$hertaloy$map": [...]}`，
 *    那是存储的事，不该泄漏到线上 —— 前端不该为了读一张图去认识我们的编解码。
 * 2. **只送渲染要的那些字段。** 载荷不送：它可能很大、可能含敏感内容，
 *    而画布只需要"有没有流过"，不需要"流的是什么"。要看内容有 `show` 命令。
 *
 * ⚠️ 这里**不是**在定义第二种格式（ComfyUI 那套 UI/API 双格式我们明确不学）。
 * 形状仍是 head 的形状，只是去掉了外衣和用不上的字段。
 */

import type { Runtime } from "@nodeflow/kernel";
import type { RunState } from "./run-state.js";

export interface RunSnapshot {
  readonly root: string | null;
  readonly instances: Record<string, unknown>;
  readonly templates: Record<string, unknown>;
  readonly messages: readonly unknown[];
  readonly records: readonly unknown[];
  readonly objects: readonly unknown[];
  /**
   * 锁账本 —— **谁在等谁**。
   *
   * 这一块此前一个字段都没导出，于是"容器间关系"里最要紧的那一半
   * （等待、请求、子容器阻塞父容器）渲染层根本看不见。而它完整地躺在内核里：
   * `Lock` 有 holder / waitingOn / originNode / kind。
   * `runtime.locks` 本来就是公开 getter —— 缺的从来只是这一行导出。
   */
  readonly locks: readonly unknown[];
}

/**
 * 导出一份快照。`scope` 给了就只导那个前缀的子树 —— 视口就是前缀，
 * 裁剪就是前缀查询（那套前缀机制的又一次复用）。
 */
export function exportSnapshot(state: RunState, scope?: string): RunSnapshot {
  const runtime: Runtime = state.runtime;
  const root = state.registry.rootTrace;
  const inScope = (traceid: string): boolean =>
    scope === undefined || traceid === scope || traceid.startsWith(`${scope}/`);

  const instances: Record<string, unknown> = {};
  const templates: Record<string, unknown> = {};
  const roots = root === null ? [] : state.registry.subtree(root);
  for (const instance of roots) {
    if (!inScope(instance.traceid)) continue;
    instances[instance.traceid] = {
      traceid: instance.traceid,
      templateRef: instance.templateRef,
      status: instance.status,
      ...(instance.slot === undefined ? {} : { slot: instance.slot }),
      nodes: Object.fromEntries(
        [...instance.nodes.keys()].map((nodeId) => [nodeId, { nodeId }]),
      ),
    };
    if (templates[instance.templateRef] === undefined) {
      templates[instance.templateRef] = state.store.resolve(instance.templateRef).body;
    }
  }

  const messages = runtime
    .messages()
    .filter((m) => inScope(m.target.traceid))
    // 载荷不出去 —— 画布只需要"有没有流过"
    .map((m) => ({
      id: m.id,
      target: m.target,
      state: m.state,
      ...(m.source === undefined ? {} : { source: m.source }),
      ...(m.tunnel === undefined ? {} : { tunnel: m.tunnel }),
    }));

  const records = runtime
    .records()
    .filter((r) => inScope(r.traceid))
    .map((r) => ({
      traceid: r.traceid,
      nodeId: r.nodeId,
      status: r.status,
      ...(r.termination === undefined ? {} : { termination: r.termination }),
    }));

  const objects = state.store
    .appended(0)
    .filter((v) => inScope(v.object_id))
    .map((v) => ({ object_id: v.object_id, kind: v.kind, version: v.version }));

  const locks = runtime.locks
    .all()
    .filter((l) => inScope(l.holder))
    .map((l) => ({
      id: l.id,
      holder: l.holder,
      kind: l.kind,
      key: l.key,
      ...(l.waitingOn === undefined ? {} : { waitingOn: l.waitingOn }),
      ...(l.originNode === undefined ? {} : { originNode: l.originNode }),
    }));

  return { root, instances, templates, messages, records, objects, locks };
}
