/**
 * `snapshot → Scene` —— 纯函数，不碰 IO。
 *
 * 这是 RENDERING.md §4 那条"场景是纯函数"的落点。它能成立靠一个巧合般的合拍：
 * `activity` 和 `certainty` 都需要"最近一段历史"，而 head 里**恰好**保留着最近
 * 的已消费消息（`keepConsumedMessages`，默认 200，本来是为了限制头无界增长）。
 *
 * 于是**染色窗口就是那 200 条**，前端一条历史都不用自己存。拿到三条硬性质：
 * 两个渲染器必然一致、刷新可重放、多观察者同图。
 *
 * ⚠️ 计数走**消息序号**不走对象版本 —— 对象是内容寻址去重的，两次内容相同的
 * 命中会被合并成一次。这个坑咬过三次（`loop` 的 `Date.now() % 1`、`collect`
 * 缺索引），所以这里从头到尾只数消息。
 */

import type { Cell, Card, Flow, Phase, Scene, Tether, Anchor } from "./scene.js";
import type { Snapshot, SnapshotMessage } from "./snapshot.js";

/** 节点在场景里的 id：实例路径 + `#` + 节点名。 */
export function nodeCellId(traceid: string, nodeId: string): string {
  return `${traceid}#${nodeId}`;
}

function depthOf(traceid: string): number {
  return traceid.split("/").length - 1;
}

function parentTrace(traceid: string): string | null {
  const cut = traceid.lastIndexOf("/");
  return cut === -1 ? null : traceid.slice(0, cut);
}

/**
 * 命中计数 —— 只看**最近 N 条**消息。
 *
 * 用序号窗口而不是墙钟，因为内核没有时钟（L0）。`msg-N` 单调，
 * 窗口是"最近 N 条里出现了几次"，纯序号、可重放、多观察者一致。
 */
const WINDOW = 200;

function recentMessages(messages: readonly SnapshotMessage[]): readonly SnapshotMessage[] {
  return messages.slice(-WINDOW);
}

/** 命中次数 → 确定度。前几次涨得快，之后趋近 1 —— "多染色后逐渐固定"。 */
function certaintyFromHits(hits: number): number {
  if (hits <= 0) return 0;
  return 1 - Math.pow(0.6, hits);
}

function phaseOf(
  traceid: string,
  nodeId: string,
  snapshot: Snapshot,
): Phase {
  const record = snapshot.records.find((r) => r.traceid === traceid && r.nodeId === nodeId);
  if (record === undefined) return "idle";
  if (record.status === "RUNNING") return "running";
  if (record.status === "VOIDED") return "voided";
  return record.termination === "DONE" ? "done" : "failed";
}

