"""Nodeflow V4 —— 核心类型

协议数据类、ObjectStore、Principal、错误、内部状态结构。
不含任何 Runtime 行为。

原文件头：接口规格 + A/C 组最小实现

已实现：卡片与 AgentSpec 编译（A 组）、队列与订阅（C 组）、最小调度。
未实现的方法保持 NotImplementedError，对应测试保持 RED。

约定：
  - endpoint 地址 = (graph_instance_id, node_id, endpoint_name)
  - 队列地址 = topic_id —— 与图拓扑正交（不变量 M2）
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import asdict, dataclass, field, replace
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
        self._lock = threading.RLock()      # 版本分配必须串行（V1）

    @staticmethod
    def content_hash(body: Mapping[str, Any]) -> str:
        blob = json.dumps(body, sort_keys=True, default=repr, ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def put(self, object_id, kind, body, provenance: Provenance | None = None) -> ObjectVersion:
        """唯一写入口。同内容重复提交返回既有版本（V3 幂等）。"""
        h = self.content_hash(body)
        with self._lock:
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


@dataclass(frozen=True)
class Principal:
    """控制面主体（#10）。

    形式固定为 `kind:id`。**必须由可信边界注入**，绝不能从 payload 复制 ——
    调用者在 JSON 里写 `"actor": "human:alice"` 不能因此获得权限。
    """

    kind: Literal["human", "agent", "system", "service"]
    id: str

    def __str__(self) -> str:
        return f"{self.kind}:{self.id}"

    @classmethod
    def parse(cls, value) -> Principal:
        if isinstance(value, Principal):
            return value
        text = str(value)
        kind, sep, ident = text.partition(":")
        if not sep or kind not in ("human", "agent", "system", "service"):
            raise InvariantError(
                f"principal 必须形如 kind:id，kind ∈ "
                f"human|agent|system|service，得到 {text!r}"
            )
        return cls(kind=kind, id=ident)          # type: ignore[arg-type]


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
    context_trims: tuple = ()          # 本次调用为塞进预算裁掉了什么


@dataclass
class _Unit:
    """一份已 claim 住、待执行的活。选取在锁内，执行在锁外。"""

    kind: str                       # agent | strategy | simple
    inst: Any
    node_id: str
    node: Mapping[str, Any]
    msg: Any = None
    batch: Any = None
    execution_id: str | None = None
    discard: tuple = ()            # TOP_ONE DISCARD：随本次提交一起消费但不进 handler
    selection_ctx: dict = field(default_factory=dict)   # CROSS_ALL 等选择期上下文


@dataclass
class _Message:
    mid: str
    target: tuple[str, str, str]
    payload: Any
    state: str = "QUEUED"
    callback: tuple[str, str, str] | None = None
    topic: str | None = None
    mkind: str = "DATA"        # DATA | REPLY
    attempts: int = 0          # 已失败次数（#7 重试策略）
    exit_port: str | None = None   # 子流程回程端口（#9，取代 "reply" 魔法串）


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

_ALLOWED_NODE_KINDS = {"agent", "plain", "strategy", "approval", "subflow", "start", "end"}
