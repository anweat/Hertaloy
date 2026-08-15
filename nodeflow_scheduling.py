"""Nodeflow V4 —— 调度与执行

选取/claim 在锁内，执行在锁外；三段式 claim/execute/apply；
冲突域是 NodeInstance + 消费的消息集合，不是容器。

本文件由 `Runtime` 通过 mixin 组合；状态仍集中在 `Runtime` 实例上。
这是**模块级职责划分**，不是对象级解耦 —— 真正抽出独立对象留待具体实现阶段，
届时边界已由本文件画好。
"""

from __future__ import annotations

import threading
import time
from dataclasses import asdict
from typing import Any, Mapping

from nodeflow_core import (
    ExecutionRequest, ExecutionResult,
    InvariantError, InvocationContext, OutputContract, Provenance, _Message,
    _Record, _Unit, WorkspaceScope,
)


class SchedulingMixin:
    def step(self, *gids, max_commits: int = 1) -> int:
        done = 0
        while done < max_commits and self._dispatch_once(gids):
            done += 1
        return done

    def drain(self, *gids) -> None:
        guard = 0
        while self._dispatch_once(gids):
            guard += 1
            if guard > 10_000:
                raise InvariantError("drain did not converge")

    def _take_unit(self, gids) -> tuple[_Unit | None, bool]:
        """锁内原子地挑一份活并 claim 住。

        返回 (unit, still_busy)。unit 为 None 时，still_busy 表示别的线程
        还有在途执行 —— 此时不能判定已排空。
        """
        scope = set(gids) if gids else None
        with self._lock:
            for msg in list(self._messages.values()):
                if msg.state != "QUEUED":
                    continue
                gid, node_id, _ep = msg.target
                if scope is not None and gid not in scope:
                    continue
                inst = self._instances.get(gid)
                if inst is None or inst.status != "OPEN":
                    continue
                node = self._templates[inst.template_ref]["nodes"][node_id]
                kind = node["kind"]

                if kind == "strategy":
                    batch, discard, sel_ctx = self._select_for_strategy(
                        inst, node_id, node)
                    if batch is None:
                        continue                  # 未就绪，让给别的消息
                    for m in batch:
                        m.state = "CLAIMED"
                    for m in discard:
                        m.state = "CLAIMED"       # DISCARD 同批消费，不进 handler
                    ev = node.get("evaluator") or {}
                    if ev.get("kind") == "model":
                        # 模型驱动的判断也是一次执行，必须走三段式在锁外跑
                        eid = self._claim(inst, node_id, node, batch,
                                          spec_id=ev["spec"])
                        unit = _Unit("model_strategy", inst, node_id, node,
                                     batch=batch, execution_id=eid,
                                     discard=tuple(discard),
                                     selection_ctx=sel_ctx)
                    else:
                        unit = _Unit("strategy", inst, node_id, node, batch=batch,
                                     discard=tuple(discard),
                                     selection_ctx=sel_ctx)
                elif kind == "agent":
                    eid = self._claim(inst, node_id, node, [msg])
                    unit = _Unit("agent", inst, node_id, node, msg=msg,
                                 execution_id=eid)
                else:
                    msg.state = "CLAIMED"
                    unit = _Unit("simple", inst, node_id, node, msg=msg)

                self._inflight += 1
                return unit, True
            return None, self._inflight > 0

    def _run_unit(self, unit: _Unit) -> None:
        """agent 的执行在**锁外**——这是并行的全部意义。"""
        try:
            if unit.kind == "agent":
                rec = self._records[unit.execution_id]
                result = self._execute_with_retry(rec)          # 锁外，可能数分钟
                with self._lock:
                    if result.termination == "CANCELLED":
                        self._release(unit.execution_id, "CANCELLED")
                    elif result.termination in ("FAILED", "INVALID_OUTPUT", "BUDGET"):
                        self._release(unit.execution_id, "FAILED",
                                      reason=result.termination)
                    else:
                        inst = self._instances[rec.gid]
                        st = inst.nodes[rec.node_id]
                        if st.version != rec.base_node_version:
                            # 乐观并发冲突：他人先提交，本执行作废；
                            # 输入退回 QUEUED，由调度器重新认领重试。
                            self._release(unit.execution_id, "FAILED",
                                          reason="FAILED")
                            return
                        try:
                            self.apply_execution(unit.execution_id, result)
                        except InvariantError:
                            # 提交被拒（非法端口/契约失败）：
                            # 终态 FAILED 并经 on_error 进图，不崩溃不滞留。
                            self._release(unit.execution_id, "FAILED",
                                          reason="APPLY_REJECTED")
            elif unit.kind == "model_strategy":
                rec = self._records[unit.execution_id]
                result = self._execute_with_retry(rec)          # 锁外
                with self._lock:
                    if result.termination != "DONE":
                        self._release(
                            unit.execution_id,
                            "CANCELLED" if result.termination == "CANCELLED" else "FAILED",
                            reason=result.termination)
                    else:
                        try:
                            rec.status = "APPLIED"
                            # 模型的输出提案 → decision.emit，其余一律不接受。
                            # 计量与观测必须随本次策略提交进入 RunSnapshot：
                            # 否则 usage/compactions 告警对模型 evaluator 失效。
                            self._handle_strategy(
                                unit.inst, unit.node_id, unit.node, unit.batch,
                                decision={"emit": {p: pl for p, pl in result.emissions}},
                                trusted=False,
                                discard=unit.discard,
                                selection_ctx=unit.selection_ctx,
                                execution_meta={
                                    "execution": unit.execution_id,
                                    "usage": asdict(result.usage),
                                    "observations": list(result.observations),
                                    "context_trims": list(rec.context_trims),
                                    "context": {
                                        "head": list(rec.request.context.head),
                                        "messages": list(rec.request.context.messages),
                                        "tail": list(rec.request.context.tail),
                                    },
                                },
                            )
                        except InvariantError:
                            self._release(unit.execution_id, "FAILED",
                                          reason="APPLY_REJECTED")
            elif unit.kind == "strategy":
                with self._lock:
                    self._handle_strategy(unit.inst, unit.node_id, unit.node,
                                          unit.batch,
                                          discard=unit.discard,
                                          selection_ctx=unit.selection_ctx)
            else:
                with self._lock:
                    self._handle(unit.msg)
        finally:
            with self._lock:
                self._inflight -= 1

    def _dispatch_once(self, gids) -> bool:
        unit, _busy = self._take_unit(gids)
        if unit is None:
            return False
        self._run_unit(unit)
        return True

    def drain_concurrent(self, *gids, workers: int = 4, poll: float = 0.005,
                         timeout: float = 120.0) -> None:
        """多线程排空。claim / apply 在锁内串行，agent 执行在锁外并行。

        冲突域是 NodeInstance + 消费的消息集合（不是容器），因此不同节点
        可以真正并发提交。
        """
        errors: list[BaseException] = []
        deadline = time.monotonic() + timeout

        def worker() -> None:
            while not errors:
                if time.monotonic() > deadline:
                    errors.append(InvariantError("drain_concurrent 超时"))
                    return
                unit, busy = self._take_unit(gids)
                if unit is None:
                    if not busy:
                        return                    # 无活且无在途 → 收工
                    time.sleep(poll)
                    continue
                try:
                    self._run_unit(unit)
                except BaseException as exc:       # noqa: BLE001
                    errors.append(exc)
                    return

        threads = [threading.Thread(target=worker, daemon=True, name=f"nf-{i}")
                   for i in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=timeout)
        if errors:
            raise errors[0]

    def _select_for_strategy(self, inst, node_id, node):
        """按 policy 的 readiness + selection 原子选取消息。

        返回 (batch, discard, selection_ctx)。
          batch      进入 handler 的消息（payloads 由此构造）
          discard    TOP_ONE unselected=DISCARD 时同批消费、不进 handler 的消息
          ctx        CROSS_ALL 等选择期上下文（crossPairs 等）
        """
        policy = self._policies[node["policy"]]
        by_ep: dict[str, list[_Message]] = {}
        for m in self._messages.values():
            if m.state == "QUEUED" and m.target[0] == inst.gid and m.target[1] == node_id:
                by_ep.setdefault(m.target[2], []).append(m)
        if not by_ep:
            return None, [], {}
        readiness = policy.get("readiness", "ANY")
        if readiness == "ALL_REQUIRED":
            required = policy["required_inputs"]
            if not all(by_ep.get(ep) for ep in required):
                return None, [], {}
        # 兼容 V4 既有模板：ALL_REQUIRED 未声明 selection 时默认 ONE_PER_INPUT
        # （即 B5/R9 的"每个必需端点各取一条"），ANY 默认 FIRST。
        selection = policy.get("selection") or (
            "ONE_PER_INPUT" if readiness == "ALL_REQUIRED" else "FIRST")
        ctx: dict[str, Any] = {"selection": selection}
        discard: list[_Message] = []

        if selection == "FIRST":
            batch = [next(iter(by_ep.values()))[0]]
        elif selection == "TOP_ONE":
            candidates = [m for msgs in by_ep.values() for m in msgs]
            rank_field = policy.get("rankField", "rank")
            try:
                selected = max(candidates,
                               key=lambda m: m.payload[rank_field])
            except (KeyError, TypeError) as exc:
                raise InvariantError(
                    f"TOP_ONE 按 {rank_field!r} 排序失败：{exc}；"
                    f"请检查 policy.rankField 与消息 payload")
            batch = [selected]
            if policy.get("unselected", "RETAIN") == "DISCARD":
                discard = [m for m in candidates if m is not selected]
        elif selection == "ONE_PER_INPUT":
            required = policy["required_inputs"]
            batch = [by_ep[ep][0] for ep in required]
        elif selection == "CROSS_ALL":
            required = policy["required_inputs"]
            if len(required) != 2:
                raise InvariantError(
                    f"CROSS_ALL 当前要求恰好两个 required_inputs，得到 {required}")
            left = by_ep[required[0]]
            right = by_ep[required[1]]
            batch = list(left) + list(right)
            ctx["crossPairs"] = [
                (l.payload, r.payload) for l in left for r in right
            ]
        else:
            raise InvariantError(f"unsupported strategy selection: {selection}")
        return batch, discard, ctx

    DECISION_KEYS = frozenset({"emit", "items", "annotate"})

    MODEL_DECISION_KEYS = frozenset({"emit"})

    def _guard_decision(self, node, policy, decision, *, trusted: bool,
                        extra_ports=()):
        """校验 evaluator 的返回，拒绝一切未声明的东西。

        受信 handler（我们自己写的 Python）可返回三种键；
        **模型驱动的 evaluator 只能返回 `emit`** —— `items` 会实例化子容器、
        `annotate` 会写版本锚点，都不是"从已声明选项中选择"。
        """
        allowed_keys = self.DECISION_KEYS if trusted else self.MODEL_DECISION_KEYS
        if not isinstance(decision, Mapping):
            raise InvariantError(f"evaluator 必须返回映射，得到 {type(decision).__name__}")
        unknown = set(decision) - allowed_keys
        if unknown:
            raise InvariantError(
                f"evaluator 返回了不允许的字段：{sorted(unknown)}；"
                f"允许：{sorted(allowed_keys)}"
                + ("" if trusted else "（模型驱动的 evaluator 只能选择端口，不能构造）")
            )

        declared = set(node.get("endpoints", {})) | set(extra_ports)
        emit = decision.get("emit") or {}
        if not isinstance(emit, Mapping):
            raise InvariantError("decision.emit 必须是 {port: payload}")
        bad = set(emit) - declared
        if bad:
            raise InvariantError(
                f"evaluator 选择了未声明的端口：{sorted(bad)}；可用：{sorted(declared)}"
            )

        items = decision.get("items") or []
        if items:
            out_policy = policy.get("output", {})
            if out_policy.get("mode") != "FANOUT_TO_SLOT":
                raise InvariantError("policy 未声明 FANOUT_TO_SLOT，不得返回 items")
            if not isinstance(items, (list, tuple)):
                raise InvariantError("decision.items 必须是列表")
            cap = out_policy.get("max_items", self.default_max_fanout)
            if len(items) > cap:
                raise InvariantError(f"fan-out 数量 {len(items)} 超过上限 {cap}")

        ann = decision.get("annotate")
        if ann is not None:
            if not isinstance(ann, Mapping):
                raise InvariantError("decision.annotate 必须是映射")
            unknown = set(ann) - {"object_refs", "fields"}
            if unknown:
                raise InvariantError(f"annotate 含未声明字段：{sorted(unknown)}")
            for name, ref in (ann.get("object_refs") or {}).items():
                oid, _, ver = str(ref).rpartition("@")
                if not oid or not ver.isdigit():
                    raise InvariantError(
                        f"annotate.object_refs[{name!r}] = {ref!r} 不是精确版本引用"
                        f"（不变量 V4，形如 plan@2）"
                    )
        return decision

    def _handle_strategy(self, inst, node_id, node, batch, *,
                         decision=None, trusted=True, discard=(),
                         selection_ctx=None, execution_meta=None) -> None:
        tpl = self._templates[inst.template_ref]
        for m in batch:
            m.state = "CLAIMED"
        for m in discard:
            m.state = "CLAIMED"
        policy = self._policies[node["policy"]]
        readiness = policy.get("readiness", "ANY")
        selection = policy.get("selection") or (
            "ONE_PER_INPUT" if readiness == "ALL_REQUIRED" else "FIRST")
        if selection == "CROSS_ALL":
            # CROSS_ALL：handler 收到每个端点的**全量列表**，配 crossPairs。
            payloads: dict[str, Any] = {}
            for m in batch:
                payloads.setdefault(m.target[2], []).append(m.payload)
        else:
            # FIRST / TOP_ONE / ONE_PER_INPUT：每个端点恰好一条，给单值。
            payloads = {m.target[2]: m.payload for m in batch}
        ctx = self._node_ctx(inst, node_id)
        ctx["selection"] = selection
        if selection_ctx and "crossPairs" in selection_ctx:
            ctx["crossPairs"] = selection_ctx["crossPairs"]

        if decision is None:
            evaluator = self._handlers.get(node.get("handler"))
            decision = (evaluator(payloads, ctx) if evaluator else {}) or {}

        out_policy = policy.get("output", {})
        out_mode = out_policy.get("mode")
        if out_mode == "CROSS":
            # CROSS 的 left/right 是**候选集合**，不是路由端口：只允许
            # 受信 handler 经它们提交候选，target 才必须是声明端口。
            decision = self._guard_decision(
                node, policy, decision, trusted=trusted,
                extra_ports={out_policy.get("left"), out_policy.get("right")})
        else:
            decision = self._guard_decision(node, policy, decision, trusted=trusted)
        emit = dict(decision.get("emit") or {})
        out_mode = out_policy.get("mode")
        staged_ids: list[str] = []
        if out_mode == "WAIT_ALL":
            emit, staged_ids = self._stage_strategy_outputs(
                inst, node_id, out_policy, emit, batch)
        elif out_mode == "CROSS":
            emit = self._cross_strategy_outputs(out_policy, emit)
        # 默认 / EMIT_EACH / FANOUT_TO_SLOT：emit 原样路由。

        spawned: list[str] = []
        # 先把全部端口 prepare 完（纯函数，可能抛）—— 校验失败时
        # 子容器还没实例化，扇出与路由一起保持原子。
        # 列表 payload 按 V2 语义逐项扇出（CROSS/WAIT_ALL/CROSS_ALL 的结果列表）。
        prepared: list[tuple] = []
        for port, payload in emit.items():
            drafts = payload if isinstance(payload, (list, tuple)) else [payload]
            for draft in drafts:
                prepared += self._prepare_route(tpl, node_id, port, draft)

        if out_mode == "FANOUT_TO_SLOT":
            slot_id = out_policy["slot"]
            slot = tpl["slots"][slot_id]
            entry_node, entry_ep = slot["entry"].split(".")
            for item in decision.get("items", []):
                child = self._spawn_child(inst, slot_id, slot)
                spawned.append(child)
                self._new_message((child, entry_node, entry_ep), item)
        traversed: list[str] = self._materialize_route(inst, prepared)

        # 循环锚点 = Strategy 配置 + 一条 Annotation。
        # Annotation 就是 ObjectVersion(kind="annotation")，无独立类型。
        if "annotate" in decision:
            ann = decision["annotate"]
            refs = dict(ann.get("object_refs", {}))
            self._append_object(
                f"annotation/{inst.gid}",
                {"object_refs": refs, "fields": dict(ann.get("fields", {}))},
                kind="annotation",
                provenance=Provenance(
                    graph_instance_id=inst.gid,
                    node_id=node_id,
                    at_seq=inst.seq + 1,
                    derived_from=tuple(refs.values()),
                ),
            )

        for m in batch:
            m.state = "CONSUMED"
        for m in discard:
            m.state = "CONSUMED"
        inst.seq += 1
        snapshot = {
            "seq": inst.seq,
            "node": node_id,
            "endpoint": ",".join(sorted(payloads)),
            "message": ",".join(m.mid for m in batch),
            "discarded": ",".join(m.mid for m in discard),
            "staged_message_ids": staged_ids,
            "selection": selection,
            "topic": None,
            "edges_traversed": traversed,
            "spawned": spawned,
            "payload": payloads,
        }
        if execution_meta:
            # 模型 evaluator 也是一次执行：usage/observations/上下文裁剪
            # 必须进入 RunSnapshot，usage(gid) 与 context_alerts 才不漏计。
            snapshot.update(execution_meta)
        self._append_object(
            f"run/{inst.gid}",
            snapshot,
            provenance=Provenance(
                graph_instance_id=inst.gid, node_id=node_id, at_seq=inst.seq
            ),
        )

    def _stage_strategy_outputs(self, inst, node_id, out_policy, emit, batch):
        """WAIT_ALL：结果暂存于 Strategy 节点 state；全部具备后一起发射。"""
        required = out_policy.get("required_outputs") or []
        if not required:
            raise InvariantError("WAIT_ALL 需要 required_outputs")
        policy_state = inst.nodes[node_id].persistent.setdefault(
            "policy_state", {})
        staged = policy_state.setdefault("staged_outputs", {})
        staged_ids = policy_state.setdefault("staged_message_ids", [])
        for port, raw in emit.items():
            items = raw if isinstance(raw, (list, tuple)) else [raw]
            staged.setdefault(port, []).extend(items)
        for m in batch:
            if m.mid not in staged_ids:
                staged_ids.append(m.mid)
        if any(not staged.get(port) for port in required):
            return {}, list(staged_ids)
        ready = {port: list(staged[port]) for port in required}
        policy_state["staged_outputs"] = {}
        policy_state["staged_message_ids"] = []
        return ready, staged_ids

    def _cross_strategy_outputs(self, out_policy, emit) -> dict[str, Any]:
        """CROSS(left,right,target)：同一轮 handler 返回的两组候选做笛卡尔积。"""
        left_name = out_policy.get("left")
        right_name = out_policy.get("right")
        target_name = out_policy.get("target")
        if not (left_name and right_name and target_name):
            raise InvariantError("CROSS 需要 left/right/target")
        left_key = out_policy.get("leftKey", "left")
        right_key = out_policy.get("rightKey", "right")
        left_raw = emit.get(left_name)
        right_raw = emit.get(right_name)
        if left_raw is None or right_raw is None:
            raise InvariantError(
                f"CROSS 需要 handler 同时返回 {left_name!r} 与 {right_name!r}")
        left_items = left_raw if isinstance(left_raw, (list, tuple)) else [left_raw]
        right_items = right_raw if isinstance(right_raw, (list, tuple)) else [right_raw]
        out = dict(emit)
        out.pop(left_name, None)
        out.pop(right_name, None)
        out[target_name] = [
            {left_key: l, right_key: r}
            for l in left_items for r in right_items
        ]
        return out

    def _handle_subflow(self, inst, tpl, node_id, node, msg) -> dict[str, Any]:
        """调用式复用：引用节点在父图里是普通节点，内部实例化/投递/等待。

        不是第三种传递机制 —— 出入都走边，只是节点实现里跨了实例。
        """
        if msg.mkind == "REPLY":
            return {node.get("return_port", "out"): msg.payload}

        slot_id = node["slot"]
        slot = tpl["slots"][slot_id]
        child = self._spawn_child(inst, slot_id, slot)
        if self._instances[child].status != "OPEN":
            msg.state = "QUEUED"          # 输入恢复，不制造永远等待的子调用
            raise InvariantError(f"bound child {child} is not OPEN")
        entry_node, entry_ep = slot["entry"].split(".")
        exit_decl = slot.get("exit") or {}
        exit_port = (exit_decl.get("endpoint", "").split(".")[-1]
                     or None) if exit_decl else None
        self._new_message(
            (child, entry_node, entry_ep),
            msg.payload,
            callback=(inst.gid, node_id, msg.target[2]),
            exit_port=exit_port,
        )
        return {}

    def _spawn_child(self, inst, slot_id, slot) -> str:
        if inst.status != "OPEN":
            raise InvariantError(f"{inst.gid} 已 {inst.status}，不得创建新子实例")
        mode = slot.get("instantiation", "PER_CALL")
        bucket = inst.children.setdefault(slot_id, [])
        if mode == "SINGLETON" and bucket:
            return bucket[0]
        if mode.startswith("WARM_POOL"):
            cap = int(mode.split("(")[1].rstrip(")"))
            if len(bucket) >= cap:
                cursor = inst.pool_cursor.get(slot_id, 0)
                child = bucket[cursor % cap]
                if self._instance_busy(child):
                    # 池满且目标实例仍忙（上一次调用遗留 QUEUED/CLAIMED 消息）。
                    # 隔离优先：不复用、不混消息 —— 临时新建独立实例，
                    # 不复用状态与消息队列。池实例在空闲后仍会被轮转复用。
                    child = self.instantiate(
                        slot["template"], owner=f"service:{inst.gid}")
                    return child
                inst.pool_cursor[slot_id] = cursor + 1
                # 只复用执行资源，不复用状态：清空 persistentState（判据=暗示性）
                for st in self._instances[child].nodes.values():
                    st.persistent.clear()
                return child
        child = self.instantiate(slot["template"], owner=f"service:{inst.gid}")
        bucket.append(child)
        return child

    def _emit_reply(self, inst, gid, node_id, msg, payload, *, where) -> None:
        """回程 REPLY —— 终态气密（R13）：callback 目标已非 OPEN 时
        不得滞留死信；跳过并留下失败痕迹，因果可审计。"""
        cb_gid = msg.callback[0]
        cb_inst = self._instances.get(cb_gid)
        if cb_inst is None or cb_inst.status != "OPEN":
            inst.seq += 1
            self._append_object(
                f"run/{gid}",
                {"seq": inst.seq, "node": node_id, "endpoint": msg.target[2],
                 "dropped_reply": {"to": cb_gid, "reason": (
                     "unknown" if cb_inst is None else cb_inst.status)},
                 "payload": payload},
                provenance=Provenance(graph_instance_id=gid, node_id=node_id,
                                      at_seq=inst.seq),
            )
            return
        self._new_message(msg.callback, payload, mkind="REPLY")

    def _handle(self, msg: _Message) -> None:
        gid, node_id, ep = msg.target
        inst = self._instances[gid]
        tpl = self._templates[inst.template_ref]
        node = tpl["nodes"][node_id]
        kind = node["kind"]
        if kind == "approval":
            # 停在此处等待授权主体答复；不提交、不路由
            msg.state = "AWAITING"
            inst.nodes[node_id].persistent.setdefault("pending", []).append(msg.mid)
            return
        msg.state = "CLAIMED"
        traversed: list[str] = []

        outputs: dict[str, Any] = {}
        if kind == "start":
            outputs = {node.get("emit", "io"): msg.payload}
        elif kind == "plain":
            fn = self._handlers[node["handler"]]
            outputs = fn(msg.payload, self._node_ctx(inst, node_id)) or {}
        elif kind == "subflow":
            outputs = self._handle_subflow(inst, tpl, node_id, node, msg)
        elif kind == "end":
            # V4 定案：end 是终态汇点 —— 消费到达的数据消息、记录一次终态提交。
            # 关闭与 DRAIN 不在内核：instance 关闭只能由控制面 control(close)
            # 授权执行（G3），用户在关闭前自行编排排空（close 实验1）。
            outputs = {}
        else:
            raise NotImplementedError(f"node kind not implemented yet: {kind}")

        # 回程端口由 slot.exit 声明（#9）；未声明时退回 "reply" 兼容默认
        back = msg.exit_port or "reply"
        if back in outputs and msg.callback is not None:
            self._emit_reply(inst, gid, node_id, msg,
                             outputs.pop(back), where=f"{gid}/{node_id}")

        traversed += self._route_all(inst, tpl, node_id, outputs)

        msg.state = "CONSUMED"
        inst.seq += 1
        self._append_object(
            f"run/{gid}",
            {
                "seq": inst.seq,
                "node": node_id,
                "endpoint": ep,
                "message": msg.mid,
                "topic": msg.topic,
                "edges_traversed": traversed,
                "payload": msg.payload,
            },
            provenance=Provenance(
                graph_instance_id=gid, node_id=node_id, at_seq=inst.seq
            ),
        )

    def _validate_payload(self, ref, payload, *, where) -> None:
        """只接受或拒绝，绝不暗中补字段（V3 那条老规矩）。"""
        schema = self._contract(ref)
        if schema is None:
            return
        if schema.get("type") == "object":
            if not isinstance(payload, Mapping):
                raise InvariantError(
                    f"{where}：{ref} 要求对象，得到 {type(payload).__name__}")
            missing = [k for k in schema.get("required", []) if k not in payload]
            if missing:
                raise InvariantError(f"{where}：{ref} 缺少必需字段 {missing}")
            if schema.get("additionalProperties") is False:
                extra = sorted(set(payload) - set(schema.get("properties", {})))
                if extra:
                    raise InvariantError(f"{where}：{ref} 不允许字段 {extra}")
            # 取值维度（R10）：enum / const / pattern —— 只接受或拒绝
            for k, ps in (schema.get("properties") or {}).items():
                if k in payload and isinstance(ps, Mapping):
                    self._check_value(ps, payload[k], where=f"{where}.{k}")

    def _prepare_route(self, tpl, node_id, port, payload) -> list[tuple]:
        """路由第一段 —— 纯函数，零副作用。

        对全部匹配边完成地址解析、源契约校验、Servo、目标契约校验，
        只收集结果，不产生任何消息。任一边失败 → 抛出，调用方尚未
        物化任何东西，可以安全地把失败送进图。
        """
        src = f"{node_id}.{port}"
        nodes = tpl.get("nodes", {})
        prepared: list[tuple[str, str, str, Any]] = []      # (eid, tgt_node, tgt_ep, out)
        for edge in tpl.get("edges", []):
            if edge["from"] != src:
                continue
            eid = edge.get("id", edge["from"] + "->" + edge["to"])
            op = edge.get("operation", "PUSH")
            tgt_node, tgt_ep = edge["to"].split(".", 1)

            src_ref = self._endpoint_ref(nodes.get(node_id, {}), port, "emit", op)
            tgt_ref = self._endpoint_ref(nodes.get(tgt_node, {}), tgt_ep, "receive", op)

            out = dict(payload) if isinstance(payload, Mapping) else payload
            self._validate_payload(src_ref, out, where=f"边 {eid} 源端")
            if edge.get("servo"):
                out = self._apply_servo(edge["servo"], out)
            self._validate_payload(tgt_ref, out, where=f"边 {eid} 目标端（Servo 之后）")
            prepared.append((eid, tgt_node, tgt_ep, out))
        return prepared

    def _materialize_route(self, inst, prepared) -> list[str]:
        """路由第二段 —— 全部通过后统一创建消息。不做任何校验。"""
        traversed = []
        for eid, tgt_node, tgt_ep, out in prepared:
            self._new_message((inst.gid, tgt_node, tgt_ep), out)
            traversed.append(eid)
        return traversed

    def _route_all(self, inst, tpl, node_id, outputs) -> list[str]:
        """一次提交里的**全部端口**一起走两段式（边界 B5b）。

        原子边界是**这次提交**，不是单个端口 —— 一次执行可以同时
        emit 多个端口，若逐端口物化，第二个端口的契约失配会留下第一个
        端口已投递的消息：执行记录 FAILED，下游却已经跑起来了。
        因此先把所有端口都 prepare 完，再统一 materialize。
        """
        prepared: list[tuple] = []
        for port, payload in outputs.items():
            prepared += self._prepare_route(tpl, node_id, port, payload)
        return self._materialize_route(inst, prepared)

    def _route(self, inst, tpl, node_id, port, payload) -> list[str]:
        """单端口路由。多端口场景一律走 `_route_all`。"""
        return self._route_all(inst, tpl, node_id, {port: payload})

    _SERVO_OPS = {"set", "map", "drop"}

    def _apply_servo(self, transform_id, payload):
        t = self._transforms[transform_id]
        if t["role"] != "EDGE_SERVO":
            raise InvariantError("only EDGE_SERVO may bind to an edge")
        illegal = set(t["body"]) - self._SERVO_OPS
        if illegal:
            raise InvariantError(
                f"Servo 只能改 payload，不得触碰路由/操作/契约/关联：{sorted(illegal)}"
            )
        out = dict(payload) if isinstance(payload, Mapping) else {"value": payload}
        for k, v in t["body"].get("set", {}).items():
            out[k] = v
        for src, dst in t["body"].get("map", {}).items():
            if src in out:
                out[dst] = out.pop(src)
        return out

    def _node_ctx(self, inst, node_id):
        return {
            "gid": inst.gid,
            "state": inst.nodes[node_id].persistent,
            "publish": lambda oid, body: self._append_object(oid, body),
        }

    def _claim(self, inst, node_id, node, msgs, *, spec_id=None) -> str:
        """commit A —— 锁定输入，写 RUNNING 记录，推进节点级版本。"""
        if self._backend is None:
            raise InvariantError("no execution backend configured")
        st = inst.nodes[node_id]
        # 休眠→唤醒时解析一次卡片版本，执行期间冻结
        resolved = dict(self._resolve_spec(spec_id or node["spec"]))
        # 卡片 + 输出契约 → system prompt 与工具全集（编译规则归内核）
        prompt, tools = self._compile_agent_prompt(resolved, node)
        resolved["systemPrompt"] = prompt
        resolved["tools"] = tools
        resolved["prefix_hash"] = self.prefix_fingerprint(resolved)
        ctx = InvocationContext(
            head=inst.head,
            messages=tuple(m.payload for m in msgs),
            tail=tuple(st.tail),
        )
        # 预算在调用**前**处理：超预算是编排面的事，不该丢给 harness 去压缩
        budget = (node.get("limits") or {}).get("token_budget")
        ctx, trims = self._fit_context(
            ctx, budget, gid=inst.gid, node_id=node_id,
            overhead=self.estimate_spec_tokens(resolved),
        )
        st.last_context, st.last_spec = ctx, resolved
        eid = self._nid("exec")
        # 工作区根：节点显式声明 > 实例 params.workspace_root > 当前目录。
        workspace_root = (
            node.get("workspace")
            or inst.params.get("workspace_root")
            or "."
        )
        req = ExecutionRequest(
            execution_id=eid,
            agent_spec=resolved,
            context=ctx,
            origin=(inst.gid, node_id),
            workspace=WorkspaceScope(root=str(workspace_root)),
            output_contract=OutputContract(
                schema=self._emit_schema_for(node),
                allowed_emit_ports=tuple(node.get("endpoints", {}))
            ),
            resume_handle=st.session_handle,
        )
        for m in msgs:
            m.state = "CLAIMED"
        st.version += 1
        inst.seq += 1
        self._records[eid] = _Record(
            execution_id=eid, gid=inst.gid, node_id=node_id, status="RUNNING",
            claimed=tuple(m.mid for m in msgs), request=req,
            base_node_version=st.version, context_trims=tuple(trims),
        )
        return eid

    def _execute_with_retry(self, rec) -> ExecutionResult:
        """execute —— 事务外。输出不合 schema 在执行面内重试，不上升为协议错误。"""
        result = None
        for _ in range(self.max_output_retries):
            result = self._backend.run(rec.request)
            if result.termination != "INVALID_OUTPUT":
                return result
        return result

    def apply_execution(self, execution_id, result: ExecutionResult) -> None:
        """commit B —— base 检查只针对被 claim 的切片（节点级，非容器级）。

        边界检查：
          - 终态气密（B2）：实例已非 OPEN 时拒绝提交在途执行 ——
            CLOSED 后不得再产生提交与路由；
          - 内核前缀保护（B3）：backend 只能提交用户 kind 的内容，
            run//annotation/ 前缀与内核 kind（run/annotation/context_summary）
            归内核独占，伪造即拒。
        """
        rec = self._records[execution_id]
        if rec.status != "RUNNING":
            raise InvariantError(f"execution is not RUNNING: {rec.status}")
        inst = self._instances[rec.gid]
        if inst.status != "OPEN":
            raise InvariantError(
                f"{rec.gid} 已 {inst.status}，拒绝提交在途执行（终态气密）")
        st = inst.nodes[rec.node_id]
        if st.version != rec.base_node_version:
            raise InvariantError("node-scoped base changed since claim")

        tpl = self._templates[inst.template_ref]
        node = tpl["nodes"][rec.node_id]
        allowed = rec.request.output_contract.allowed_emit_ports
        claimed = [self._messages[mid] for mid in rec.claimed]
        has_callback = any(m.callback for m in claimed)
        outputs: dict[str, Any] = {}
        for port, payload in result.emissions:
            if port not in allowed:
                # "reply" 是**回程通道**，不是可自由选择的端口：只有本次输入
                # 确实携带 callback 时才放行；否则与其它端口同规（须声明）。
                if not (port == "reply" and has_callback):
                    raise InvariantError(f"agent emitted undeclared port: {port}")
            outputs[port] = payload

        # ---- 校验段：全部纯函数，任一失败都不留副作用 --------------------
        # 顺序很关键：artifact 落库、REPLY 投递、边路由必须**同生共死**。
        # 逐项边做边校验会出现"执行记录 FAILED，下游却已跑起来"。
        reply: tuple | None = None
        if "reply" in outputs:
            cb = next((m.callback for m in claimed if m.callback), None)
            if cb is not None:
                # cb 为空时 "reply" 留在 outputs 里，按普通端口路由
                payload = outputs.pop("reply")
                cb_inst = self._instances.get(cb[0])
                if cb_inst is None or cb_inst.status != "OPEN":
                    # 终态气密（R13）：目标已关闭/不存在，不滞留死信
                    raise InvariantError(
                        f"REPLY 目标 {cb[0]} 已 {cb_inst.status if cb_inst else '不存在'}，"
                        f"拒绝提交回程消息")
                reply = (cb, payload)
        prepared: list[tuple] = []
        for port, payload in outputs.items():
            # 第一不变量的取值维度：即使该端口没有出边，emit 契约也必须在
            # apply 阶段校验（有边时 _prepare_route 会再验一遍目标端）。
            src_ref = self._endpoint_ref(node, port, "emit", "PUSH")
            self._validate_payload(src_ref, payload, where=f"端口 {port} 源端")
            prepared += self._prepare_route(tpl, rec.node_id, port, payload)
        for kind_, oid, body in result.artifacts:
            if kind_ in self.store.KERNEL_KINDS or                     oid.startswith("run/") or oid.startswith("annotation/"):
                raise InvariantError(
                    f"backend 不得提交内核保留对象：kind={kind_!r} oid={oid!r}；"
                    f"内核 kind 与 run//annotation/ 前缀归内核，"
                    f"用户 kind（plan/spec/…）自由")

        # ---- 物化段：从这里开始不再抛 -----------------------------------
        produced: list[str] = []
        for kind_, oid, body in result.artifacts:
            ov = self._append_object(
                oid, body, kind=kind_,
                provenance=Provenance(
                    graph_instance_id=rec.gid, node_id=rec.node_id,
                    execution_id=execution_id, at_seq=inst.seq + 1,
                    derived_from=rec.request.context.head,   # lineage 起点
                ),
            )
            produced.append(ov.ref)
        st.session_handle = result.session_handle      # 不透明，只存不解释
        if reply is not None:
            self._new_message(reply[0], reply[1], mkind="REPLY")
        traversed: list[str] = self._materialize_route(inst, prepared)

        for m in claimed:
            m.state = "CONSUMED"
        rec.status = "APPLIED"
        inst.seq += 1
        self._append_object(
            f"run/{rec.gid}",
            {
                "seq": inst.seq, "node": rec.node_id, "execution": execution_id,
                "endpoint": ",".join(sorted({m.target[2] for m in claimed})),
                "message": ",".join(rec.claimed),
                "topic": next((m.topic for m in claimed if m.topic), None),
                "edges_traversed": traversed, "usage": asdict(result.usage),
                "produced": produced,
                "context_trims": list(rec.context_trims),
                "observations": list(result.observations),
                "payload": rec.request.context.messages,
            },
            provenance=Provenance(
                graph_instance_id=rec.gid, node_id=rec.node_id,
                execution_id=execution_id, at_seq=inst.seq,
                derived_from=tuple(produced),
            ),
        )

    RETRYABLE = frozenset({"FAILED"})

    def _release(self, execution_id, status, *, reason=None) -> None:
        rec = self._records[execution_id]
        rec.status = status
        msgs = [self._messages[mid] for mid in rec.claimed]
        if status == "CANCELLED":
            for m in msgs:
                m.state = "QUEUED"          # 取消是意图，工作留着
            return

        inst = self._instances[rec.gid]
        node = self._templates[inst.template_ref]["nodes"][rec.node_id]
        cap = (node.get("limits") or {}).get("max_attempts", self.default_max_attempts)
        retryable = (reason or "FAILED") in self.RETRYABLE
        for m in msgs:
            m.attempts += 1

        if retryable and all(m.attempts < cap for m in msgs):
            for m in msgs:
                m.state = "QUEUED"          # 还能再试
            return

        for m in msgs:
            m.state = "FAILED"              # 终态，不再被调度
        self._raise_into_graph(inst, rec.node_id, node, msgs,
                               reason=reason or "FAILED", attempts=cap)

    def _raise_into_graph(self, inst, node_id, node, msgs, *, reason, attempts) -> None:
        """失败沿边进入图 —— 由策略节点决定怎么办，而不是静默消失。"""
        payload = {
            "error": reason,
            "node": node_id,
            "attempts": max((m.attempts for m in msgs), default=0),
            "messages": [m.mid for m in msgs],
        }
        err_port = node.get("on_error")
        tpl = self._templates[inst.template_ref]
        traversed = []
        if err_port:
            traversed = self._route(inst, tpl, node_id, err_port, payload)
        inst.seq += 1
        self._append_object(
            f"run/{inst.gid}",
            {"seq": inst.seq, "node": node_id, "endpoint": None,
             "failure": payload, "edges_traversed": traversed},
            provenance=Provenance(graph_instance_id=inst.gid, node_id=node_id,
                                  at_seq=inst.seq),
        )

    def begin_execution(self, gid, node_id):
        """显式 claim（供调度器与测试分步驱动）。返回 (execution_id, request)。"""
        with self._lock:
            inst = self._instances[gid]
            node = self._templates[inst.template_ref]["nodes"][node_id]
            pending = [
                m for m in self._messages.values()
                if m.state == "QUEUED" and m.target[0] == gid and m.target[1] == node_id
            ]
            if not pending:
                return None
            eid = self._claim(inst, node_id, node, pending[:1])
            return eid, self._records[eid].request

    def cancel_execution(self, execution_id) -> None:
        with self._lock:
            rec = self._records.get(execution_id)
            if rec is None or rec.status != "RUNNING":
                return
            if self._backend is not None:
                self._backend.cancel(execution_id)
            self._release(execution_id, "CANCELLED")

    def reclaim_stale_executions(self) -> list[str]:
        """崩溃接管：RUNNING 记录是唯一依据，输入退回 QUEUED 可被重新认领。"""
        with self._lock:
            stale = [r.execution_id for r in self._records.values()
                     if r.status == "RUNNING"]
            for eid in stale:
                self._release(eid, "FAILED", reason="FAILED")
            return stale
