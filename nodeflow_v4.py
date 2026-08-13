"""Nodeflow V4 —— 接口规格 + A/C 组最小实现

已实现：卡片与 AgentSpec 编译（A 组）、队列与订阅（C 组）、最小调度。
未实现的方法保持 NotImplementedError，对应测试保持 RED。

约定：
  - endpoint 地址 = (graph_instance_id, node_id, endpoint_name)
  - 队列地址 = topic_id —— 与图拓扑正交（不变量 M2）
"""

from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Literal, Mapping, Sequence

# ---------------------------------------------------------------------------
# 执行面接口（FOUNDATION_V4.md §4.2）
# ---------------------------------------------------------------------------

Termination = Literal["DONE", "CANCELLED", "BUDGET", "INVALID_OUTPUT", "FAILED"]


@dataclass(frozen=True)
class InvocationContext:
    """每次 agent 调用重新编译。不保留隐藏会话历史。"""

    head: tuple[str, ...] = ()
    messages: tuple[Any, ...] = ()
    tail: tuple[str, ...] = ()
    transient: tuple[Any, ...] = ()


@dataclass(frozen=True)
class WorkspaceScope:
    """只告诉 harness 在哪儿干活。文件/git/编辑范围由 agent 的 tool 自理。"""

    root: str = "."


@dataclass(frozen=True)
class OutputContract:
    """Agent 只能选，不能构造 —— 第一不变量的落地点。"""

    schema: Mapping[str, Any] = field(default_factory=dict)
    allowed_emit_ports: tuple[str, ...] = ()


@dataclass(frozen=True)
class ExecutionLimits:
    token_budget: int | None = None
    wall_clock_seconds: float | None = None
    max_tool_calls: int | None = None


@dataclass(frozen=True)
class ExecutionRequest:
    execution_id: str
    agent_spec: Mapping[str, Any]
    context: InvocationContext
    origin: tuple[str, str] = ("", "")     # (graph_instance_id, node_id)
    workspace: WorkspaceScope = WorkspaceScope()
    output_contract: OutputContract = OutputContract()
    limits: ExecutionLimits = ExecutionLimits()
    resume_handle: Any | None = None


@dataclass(frozen=True)
class Usage:
    in_tokens: int = 0
    out_tokens: int = 0
    cost: float = 0.0
    wall_clock_seconds: float = 0.0
    tool_calls: int = 0
    compactions: int = 0          # 非零 = 图切分错误的告警信号


@dataclass(frozen=True)
class ExecutionResult:
    execution_id: str
    emissions: tuple[tuple[str, Any], ...] = ()
    # (kind, object_id, body) —— backend 只提交内容，版本由 ObjectStore 分配（V1）
    artifacts: tuple[tuple[str, str, Mapping[str, Any]], ...] = ()
    usage: Usage = Usage()
    termination: Termination = "DONE"
    session_handle: Any | None = None
    # 观测位：backend 实际发生了什么。含**不可干预的内部 tool**——
    # 判据 B6：控制不了没关系，但必须能查询、能展示。落进 RunSnapshot。
    observations: tuple[Mapping[str, Any], ...] = ()
    diagnostics: Mapping[str, Any] = field(default_factory=dict)


class ExecutionBackend:
    def run(self, request: ExecutionRequest) -> ExecutionResult:
        raise NotImplementedError

    def cancel(self, execution_id: str) -> None:
        raise NotImplementedError


class MockExecutionBackend(ExecutionBackend):
    """按 agent_spec id 注册处理函数，并记录收到的每一个请求。"""

    def __init__(self) -> None:
        self.seen: list[ExecutionRequest] = []
        self._handlers: dict[str, Callable[[ExecutionRequest], ExecutionResult]] = {}
        self._cancelled: set[str] = set()

    def on(self, spec_id: str, handler: Callable[[ExecutionRequest], ExecutionResult]) -> None:
        self._handlers[spec_id] = handler

    def run(self, request: ExecutionRequest) -> ExecutionResult:
        self.seen.append(request)
        spec_id = request.agent_spec.get("spec_id")
        handler = self._handlers.get(spec_id)
        if handler is None:
            return ExecutionResult(execution_id=request.execution_id)
        return handler(request)

    def cancel(self, execution_id: str) -> None:
        self._cancelled.add(execution_id)

    def last_request_for(self, spec_id: str) -> ExecutionRequest:
        for req in reversed(self.seen):
            if req.agent_spec.get("spec_id") == spec_id:
                return req
        raise KeyError(spec_id)


