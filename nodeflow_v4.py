"""Nodeflow V4 —— Runtime

实例层、消息入口、控制面，以及四个 mixin 的组合。
对外 API 与拆分前完全一致：`from nodeflow_v4 import ...` 照常可用。

  nodeflow_core.py         协议数据类 / ObjectStore / Principal / 内部结构
  nodeflow_definitions.py  卡片、模板、契约、端点、连接期校验
  nodeflow_budget.py       上下文预算与降级
  nodeflow_scheduling.py   调度、执行三段式、失败进图
  nodeflow_projections.py  只读观察
"""

from __future__ import annotations

import copy
import itertools
import re
import threading
from typing import Any, Callable, Mapping

from nodeflow_core import *          # noqa: F401,F403  —— 向后兼容 re-export
from nodeflow_core import (          # 下划线名 import * 带不出来
    AuthorizationError, InvariantError, ObjectStore, ObjectVersion,
    Principal, Provenance, _Instance, _Message, _NodeState, _Record,
)
from nodeflow_definitions import DefinitionsMixin
from nodeflow_budget import ContextBudgetMixin
from nodeflow_scheduling import SchedulingMixin
from nodeflow_projections import ProjectionsMixin


class Runtime(DefinitionsMixin, ContextBudgetMixin, SchedulingMixin, ProjectionsMixin):
    def __init__(self) -> None:
        self._ids = itertools.count(1)
        self._cards: dict[tuple[str, str], dict[int, Mapping[str, Any]]] = {}
        self._card_tags: dict[str, set[tuple[str, str, int]]] = {}   # tag -> 卡版本集合
        self._characters: dict[str, dict[str, Any]] = {}
        self._specs: dict[str, dict[str, Any]] = {}
        self._templates: dict[str, Mapping[str, Any]] = {}
        self._layouts: dict[str, Any] = {}    # ref -> 画布 _layout（不进语义）
        self._topics: dict[str, Mapping[str, Any]] = {}
        self._transforms: dict[str, dict[str, Any]] = {}
        self._contracts: dict[str, Mapping[str, Any]] = {}
        self._policies: dict[str, Mapping[str, Any]] = {}
        self._handlers: dict[str, Callable[..., Any]] = {}
        self._instances: dict[str, _Instance] = {}
        self._messages: dict[str, _Message] = {}
        self._subs: dict[str, list[tuple[str, tuple[str, str, str]]]] = {}
        self.store = ObjectStore()          # 版本分配的唯一权威
        self._records: dict[str, _Record] = {}
        self._backend: ExecutionBackend | None = None
        #: 每次提交后回调 (runtime, run_snapshot)。持久化层挂这里。
        self.on_commit: Callable[[Runtime, ObjectVersion], None] | None = None
        self.max_output_retries = 3
        self.default_max_fanout = 32     # evaluator 未声明上限时的兜底
        self.default_max_attempts = 3    # 失败重试上限（#7）
        self._lock = threading.RLock()   # 保护全部可变运行状态
        self._inflight = 0               # 锁外执行中的活数
        # 系数由 test_context_budget.TestEstimatorCalibration 对着真实
        # usage.in_tokens 量出来，不是拍的。改之前先跑那两条。
        self.chars_per_token = 2.2        # 拉丁字符
        self.cjk_chars_per_token = 0.9    # CJK 密度高得多，分开算
        #: 超预算时的裁剪顺序。**head 不在其中，永不裁剪。**
        #: tail 先于 messages —— tail 是补充资料，messages 是任务本身。
        self.truncation_order = ("transient", "tail", "messages")
        #: 各段的保底条数。当前任务不可丢光，否则 agent 无事可做。
        self.min_keep = {"messages": 1}

    def _nid(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids):05d}"

    def _bump_id_counter(self) -> None:
        """从持久化恢复后调用：把计数器推过已用最大值，避免新 id 撞车。"""
        seen = 0
        keys = list(self._instances) + list(self._messages) + list(self._records)
        for entries in self._subs.values():
            keys += [sid for sid, _t in entries]
        for key in keys:
            tail = key.rsplit("-", 1)[-1]
            if tail.isdigit():
                seen = max(seen, int(tail))
        self._ids = itertools.count(seen + 1)

    def instantiate(self, template_ref, *, owner, params=None, controllers=()) -> str:
        with self._lock:
            return self._instantiate_locked(template_ref, owner, params, controllers)

    def _instantiate_locked(self, template_ref, owner, params, controllers) -> str:
        tpl = self._templates.get(template_ref)
        if tpl is None:
            raise InvariantError(
                f"未知模板：{template_ref}；模板必须先注册（register_graph_template）")
        gid = self._nid("gi")
        inst = _Instance(
            gid=gid,
            template_ref=template_ref,
            owner=owner,
            params=dict(params or {}),
            head=tuple((params or {}).get("context_head", ())),
            controllers={str(Principal.parse(owner)), "system:core",
                         *(str(Principal.parse(c)) for c in controllers)},
        )
        for node_id in tpl.get("nodes", {}):
            inst.nodes[node_id] = _NodeState()
        self._instances[gid] = inst
        # 模板级订阅声明在实例化时解析成具体订阅
        for sub in tpl.get("subscriptions", []):
            node_id, ep = sub["endpoint"].split(".")
            self.subscribe(sub["topic"], target=(gid, node_id, ep))
        # R0 物化写入初始提交记录（FOUNDATION §5.3）。
        # seq 仍为 0 —— 它计的是**创建之后**的状态转换次数。
        self._append_object(
            f"run/{gid}",
            {"seq": 0, "node": None, "materialized": template_ref,
             "owner": owner, "edges_traversed": [], "endpoint": None},
            provenance=Provenance(graph_instance_id=gid, at_seq=0),
        )
        return gid

    def subscribe(self, topic_id, *, target) -> str:
        with self._lock:
            if topic_id not in self._topics:
                raise InvariantError(f"unknown topic: {topic_id}")
            sid = self._nid("sub")
            self._subs.setdefault(topic_id, []).append((sid, target))
            return sid

    def unsubscribe(self, subscription_id) -> None:
        with self._lock:
            for topic, entries in self._subs.items():
                self._subs[topic] = [e for e in entries if e[0] != subscription_id]

    def set_backend(self, backend) -> None:
        self._backend = backend

    def send(self, target, payload) -> str:
        with self._lock:
            gid = target[0]
            inst = self._instances.get(gid)
            if inst is None:
                raise InvariantError(f"未知实例：{gid}")
            if inst.status != "OPEN":
                raise InvariantError(f"instance {gid} is not OPEN（{inst.status}）")
            return self._new_message(target, payload)

    def publish(self, topic_id, payload, *, sender=None, callback=None,
                request_id=None) -> str:
        with self._lock:
            if topic_id not in self._topics:
                raise InvariantError(f"unknown topic: {topic_id}")
            if isinstance(payload, Mapping) and "edgeId" in payload:
                raise InvariantError("消息不得指定下游边（不变量 M1）")
            # 主题 request contract 运行期校验（#13）：声明了就执行，
            # 只接受或拒绝，不暗中补字段。
            self._validate_payload_schema(
                self._topics[topic_id].get("request_contract"),
                payload, where=f"topic {topic_id} 请求")
            rid = request_id or self._nid("req")
            ids = []
            for _sid, target in self._subs.get(topic_id, []):
                gid = target[0]
                inst = self._instances.get(gid)
                if inst is None or inst.status == "CLOSED":
                    # CLOSED 是终态：投递只会制造永不到达的死信，
                    # 静默排队会让 queue 深度永远非零 —— 跳过。
                    # PAUSED 仍接收（恢复后会消费），仅 CLOSED 被过滤。
                    continue
                # 每个订阅者拿独立 payload 副本；同一请求共享 request_id
                ids.append(
                    self._new_message(target, dict(payload),
                                      callback=callback, topic=topic_id,
                                      request_id=rid)
                )
            return ids[0] if ids else ""

    def _new_message(self, target, payload, *, callback=None, topic=None,
                     mkind="DATA", exit_port=None, request_id=None) -> str:
        with self._lock:
            mid = self._nid("msg")
            # 入站快照：调用方事后修改原对象不得污染已入队的消息。
            self._messages[mid] = _Message(
                mid=mid, target=target, payload=copy.deepcopy(payload),
                callback=callback, topic=topic, mkind=mkind,
                exit_port=exit_port, request_id=request_id,
            )
            return mid

    def _instance_busy(self, gid: str) -> bool:
        """该实例是否仍有未完成的工作（QUEUED/CLAIMED/AWAITING 消息）。

        WARM_POOL 复用前的隔离检查：池实例忙时不复用，
        避免上一调用的遗留消息混入新调用（复用状态污染的来源）。
        """
        return any(
            m.target[0] == gid and m.state in ("QUEUED", "CLAIMED", "AWAITING")
            for m in self._messages.values()
        )

    def _check_value(self, ps: Mapping[str, Any], value: Any, *, where: str) -> None:
        """字段取值校验（enum/const/pattern）。"""
        if "enum" in ps and value not in ps["enum"]:
            raise InvariantError(
                f"{where}：值 {value!r} 不在枚举 {ps['enum']} 内")
        if "const" in ps and value != ps["const"]:
            raise InvariantError(f"{where}：值必须等于 {ps['const']!r}")
        if "pattern" in ps:
            if not re.search(str(ps["pattern"]), str(value)):
                raise InvariantError(
                    f"{where}：{value!r} 不匹配 pattern {ps['pattern']!r}")

    def append_context_tail(self, gid: str, node_id: str, ref: str) -> None:
        """运行期发现的卡片追加到该实例的 tail。不回写模板。"""
        with self._lock:
            self._instances[gid].nodes[node_id].tail.append(ref)

    def append_context_transient(self, gid: str, node_id: str, item) -> None:
        """本轮临时上下文：下一次 claim 时进入 transient，之后自动清空。"""
        with self._lock:
            self._instances[gid].nodes[node_id].transient.append(item)

    def collect_orphans(self, gid, *, slot_id=None, actor) -> list[str]:
        """回收 WARM_POOL 忙时扩容的 idle 孤儿实例。

        只回收当前不忙（无 QUEUED/CLAIMED/AWAITING）的实例；每个回收都是
        一次授权控制事实（CLOSED + RunSnapshot），不做旁路删除。
        """
        with self._lock:
            inst = self._instances[gid]
            self._authorize(inst, actor)
            collected: list[str] = []
            slots = [slot_id] if slot_id is not None else list(inst.overflow)
            for sid in slots:
                remaining = []
                for child in inst.overflow.get(sid, []):
                    if self._instance_busy(child):
                        remaining.append(child)
                        continue
                    # 孤儿的 controllers 是 service:{父实例 gid} + system:core；
                    # 父实例 owner 已授权本次回收，内部以父实例身份关闭子实例。
                    self.control(child, "close", actor=f"service:{inst.gid}")
                    collected.append(child)
                inst.overflow[sid] = remaining
            return collected

    def _authorize(self, inst, actor) -> Principal:
        """actor 由可信边界注入，payload 不能自封身份（#10）。"""
        principal = Principal.parse(actor)
        if str(principal) not in inst.controllers:
            raise AuthorizationError(
                f"principal {principal} 无权控制 {inst.gid}；"
                f"可信主体：{sorted(inst.controllers)}"
            )
        return principal

    def control(self, gid, action, *, actor) -> None:
        """控制走授权路径并留下提交事实，不是旁路 API。"""
        with self._lock:
            inst = self._instances[gid]
            self._authorize(inst, actor)
            if action == "close":
                inst.status = "CLOSED"
            elif action == "pause":
                for rec in list(self._records.values()):
                    if rec.gid == gid and rec.status == "RUNNING":
                        self.cancel_execution(rec.execution_id)
                inst.status = "PAUSED"
            elif action == "resume":
                inst.status = "OPEN"
            else:
                raise InvariantError(f"unknown control action: {action}")
            inst.seq += 1
            self._append_object(
                f"run/{gid}",
                {"seq": inst.seq, "node": None, "control": action, "actor": actor,
                 "edges_traversed": [], "endpoint": None},
                provenance=Provenance(graph_instance_id=gid, at_seq=inst.seq),
            )

    def approve(self, gid, node_id, *, actor, decision, payload=None) -> None:
        with self._lock:
            inst = self._instances.get(gid)
            if inst is None:
                raise InvariantError(f"未知实例：{gid}")
            if inst.status != "OPEN":
                raise InvariantError(
                    f"{gid} 已 {inst.status}，拒绝审批路由（终态气密）")
            tpl = self._templates[inst.template_ref]
            node = tpl["nodes"][node_id]
            allowed = node.get("authorized_actors")
            if allowed is not None and actor not in allowed:
                raise AuthorizationError(
                    f"actor {actor!r} 不在 {node_id} 的授权名单内：{allowed}"
                )
            pending = inst.nodes[node_id].persistent.get("pending", [])
            if not pending:
                raise InvariantError(f"{node_id} 没有待审批项")
            msg = self._messages[pending.pop(0)]
            out = msg.payload if payload is None else payload
            port = (
                node.get("approve_port", "out") if decision == "allow"
                else node.get("deny_port", "denied")
            )
            traversed = self._route(inst, tpl, node_id, port, out)
            msg.state = "CONSUMED"
            inst.seq += 1
            self._append_object(
                f"run/{gid}",
                {"seq": inst.seq, "node": node_id, "endpoint": msg.target[2],
                 "decision": decision, "actor": actor, "edges_traversed": traversed,
                 "payload": out},
                provenance=Provenance(
                    graph_instance_id=gid, node_id=node_id, at_seq=inst.seq
                ),
            )