export function buildScene(snapshot: Snapshot, viewport?: string): Scene {
  const scope = viewport ?? snapshot.root ?? "";
  const recent = recentMessages(snapshot.messages);

  // ── 流量：按落点与来源分别计数（都只数消息，见文件头） ──
  const inbound = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
  for (const msg of recent) {
    bump(inbound, nodeCellId(msg.target.traceid, msg.target.node));
    if (msg.source !== undefined && msg.source.node !== undefined) {
      bump(inbound, nodeCellId(msg.source.traceid, msg.source.node));
    }
  }
  const busiest = Math.max(1, ...inbound.values());
  const activityOf = (id: string): number => (inbound.get(id) ?? 0) / busiest;

  const cells: Cell[] = [];
  const tethers: Tether[] = [];
  const flows: Flow[] = [];

  const inScope = (traceid: string): boolean =>
    scope === "" || traceid === scope || traceid.startsWith(`${scope}/`);

  for (const instance of Object.values(snapshot.instances)) {
    if (!inScope(instance.traceid)) continue;
    const template = snapshot.templates[instance.templateRef];
    const nodeIds = Object.keys(instance.nodes);

    // ── 实例本身是一个 Cell（容器即实例：不是两种元素） ──
    cells.push({
      id: instance.traceid,
      kind: "instance",
      parent: parentTrace(instance.traceid),
      depth: depthOf(instance.traceid),
      label: instance.traceid.split("/").pop() ?? instance.traceid,
      identity: instance.templateRef,
      ports: [],
      phase: instance.status === "OPEN" ? "idle" : "done",
      activity: 0,
      extent: nodeIds.length,
      pinned: false,
    });

    const parent = parentTrace(instance.traceid);
    if (parent !== null && inScope(parent)) {
      tethers.push({ from: parent, to: instance.traceid, relation: "contains" });
    }

    // ── 节点也是 Cell，父是所在实例 ──
    for (const nodeId of nodeIds) {
      const decl = template?.nodes[nodeId];
      const ports: Anchor[] = Object.entries(decl?.ports ?? {}).map(([name, p]) => ({
        name,
        direction: p.direction,
        ...(p.contract === undefined ? {} : { contract: p.contract }),
      }));
      const id = nodeCellId(instance.traceid, nodeId);
      cells.push({
        id,
        kind: "node",
        parent: instance.traceid,
        depth: depthOf(instance.traceid) + 1,
        label: nodeId,
        // agent 节点与内置 handler 是不同的身份，所以颜色也该不同
        identity: decl?.agent !== undefined ? `agent:${decl.agent.argv[0]}` : `handler:${decl?.handler ?? "?"}`,
        ports,
        phase: phaseOf(instance.traceid, nodeId, snapshot),
        activity: activityOf(id),
        extent: ports.length,
        pinned: false,
      });
      tethers.push({ from: instance.traceid, to: id, relation: "contains" });
    }

    if (template === undefined) continue;

    // ── 内网边：certainty 恒 1，注册期就证实过 ──
    for (const [edgeId, edge] of Object.entries(template.edges)) {
      const from = nodeCellId(instance.traceid, edge.from.node);
      const to = nodeCellId(instance.traceid, edge.to.node);
      const contract = template.nodes[edge.to.node]?.ports[edge.to.port]?.contract;
      const hits = recent.filter(
        (m) =>
          m.target.traceid === instance.traceid &&
          m.target.node === edge.to.node &&
          m.target.port === edge.to.port &&
          m.source?.node === edge.from.node &&
          m.source.traceid === instance.traceid,
      ).length;
      flows.push({
        id: `${instance.traceid}:edge:${edgeId}`,
        from: { cell: from, port: edge.from.port },
        to: { cell: to, port: edge.to.port },
        certainty: 1,
        activity: hits / Math.max(1, recent.length),
        ...(contract === undefined ? {} : { contract }),
      });
    }

    /**
     * ── 隧道：一条订阅 × 每个实际来过的来源，各画一条 ──
     *
     * 这就是补 `Message.source` 换来的东西。没有它，同一条隧道的所有命中
     * 长得一模一样，只能在落点上堆一个数字；有了它，**每根来路各自染色**，
     * 浮动的节点因此被看见。
     *
     * 一次都没命中的订阅仍然出场（`from: null`）—— "声明了但从没人往这儿发"
     * 是很值钱的观察，不该因为没流量就消失。
     */
    for (const [subId, sub] of Object.entries(template.subscriptions)) {
      const hits = recent.filter(
        (m) =>
          m.tunnel === sub.tunnel &&
          m.target.traceid === instance.traceid &&
          m.target.node === sub.to.node,
      );
      const to = { cell: nodeCellId(instance.traceid, sub.to.node), port: sub.to.port };
      if (hits.length === 0) {
        flows.push({
          id: `${instance.traceid}:sub:${subId}`,
          from: null,
          to,
          certainty: 0,
          activity: 0,
          tunnel: sub.tunnel,
        });
        continue;
      }
      const bySource = new Map<string, number>();
      for (const m of hits) {
        if (m.source === undefined || m.source.node === undefined) continue;
        const key = `${nodeCellId(m.source.traceid, m.source.node)}|${m.source.port ?? ""}`;
        bump(bySource, key);
      }
      for (const [key, count] of bySource) {
        const [cell, port] = key.split("|") as [string, string];
        flows.push({
          id: `${instance.traceid}:sub:${subId}:${cell}`,
          from: { cell, port },
          to,
          certainty: certaintyFromHits(count),
          activity: count / Math.max(1, recent.length),
          tunnel: sub.tunnel,
        });
      }
    }
  }

  /**
   * ── 卡：对象归属于写它的那个实例（命名空间就是 traceid 前缀） ──
   *
   * 两条过滤，都是实测出来的：
   *
   * 1. **每个对象只出一张卡，取最新版。** 对象库存的是全部版本（C5：版本历史
   *    即状态），照单全收的话一个写了四次的对象会变成四张卡 —— 实测 3 次
   *    emit 出了 11 张卡，一眼就知道不对。版本数放在卡上当角标。
   * 2. **`$` 开头的是内核内务**（`$run` / `$exec`），不上画布。执行记录该表现为
   *    节点的 `phase`，不该在旁边再摆一张卡说同一件事。
   */
  const latest = new Map<string, { kind: string; version: number }>();
  for (const obj of snapshot.objects) {
    const seen = latest.get(obj.object_id);
    if (seen === undefined || obj.version > seen.version) {
      latest.set(obj.object_id, { kind: obj.kind, version: obj.version });
    }
  }

  const cards: Card[] = [];
  for (const [objectId, { kind, version }] of latest) {
    const cut = objectId.lastIndexOf("/");
    if (cut === -1) continue; // 模板等全局对象不上画布
    const label = objectId.slice(cut + 1);
    if (label.startsWith("$")) continue; // 内核内务
    const owner = objectId.slice(0, cut);
    if (!inScope(owner)) continue;
    cards.push({ id: objectId, label, kind, owner, version });
    tethers.push({ from: owner, to: objectId, relation: "refs" });
  }

  return { cells, cards, flows, tethers, viewport: scope };
}