# ---------------------------------------------------------------------------
# 观察投影
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecutionRecordView:
    execution_id: str
    graph_instance_id: str
    node_id: str
    status: Literal["RUNNING", "APPLIED", "CANCELLED", "FAILED"]
    epoch: int | None = None


# ---------------------------------------------------------------------------
# 版本层 —— ObjectStore 是版本分配的唯一权威（INTERFACES_V4.md §3）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Provenance:
    """trace 追踪：谁在哪次执行里产出、派生自哪些版本。"""

    graph_instance_id: str | None = None
    node_id: str | None = None
    execution_id: str | None = None
    at_seq: int = 0
    derived_from: tuple[str, ...] = ()


@dataclass(frozen=True)
class ObjectVersion:
    """独立于 GraphInstance 的不可变实体（不变量 V2）。"""

    object_id: str
    version: int
    kind: str
    content_hash: str
    body: Mapping[str, Any]
    provenance: Provenance = Provenance()

    @property
    def ref(self) -> str:
        return f"{self.object_id}@{self.version}"


class ObjectStore:
    """单例。版本号只由它分配（V1），单调、per object_id 全局唯一。

    Annotation 与 RunSnapshot 也是普通 ObjectVersion —— 分别是
    kind="annotation" / kind="run"，因此自动获得 provenance 与 lineage。
    """

    KERNEL_KINDS = ("run", "annotation", "context_summary")

    def __init__(self) -> None:
        self._by_object: dict[str, list[ObjectVersion]] = {}
        self._by_hash: dict[tuple[str, str], ObjectVersion] = {}

    @staticmethod
    def content_hash(body: Mapping[str, Any]) -> str:
        blob = json.dumps(body, sort_keys=True, default=repr, ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def put(self, object_id, kind, body, provenance: Provenance | None = None) -> ObjectVersion:
        """唯一写入口。同内容重复提交返回既有版本（V3 幂等）。"""
        h = self.content_hash(body)
        existing = self._by_hash.get((object_id, h))
        if existing is not None:
            return existing
        versions = self._by_object.setdefault(object_id, [])
        ov = ObjectVersion(
            object_id=object_id,
            version=len(versions) + 1,
            kind=kind,
            content_hash=h,
            body=dict(body),
            provenance=provenance or Provenance(),
        )
        versions.append(ov)
        self._by_hash[(object_id, h)] = ov
        return ov

    def get(self, object_id, version) -> ObjectVersion:
        return self._by_object[object_id][version - 1]

    def resolve(self, ref: str) -> ObjectVersion:
        """只接受精确引用 `object_id@version`（不变量 V4）。"""
        if "@" not in ref:
            raise InvariantError(f"引用必须精确到版本：{ref!r}")
        oid, ver = ref.rsplit("@", 1)
        return self.get(oid, int(ver))

    def head(self, object_id) -> ObjectVersion:
        return self._by_object[object_id][-1]

    def history(self, object_id) -> Sequence[ObjectVersion]:
        return list(self._by_object.get(object_id, []))

    def lineage(self, ref: str) -> dict[str, list[str]]:
        """回溯版本 DAG：{ref: [上游 ref, ...]}。"""
        out: dict[str, list[str]] = {}
        frontier = [ref]
        while frontier:
            cur = frontier.pop()
            if cur in out:
                continue
            try:
                ov = self.resolve(cur)
            except (KeyError, IndexError, InvariantError):
                out[cur] = []
                continue
            parents = list(ov.provenance.derived_from)
            out[cur] = parents
            frontier.extend(parents)
        return out


@dataclass(frozen=True)
class QueueView:
    topic_id: str
    depth: int
    subscriber_endpoints: tuple[tuple[str, str, str], ...]


# ---------------------------------------------------------------------------
# 内部结构
# ---------------------------------------------------------------------------


class InvariantError(RuntimeError):
    pass


class AuthorizationError(InvariantError):
    pass


@dataclass
class _NodeState:
    persistent: dict[str, Any] = field(default_factory=dict)
    tail: list[str] = field(default_factory=list)
    last_context: InvocationContext | None = None
    last_spec: dict[str, Any] | None = None
    version: int = 0                      # 冲突域：节点级，不是容器级
    session_handle: Any = None


@dataclass
class _Instance:
    gid: str
    template_ref: str
    owner: str
    status: str = "OPEN"
    seq: int = 0
    params: Mapping[str, Any] = field(default_factory=dict)
    nodes: dict[str, _NodeState] = field(default_factory=dict)
    head: tuple[str, ...] = ()
    children: dict[str, list[str]] = field(default_factory=dict)
    pool_cursor: dict[str, int] = field(default_factory=dict)
    controllers: set[str] = field(default_factory=set)


@dataclass
class _Record:
    """ExecutionRecord —— claim/execute/apply 的持久事实。

    取消与崩溃接管的唯一依据（FOUNDATION §4.4）。
    """

    execution_id: str
    gid: str
    node_id: str
    status: str = "RUNNING"
    claimed: tuple[str, ...] = ()
    request: Any = None
    base_node_version: int = 0
    session_handle: Any = None


@dataclass
class _Message:
    mid: str
    target: tuple[str, str, str]
    payload: Any
    state: str = "QUEUED"
    callback: tuple[str, str, str] | None = None
    topic: str | None = None
    mkind: str = "DATA"        # DATA | REPLY


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

_ALLOWED_NODE_KINDS = {"agent", "plain", "strategy", "approval", "subflow", "start", "end"}


class Runtime:
    def __init__(self) -> None:
        self._ids = itertools.count(1)
        self._cards: dict[tuple[str, str], dict[int, Mapping[str, Any]]] = {}
        self._specs: dict[str, dict[str, Any]] = {}
        self._templates: dict[str, Mapping[str, Any]] = {}
        self._topics: dict[str, Mapping[str, Any]] = {}
        self._transforms: dict[str, dict[str, Any]] = {}
        self._policies: dict[str, Mapping[str, Any]] = {}
        self._handlers: dict[str, Callable[..., Any]] = {}
        self._instances: dict[str, _Instance] = {}
        self._messages: dict[str, _Message] = {}
        self._subs: dict[str, list[tuple[str, tuple[str, str, str]]]] = {}
        self.store = ObjectStore()          # 版本分配的唯一权威
        self._records: dict[str, _Record] = {}
        self._backend: ExecutionBackend | None = None
        self.max_output_retries = 3
        self.chars_per_token = 4          # 预算估算用的粗略换算

    def _nid(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids):05d}"

    # ---- 装配面 -----------------------------------------------------------

    def register_card(self, *, kind, card_id, version, body, tags=()) -> str:
        if kind not in ("skill", "mcp", "rules", "prompt"):
            raise InvariantError(f"unknown card kind: {kind}")
        slot = self._cards.setdefault((kind, card_id), {})
        if version in slot:
            raise InvariantError(f"card version already exists: {kind}/{card_id}@{version}")
        # 只读引用：正文冻结，不提供就地修改入口
        slot[version] = dict(body)
        return f"{kind}/{card_id}@{version}"

    def _latest(self, kind: str, card_id: str) -> int:
        slot = self._cards.get((kind, card_id))
        if not slot:
            raise InvariantError(f"unknown card: {kind}/{card_id}")
        return max(slot)

    def compile_agent_spec(self, spec_id, *, model, cards=(), tools=()) -> Mapping[str, Any]:
        """cards 元素为 (kind, id)（跟随最新）或 (kind, id, version)（显式 pin）。"""
        declared: list[tuple[str, str, int | None]] = []
        for entry in cards:
            if len(entry) == 2:
                declared.append((entry[0], entry[1], None))
            else:
                kind, cid, ver = entry
                if ver not in self._cards.get((kind, cid), {}):
                    raise InvariantError(f"unknown card version: {kind}/{cid}@{ver}")
                declared.append((kind, cid, ver))
        spec = {
            "spec_id": spec_id,
            "model": model,
            "declared_cards": declared,
            "tools": list(tools),
        }
        self._specs[spec_id] = spec
        return self._resolve_spec(spec_id)

    def _resolve_spec(self, spec_id: str) -> dict[str, Any]:
        """把声明解析成具体版本。休眠→唤醒时调用一次，执行期间冻结。"""
        spec = self._specs[spec_id]
        refs, table = [], {}
        for kind, cid, ver in spec["declared_cards"]:
            v = ver if ver is not None else self._latest(kind, cid)
            refs.append(f"{kind}/{cid}@{v}")
            table[f"{kind}/{cid}"] = v
        return {
            "spec_id": spec_id,
            "model": spec["model"],
            "card_refs": refs,
            "cards": table,
            "tools": list(spec["tools"]),
        }

    def card_body(self, kind: str, card_id: str, version: int) -> Mapping[str, Any]:
        """只读引用。返回不可变映射视图。"""
        from types import MappingProxyType

        return MappingProxyType(self._cards[(kind, card_id)][version])

    # ---- 定义层 -----------------------------------------------------------

    def register_graph_template(self, template_id, spec) -> str:
        for node_id, node in spec.get("nodes", {}).items():
            kind = node.get("kind")
            if kind not in _ALLOWED_NODE_KINDS:
                raise InvariantError(
                    f"unsupported node kind {kind!r} at {node_id!r}; "
                    f"循环锚点是 strategy 的配置，不是节点种类（FOUNDATION §5.6）"
                )
        ref = f"{template_id}@1"
        self._templates[ref] = spec
        return ref

    def register_topic(self, topic_id, *, request_contract, reply_contract=None) -> str:
        self._topics[topic_id] = {
            "request_contract": request_contract,
            "reply_contract": reply_contract,
        }
        self._subs.setdefault(topic_id, [])
        return topic_id

    def register_transform(self, transform_id, *, role, body) -> str:
        self._transforms[transform_id] = {"role": role, "body": dict(body)}
        return transform_id

    def register_policy(self, policy_id, spec) -> str:
        self._policies[policy_id] = spec
        return policy_id

    def register_handler(self, name: str, fn: Callable[..., Any]) -> str:
        self._handlers[name] = fn
        return name

    # ---- 实例层 -----------------------------------------------------------

    def instantiate(self, template_ref, *, owner, params=None, controllers=()) -> str:
        tpl = self._templates[template_ref]
        gid = self._nid("gi")
        inst = _Instance(
            gid=gid,
            template_ref=template_ref,
            owner=owner,
            params=dict(params or {}),
            head=tuple((params or {}).get("context_head", ())),
            controllers={owner, "system", *controllers},
        )
        for node_id in tpl.get("nodes", {}):
            inst.nodes[node_id] = _NodeState()
        self._instances[gid] = inst
        # 模板级订阅声明在实例化时解析成具体订阅
        for sub in tpl.get("subscriptions", []):
            node_id, ep = sub["endpoint"].split(".")
            self.subscribe(sub["topic"], target=(gid, node_id, ep))
        return gid

    def subscribe(self, topic_id, *, target) -> str:
        if topic_id not in self._topics:
            raise InvariantError(f"unknown topic: {topic_id}")
        sid = self._nid("sub")
        self._subs.setdefault(topic_id, []).append((sid, target))
        return sid

    def unsubscribe(self, subscription_id) -> None:
        for topic, entries in self._subs.items():
            self._subs[topic] = [e for e in entries if e[0] != subscription_id]

    # ---- 驱动 -------------------------------------------------------------

    def set_backend(self, backend) -> None:
        self._backend = backend

    def send(self, target, payload) -> str:
        gid = target[0]
        if self._instances[gid].status != "OPEN":
            raise InvariantError("instance is not OPEN")
        return self._new_message(target, payload)

    def publish(self, topic_id, payload, *, sender=None, callback=None) -> str:
        if topic_id not in self._topics:
            raise InvariantError(f"unknown topic: {topic_id}")
        if isinstance(payload, Mapping) and "edgeId" in payload:
            raise InvariantError("消息不得指定下游边（不变量 M1）")
        ids = []
        for _sid, target in self._subs.get(topic_id, []):
            # 每个订阅者拿独立 payload 副本
            ids.append(
                self._new_message(target, dict(payload), callback=callback, topic=topic_id)
            )
        return ids[0] if ids else ""

    def _new_message(self, target, payload, *, callback=None, topic=None, mkind="DATA") -> str:
        mid = self._nid("msg")
        self._messages[mid] = _Message(
            mid=mid, target=target, payload=payload,
            callback=callback, topic=topic, mkind=mkind,
        )
        return mid

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

    def _dispatch_once(self, gids) -> bool:
        scope = set(gids) if gids else set(self._instances)
        for msg in list(self._messages.values()):
            if msg.state != "QUEUED":
                continue
            gid, node_id, _ep = msg.target
            if gid not in scope or self._instances[gid].status != "OPEN":
                continue
            inst = self._instances[gid]
            node = self._templates[inst.template_ref]["nodes"][node_id]
            if node["kind"] == "strategy":
                batch = self._select_for_strategy(inst, node_id, node)
                if batch is None:
                    continue                      # 未就绪，让给别的消息
                self._handle_strategy(inst, node_id, node, batch)
                return True
            self._handle(msg)
            return True
        return False

    # ---- Strategy：input policy -> evaluator -> output policy --------------

    def _select_for_strategy(self, inst, node_id, node) -> list[_Message] | None:
        policy = self._policies[node["policy"]]
        by_ep: dict[str, list[_Message]] = {}
        for m in self._messages.values():
            if m.state == "QUEUED" and m.target[0] == inst.gid and m.target[1] == node_id:
                by_ep.setdefault(m.target[2], []).append(m)
        if not by_ep:
            return None
        if policy.get("readiness", "ANY") == "ALL_REQUIRED":
            required = policy["required_inputs"]
            if not all(by_ep.get(ep) for ep in required):
                return None
            # ONE_PER_INPUT：每个必需端点原子取一条
            return [by_ep[ep][0] for ep in required]
        return [next(iter(by_ep.values()))[0]]

    def _handle_strategy(self, inst, node_id, node, batch) -> None:
        tpl = self._templates[inst.template_ref]
        for m in batch:
            m.state = "CLAIMED"
        payloads = {m.target[2]: m.payload for m in batch}
        evaluator = self._handlers.get(node.get("handler"))
        decision = (
            evaluator(payloads, self._node_ctx(inst, node_id)) if evaluator else {}
        ) or {}

        out_policy = self._policies[node["policy"]].get("output", {})
        traversed: list[str] = []
        spawned: list[str] = []
        if out_policy.get("mode") == "FANOUT_TO_SLOT":
            slot_id = out_policy["slot"]
            slot = tpl["slots"][slot_id]
            entry_node, entry_ep = slot["entry"].split(".")
            for item in decision.get("items", []):
                child = self._spawn_child(inst, slot_id, slot)
                spawned.append(child)
                self._new_message((child, entry_node, entry_ep), item)
        for port, payload in (decision.get("emit") or {}).items():
            traversed += self._route(inst, tpl, node_id, port, payload)

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
        inst.seq += 1
        self._append_object(
            f"run/{inst.gid}",
            {
                "seq": inst.seq,
                "node": node_id,
                "endpoint": ",".join(sorted(payloads)),
                "message": ",".join(m.mid for m in batch),
                "topic": None,
                "edges_traversed": traversed,
                "spawned": spawned,
                "payload": payloads,
            },
            provenance=Provenance(
                graph_instance_id=inst.gid, node_id=node_id, at_seq=inst.seq
            ),
        )

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
        self._new_message(
            (child, entry_node, entry_ep),
            msg.payload,
            callback=(inst.gid, node_id, msg.target[2]),
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
                inst.pool_cursor[slot_id] = cursor + 1
                # 只复用执行资源，不复用状态：清空 persistentState（判据=暗示性）
                for st in self._instances[child].nodes.values():
                    st.persistent.clear()
                return child
        child = self.instantiate(slot["template"], owner=inst.gid)
        bucket.append(child)
        return child

    def _handle(self, msg: _Message) -> None:
        gid, node_id, ep = msg.target
        inst = self._instances[gid]
        tpl = self._templates[inst.template_ref]
        node = tpl["nodes"][node_id]
        kind = node["kind"]
        if kind == "agent":
            # agent 走 claim / execute / apply 三段，自带提交与快照
            self._run_agent_full(inst, node_id, node, msg)
            return
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
            outputs = {}
        else:
            raise NotImplementedError(f"node kind not implemented yet: {kind}")

        # reply 端口 + 原消息带 callback → 回投到已声明端点（不变量 M3）
        if "reply" in outputs and msg.callback is not None:
            self._new_message(msg.callback, outputs.pop("reply"), mkind="REPLY")

        for port, payload in outputs.items():
            traversed += self._route(inst, tpl, node_id, port, payload)

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

    def _route(self, inst, tpl, node_id, port, payload) -> list[str]:
        src = f"{node_id}.{port}"
        traversed = []
        for edge in tpl.get("edges", []):
            if edge["from"] != src:
                continue
            tgt_node, tgt_ep = edge["to"].split(".")
            out = dict(payload) if isinstance(payload, Mapping) else payload
            if edge.get("servo"):
                out = self._apply_servo(edge["servo"], out)
            self._new_message((inst.gid, tgt_node, tgt_ep), out)
            traversed.append(edge.get("id", edge["from"] + "->" + edge["to"]))
        return traversed

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

    # ---- 执行面三段式：claim / execute / apply（FOUNDATION §4.4） ----------

    def _run_agent_full(self, inst, node_id, node, msg) -> None:
        eid = self._claim(inst, node_id, node, [msg])
        rec = self._records[eid]
        result = self._execute_with_retry(rec)
        if result.termination == "CANCELLED":
            self._release(eid, "CANCELLED")
            return
        if result.termination in ("FAILED", "INVALID_OUTPUT", "BUDGET"):
            # 执行面耗尽重试仍不合格 —— 不产生任何提交
            self._release(eid, "FAILED")
            return
        self.apply_execution(eid, result)

    def _claim(self, inst, node_id, node, msgs) -> str:
        """commit A —— 锁定输入，写 RUNNING 记录，推进节点级版本。"""
        if self._backend is None:
            raise InvariantError("no execution backend configured")
        st = inst.nodes[node_id]
        # 休眠→唤醒时解析一次卡片版本，执行期间冻结
        resolved = self._resolve_spec(node["spec"])
        ctx = InvocationContext(
            head=inst.head,
            messages=tuple(m.payload for m in msgs),
            tail=tuple(st.tail),
        )
        st.last_context, st.last_spec = ctx, resolved
        # 预算在调用**前**校验：超预算是编排面的错，不该丢给 harness 去压缩
        budget = (node.get("limits") or {}).get("token_budget")
        if budget is not None and self.estimate_tokens(ctx) > budget:
            raise InvariantError(
                f"context budget exceeded before invocation: "
                f"{self.estimate_tokens(ctx)} > {budget}（图切分过粗）"
            )
        eid = self._nid("exec")
        req = ExecutionRequest(
            execution_id=eid,
            agent_spec=resolved,
            context=ctx,
            origin=(inst.gid, node_id),
            output_contract=OutputContract(
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
            base_node_version=st.version,
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
        """commit B —— base 检查只针对被 claim 的切片（节点级，非容器级）。"""
        rec = self._records[execution_id]
        if rec.status != "RUNNING":
            raise InvariantError(f"execution is not RUNNING: {rec.status}")
        inst = self._instances[rec.gid]
        st = inst.nodes[rec.node_id]
        if st.version != rec.base_node_version:
            raise InvariantError("node-scoped base changed since claim")

        tpl = self._templates[inst.template_ref]
        allowed = rec.request.output_contract.allowed_emit_ports
        outputs: dict[str, Any] = {}
        for port, payload in result.emissions:
            if port not in allowed and port != "reply":
                raise InvariantError(f"agent emitted undeclared port: {port}")
            outputs[port] = payload

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

        claimed = [self._messages[mid] for mid in rec.claimed]
        traversed: list[str] = []
        if "reply" in outputs:
            cb = next((m.callback for m in claimed if m.callback), None)
            if cb is not None:
                self._new_message(cb, outputs.pop("reply"), mkind="REPLY")
        for port, payload in outputs.items():
            traversed += self._route(inst, tpl, rec.node_id, port, payload)

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
                "observations": list(result.observations),
                "payload": rec.request.context.messages,
            },
            provenance=Provenance(
                graph_instance_id=rec.gid, node_id=rec.node_id,
                execution_id=execution_id, at_seq=inst.seq,
                derived_from=tuple(produced),
            ),
        )

    def _release(self, execution_id, status) -> None:
        rec = self._records[execution_id]
        for mid in rec.claimed:
            self._messages[mid].state = "QUEUED"       # 输入恢复，不丢工作
        rec.status = status

    def begin_execution(self, gid, node_id):
        """显式 claim（供调度器与测试分步驱动）。返回 (execution_id, request)。"""
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
        rec = self._records.get(execution_id)
        if rec is None or rec.status != "RUNNING":
            return
        if self._backend is not None:
            self._backend.cancel(execution_id)
        self._release(execution_id, "CANCELLED")

    def reclaim_stale_executions(self) -> list[str]:
        """崩溃接管：RUNNING 记录是唯一依据，输入退回 QUEUED 可被重新认领。"""
        stale = [r.execution_id for r in self._records.values() if r.status == "RUNNING"]
        for eid in stale:
            self._release(eid, "FAILED")
        return stale

    def append_context_tail(self, gid: str, node_id: str, ref: str) -> None:
        """运行期发现的卡片追加到该实例的 tail。不回写模板。"""
        self._instances[gid].nodes[node_id].tail.append(ref)

    def _authorize(self, inst, actor: str) -> None:
        """actor 由可信边界注入，payload 不能自封身份。"""
        if actor not in inst.controllers:
            raise AuthorizationError(
                f"actor {actor!r} 无权控制 {inst.gid}；可信主体：{sorted(inst.controllers)}"
            )

    def control(self, gid, action, *, actor) -> None:
        """控制走授权路径并留下提交事实，不是旁路 API。"""
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
        inst = self._instances[gid]
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

    # ---- 观察 -------------------------------------------------------------

    def graph_status(self, gid): return self._instances[gid].status

    def node_persistent_state(self, gid, node_id):
        return self._instances[gid].nodes[node_id].persistent

    def node_executions(self, gid, node_id) -> Sequence[ExecutionRecordView]:
        return [
            ExecutionRecordView(r.execution_id, r.gid, r.node_id, r.status)
            for r in self._records.values()
            if r.gid == gid and r.node_id == node_id
        ]

    def children_of(self, gid, slot_id):
        return list(self._instances[gid].children.get(slot_id, []))

    def context_of(self, gid, node_id) -> InvocationContext:
        """该节点**当前**的上下文构成。想看某次调用实际收到的，读 backend 记录的请求。"""
        st = self._instances[gid].nodes[node_id]
        return InvocationContext(head=self._instances[gid].head, tail=tuple(st.tail))

    def agent_spec_of(self, gid, node_id) -> Mapping[str, Any]:
        st = self._instances[gid].nodes[node_id]
        if st.last_spec is None:
            tpl = self._templates[self._instances[gid].template_ref]
            return self._resolve_spec(tpl["nodes"][node_id]["spec"])
        return st.last_spec

    def _append_object(self, oid, body, *, kind=None, provenance=None) -> ObjectVersion:
        """内部写入口 —— 一律经 store，绝不自行分配版本号。"""
        if kind is None:
            kind = ("run" if oid.startswith("run/")
                    else "annotation" if oid.startswith("annotation/")
                    else "object")
        return self.store.put(oid, kind, body, provenance)

    def artifact_versions(self, oid) -> list[int]:
        return [ov.version for ov in self.store.history(oid)]

    def artifact(self, oid, version) -> Mapping[str, Any]:
        return self.store.get(oid, version).body

    def annotations(self, gid) -> Sequence[ObjectVersion]:
        """Annotation 就是 kind="annotation" 的 ObjectVersion。"""
        return self.store.history(f"annotation/{gid}")

    def estimate_tokens(self, ctx: InvocationContext) -> int:
        blob = "".join(str(x) for x in (ctx.head, ctx.messages, ctx.tail, ctx.transient))
        return len(blob) // self.chars_per_token

    def queue(self, topic_id) -> QueueView:
        if topic_id not in self._topics:
            raise InvariantError(f"unknown topic: {topic_id}")
        depth = sum(
            1 for m in self._messages.values()
            if m.topic == topic_id and m.state == "QUEUED"
        )
        return QueueView(
            topic_id=topic_id,
            depth=depth,
            subscriber_endpoints=tuple(t for _s, t in self._subs.get(topic_id, [])),
        )

    def usage(self, gid) -> Usage:
        acc: dict[str, Any] = {}
        for ov in self.store.history(f"run/{gid}"):
            u = ov.body.get("usage")
            if not isinstance(u, Mapping):
                continue
            for k, v in u.items():
                acc[k] = acc.get(k, 0) + v
        return Usage(**acc) if acc else Usage()

    def context_alerts(self, gid) -> list[Mapping[str, Any]]:
        """压缩不是特性，是图切分错误的告警信号（FOUNDATION §1）。"""
        out = []
        for ov in self.store.history(f"run/{gid}"):
            u = ov.body.get("usage")
            if isinstance(u, Mapping) and u.get("compactions"):
                out.append({
                    "node": ov.body.get("node"),
                    "execution": ov.body.get("execution"),
                    "compactions": u["compactions"],
                    "reason": "上下文压缩发生 —— 该节点承担的任务过大，应拆分",
                })
        return out

    def commit_seq(self, gid): return self._instances[gid].seq

    # 注：没有 fork_from_checkpoint。
    # fork = 用某条 Annotation 的 object_refs 作为 params 调 instantiate()。
