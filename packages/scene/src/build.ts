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

/** 子槽在场景里的 id：实例路径 + `~` + 槽名。 */
export function slotCellId(traceid: string, slot: string): string {
  return `${traceid}~${slot}`;
}

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

/**
 * `msg-N` → N。序号是内核唯一的时间刻度（L0：没有墙钟）。
 *
 * 认不出格式就返回 0 —— 宁可把它排在最左，也不要因为一条怪 id 让整张图不画。
 */
function seqOf(messageId: string): number {
  const m = /(\d+)$/.exec(messageId);
  return m === null ? 0 : Number(m[1]);
}

/**
 * 每个 traceid / 节点被碰到的序号集合。
 *
 * "碰到"含**收和发**两侧：只看收的话，一个只往外发的节点会显得从没活过。
 */
function touchIndex(messages: readonly SnapshotMessage[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const add = (key: string, seq: number) => {
    const list = index.get(key);
    if (list === undefined) index.set(key, [seq]);
    else list.push(seq);
  };
  for (const msg of messages) {
    const seq = seqOf(msg.id);
    add(msg.target.traceid, seq);
    add(nodeCellId(msg.target.traceid, msg.target.node), seq);
    if (msg.source === undefined) continue;
    add(msg.source.traceid, seq);
    if (msg.source.node !== undefined) {
      add(nodeCellId(msg.source.traceid, msg.source.node), seq);
    }
  }
  return index;
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
  const touched = touchIndex(recent);
  const seqs = recent.map((m) => seqOf(m.id));
  const range = { from: Math.min(1, ...seqs), to: Math.max(1, ...seqs) };

  /** 生存期：碰到过的最早到最晚。还开着的实例右端为 null —— 带不收口。 */
  const spanOf = (key: string, alive: boolean) => {
    const marks = (touched.get(key) ?? []).slice().sort((a, b) => a - b);
    const from = marks.length === 0 ? range.from : (marks[0] as number);
    const to = alive ? null : marks.length === 0 ? range.to : (marks[marks.length - 1] as number);
    return { span: { from, to }, marks };
  };

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

    /**
     * ── 实例本身是一个 Cell（容器即实例） ──
     *
     * 父不是父实例，是**子槽**：模板上声明的那个位置。同一个槽能有 N 个活实例
     * （实测 job/a1 a2 a3 —— 扇出就长这样），所以画布上它们叠在那个位置上，
     * 而不是各自散开。根实例没有槽，父就是 null。
     */
    const live = spanOf(instance.traceid, instance.status === "OPEN");
    const holder =
      instance.slot === undefined ? null : slotCellId(parentTrace(instance.traceid) ?? "", instance.slot);
    cells.push({
      id: instance.traceid,
      kind: "instance",
      ...(instance.slot === undefined ? {} : { slot: instance.slot }),
      parent: holder,
      depth: depthOf(instance.traceid),
      label: instance.traceid.split("/").pop() ?? instance.traceid,
      identity: instance.templateRef,
      ports: [],
      span: live.span,
      marks: live.marks,
      // 覆盖率不是完成度 —— 有环的流程会反复碰同一批节点（见 Cell.progress）
      ...(nodeIds.length === 0
        ? {}
        : {
            progress: {
              done: nodeIds.filter((n) => (touched.get(nodeCellId(instance.traceid, n)) ?? []).length > 0)
                .length,
              total: nodeIds.length,
            },
          }),
      phase: instance.status === "OPEN" ? "idle" : "done",
      activity: 0,
      extent: nodeIds.length,
      pinned: false,
    });

    if (holder !== null) {
      tethers.push({ from: holder, to: instance.traceid, relation: "contains" });
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
      const own = spanOf(id, instance.status === "OPEN");
      cells.push({
        id,
        kind: "node",
        parent: instance.traceid,
        depth: depthOf(instance.traceid) + 1,
        label: nodeId,
        // agent 节点与内置 handler 是不同的身份，所以颜色也该不同
        identity: decl?.agent !== undefined ? `agent:${decl.agent.argv[0]}` : `handler:${decl?.handler ?? "?"}`,
        ports,
        // 生存期继承实例（节点与实例同生共死），刻点是自己身上发生的事
        span: live.span,
        marks: own.marks,
        /**
         * 节点的进度**只可能是上报的**。
         *
         * 结构性那一半（覆盖率）在节点这一层没有意义 —— 节点是最小单位，
         * 没有分母。所以这里要么有 agent 自报的，要么就没有，不编。
         */
        ...(() => {
          const p = snapshot.records.find(
            (r) => r.traceid === instance.traceid && r.nodeId === nodeId,
          )?.progress;
          return p === undefined ? {} : { progress: { done: p.done, total: p.total } };
        })(),
        phase: phaseOf(instance.traceid, nodeId, snapshot),
        activity: activityOf(id),
        extent: ports.length,
        pinned: false,
      });
      tethers.push({ from: instance.traceid, to: id, relation: "contains" });
    }

    if (template === undefined) continue;

    /**
     * ── 声明的子槽出场，**包括一次都没 spawn 过的** ──
     *
     * 定义面上"可实例化"的那个位置就是它。少了它，一个声明好却还没用过的
     * 子槽整个不可见 —— 与"从没命中过的订阅仍然要画"是同一条道理：
     * **声明本身是信息**，不该因为还没发生就消失。
     */
    for (const [slotId, slot] of Object.entries(template.children)) {
      const id = slotCellId(instance.traceid, slotId);
      const anchors: Anchor[] = [];
      if (slot.entry !== undefined) {
        anchors.push({ name: `${slot.entry.node}.${slot.entry.port}`, direction: "receive" });
      }
      if (slot.exit !== undefined) {
        anchors.push({ name: `${slot.exit.node}.${slot.exit.port}`, direction: "emit" });
      }
      cells.push({
        id,
        kind: "slot",
        parent: instance.traceid,
        depth: depthOf(instance.traceid) + 1,
        label: slotId,
        identity: slot.template,
        ports: anchors,
        span: live.span,
        marks: [],
        /**
         * 槽的进度 = 已终止 / 已创建。
         *
         * 分母是"已创建"而不是"总共会有几个" —— 后者内核不知道，随时还能再
         * spawn。说成已创建是**诚实的**：它答的是"派出去的这批干完没有"。
         */
        ...(() => {
          const kids = Object.values(snapshot.instances).filter(
            (i) => i.slot === slotId && parentTrace(i.traceid) === instance.traceid,
          );
          return kids.length === 0
            ? {}
            : { progress: { done: kids.filter((i) => i.status !== "OPEN").length, total: kids.length } };
        })(),
        phase: "idle",
        activity: 0,
        extent: 0,
        pinned: false,
      });
      tethers.push({ from: instance.traceid, to: id, relation: "contains" });
    }

    // ── 内网边：certainty 恒 1，注册期就证实过 ──
    for (const [edgeId, edge] of Object.entries(template.edges)) {
      const from = nodeCellId(instance.traceid, edge.from.node);
      const to = nodeCellId(instance.traceid, edge.to.node);
      const contract = template.nodes[edge.to.node]?.ports[edge.to.port]?.contract;
      const at = recent
        .filter(
          (m) =>
            m.target.traceid === instance.traceid &&
            m.target.node === edge.to.node &&
            m.target.port === edge.to.port &&
            m.source?.node === edge.from.node &&
            m.source.traceid === instance.traceid,
        )
        .map((m) => seqOf(m.id));
      flows.push({
        id: `${instance.traceid}:edge:${edgeId}`,
        from: { cell: from, port: edge.from.port },
        to: { cell: to, port: edge.to.port },
        certainty: 1,
        activity: at.length / Math.max(1, recent.length),
        at,
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
          at: [],
          tunnel: sub.tunnel,
        });
        continue;
      }
      const bySource = new Map<string, number[]>();
      for (const m of hits) {
        if (m.source === undefined || m.source.node === undefined) continue;
        const key = `${nodeCellId(m.source.traceid, m.source.node)}|${m.source.port ?? ""}`;
        const list = bySource.get(key);
        if (list === undefined) bySource.set(key, [seqOf(m.id)]);
        else list.push(seqOf(m.id));
      }
      for (const [key, at] of bySource) {
        const [cell, port] = key.split("|") as [string, string];
        flows.push({
          id: `${instance.traceid}:sub:${subId}:${cell}`,
          from: { cell, port },
          to,
          certainty: certaintyFromHits(at.length),
          activity: at.length / Math.max(1, recent.length),
          at,
          tunnel: sub.tunnel,
        });
      }
    }
  }

  /**
   * ── 等待：谁挡着谁 ──
   *
   * 锁账本里 `waitingOn` 一直都在，只是快照从没导出过它 —— 于是"容器间关系"
   * 里最要紧的那一半（父等子、请求方等服务方）渲染层根本看不见。
   * 这里不新造任何东西，只是把已有的读出来。
   */
  for (const lock of snapshot.locks) {
    if (lock.waitingOn === undefined) continue;
    if (!inScope(lock.holder) || !inScope(lock.waitingOn)) continue;
    tethers.push({
      from: lock.holder,
      to: lock.waitingOn,
      relation: "waits",
      because: lock.kind,
    });
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

  return { range, cells, cards, flows, tethers, viewport: scope };
}
