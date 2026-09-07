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

import type { Principal } from "@nodeflow/contracts";
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
 *
 * ## 走 ControlPlane，不绕过它
 *
 * 此前这个函数**不收 actor，一次授权检查都不做**，直接读 `runtime.*` /
 * `registry.*` / `store.*`。而 CLI 里其他所有读命令走的都是
 * `control.xxx(actor, …)`。于是它一旦有出口，就会成为全仓**权限最高、
 * 检查最少**的那条读路径 —— 而它返回的比任何一个已授权查询都多。
 *
 * 现在两处授权，各自对得上被读的东西：
 *
 *   `control.subtree(actor, scope ?? root)`   run 侧的一切（实例 / 消息 / 记录 /
 *                                             对象 / 义务）都在这个前缀内，
 *                                             一次判定覆盖，也只留一条审计
 *   `control.read(actor, templateRef)`        模板不在那个前缀里（`root@1`），
 *                                             按对象身份单独判
 *
 * ## 不再导出授权日志
 *
 * 原来有个 `audit` 字段。它**零消费者** —— `@nodeflow/scene` 的 schema 根本
 * 不收它；而它偏偏是最敏感的那份（"谁被拒了"），注释里还写着**不按 scope 过滤**。
 * 既是化石又是泄漏点。要看审计有 `authz.jsonl`，那是它该在的地方（§17.6）。
 */
export function exportSnapshot(state: RunState, actor: Principal, scope?: string): RunSnapshot {
  const runtime = state.runtime;
  const root = state.registry.rootTrace;
  const viewport = scope ?? root;
  const inScope = (traceid: string): boolean =>
    viewport === null || traceid === viewport || traceid.startsWith(`${viewport}/`);

  const instances: Record<string, unknown> = {};
  const templates: Record<string, unknown> = {};
  // ★ 唯一一次 run 侧授权 —— 之后读到的东西都在这个前缀内
  const roots = viewport === null ? [] : state.control.subtree(actor, viewport);
  for (const instance of roots) {
    instances[instance.traceid] = {
      traceid: instance.traceid,
      templateRef: instance.templateRef,
      status: instance.status,
      ...(instance.slot === undefined ? {} : { slot: instance.slot }),
      /**
       * 物化的别名绑定 —— 画布读它才知道"声明过的去向"。
       *
       * 此前这个信息在模板的订阅块里，而那块**答不出"这一条会投到哪儿"**
       * （要扫全树匹配）。物化绑定是自足的：实例自己就带着完整寻址表。
       */
      bindings: instance.bindings.map((b) => ({ ...b })),
    };
    if (templates[instance.templateRef] === undefined) {
      /**
       * 模板**跟着实例走**，不单独授权。
       *
       * 我先写成 `control.read(actor, templateRef)`，深度用例当场抓到：
       * templateRef 是 `mid@1`，授权目标会被算成 `mid` —— 而模板住在
       * **traceid 树之外的扁平命名空间**。结果是一个被授权看自己子树的主体
       * 拿不到画它所必需的定义：`拒绝：无权对 \`mid\` 执行 DQL`。
       *
       * 授权单位是**实例子树**（上面那次 `control.subtree` 已经判过）。
       * 能看见实例，就该看得见它 pin 的那份定义 —— C4 说实例就是由这份定义
       * 构成的，给你实例却不给定义，等于给一张读不懂的图。而且能看见实例
       * 就已经能看见它的节点、端口与消息，模板本身并不多泄露什么。
       */
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
      ...(m.alias === undefined ? {} : { alias: m.alias }),
    }));

  /**
   * 进度按**执行**索引，不按实例取最新。
   *
   * 原来是 `store.head(`${r.traceid}/$exec`)` —— 一个实例只取最新那一版，
   * 于是同实例的所有执行记录都被投影成最新那次的进度：A 上报 1/10、
   * B 上报 9/10，`$exec` 历史各自都对，投出来两条都是 9/10。
   *
   * 这比"没有进度"更坏：它给的是一个看起来合理、实际张冠李戴的数字，
   * 而画布上没有任何东西提示它不可信。
   *
   * `$exec` 的正文里本来就带 `execution_id`（`#recordExecution` 写的），
   * 按它建索引即可 —— 不需要新字段，也不需要第二处记账。整棵子树扫一遍，
   * 不是每条记录各扫一遍。
   */
  const progressOf = new Map<string, unknown>();
  for (const instance of roots) {
    for (const version of state.store.history(`${instance.traceid}/$exec`)) {
      const body = version.body as {
        execution_id?: string;
        diagnostics?: { progress?: unknown };
      };
      const p = body.diagnostics?.progress;
      if (body.execution_id !== undefined && p !== undefined) {
        progressOf.set(body.execution_id, p);
      }
    }
  }

  const records = runtime
    .records()
    .filter((r) => inScope(r.traceid))
    .map((r) => {
      // agent 自报的语义进度 —— 推不出来的那一半，只能从执行观测里带出来。
      // 没有对应观测就**不带**，不拿别人的顶上。
      const progress = progressOf.get(r.executionId);
      return {
        traceid: r.traceid,
        nodeId: r.nodeId,
        status: r.status,
        ...(r.termination === undefined ? {} : { termination: r.termination }),
        ...(progress === undefined ? {} : { progress }),
      };
    });

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
