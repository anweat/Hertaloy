"""Nodeflow V4 —— 接口规格 + A/C 组最小实现

已实现：卡片与 AgentSpec 编译（A 组）、队列与订阅（C 组）、最小调度。
未实现的方法保持 NotImplementedError，对应测试保持 RED。

约定：
  - endpoint 地址 = (graph_instance_id, node_id, endpoint_name)
  - 队列地址 = topic_id —— 与图拓扑正交（不变量 M2）
"""

from __future__ import annotations

import copy
import hashlib
import itertools
import json
import re
import threading
import time
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


class Runtime:
    def __init__(self) -> None:
        self._ids = itertools.count(1)
        self._cards: dict[tuple[str, str], dict[int, Mapping[str, Any]]] = {}
        self._characters: dict[str, dict[str, Any]] = {}
        self._specs: dict[str, dict[str, Any]] = {}
        self._templates: dict[str, Mapping[str, Any]] = {}
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

    # ---- 装配面 -----------------------------------------------------------

    def register_card(self, *, kind, card_id, version, body, tags=()) -> str:
        if kind not in ("skill", "mcp", "rules", "prompt"):
            raise InvariantError(f"unknown card kind: {kind}")
        slot = self._cards.setdefault((kind, card_id), {})
        if version in slot:
            raise InvariantError(f"card version already exists: {kind}/{card_id}@{version}")
        # 只读引用：正文冻结，不提供就地修改入口。
        # deepcopy：嵌套 dict 也不得被调用方事后修改（边界 B1c）。
        slot[version] = copy.deepcopy(body)
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

    def register_character(self, character_id, *, cards, tools=()) -> str:
        """装配面对象（边界 Ch）：命名的卡片组合，**不是内核类型**。

        body = 卡片引用列表 + 默认工具集。展开结果与手写卡片组合
        完全同构 —— 编译规则仍归内核，character 只是装配面的命名层。
        """
        if character_id in self._characters:
            raise InvariantError(f"character 已存在：{character_id}")
        declared: list[tuple[str, str, int | None]] = []
        for entry in cards:
            if len(entry) == 2:
                kind, cid = entry
                if kind not in ("skill", "mcp", "rules", "prompt"):
                    raise InvariantError(
                        f"unknown card kind: {kind!r}；"
                        f"character 只能引用 skill/mcp/rules/prompt 卡片")
                declared.append((kind, cid, None))
            else:
                kind, cid, ver = entry
                if kind not in ("skill", "mcp", "rules", "prompt"):
                    raise InvariantError(f"unknown card kind: {kind!r}")
                if ver not in self._cards.get((kind, cid), {}):
                    raise InvariantError(f"unknown card version: {kind}/{cid}@{ver}")
                declared.append((kind, cid, ver))
        self._characters[character_id] = {
            "cards": declared,
            "tools": list(tools),
        }
        return character_id

    def expand_character(self, character_id) -> tuple[list[tuple[str, str, int | None]], list[str]]:
        """展开为 (cards, tools)，可直接传给 compile_agent_spec —— 同构性来源。"""
        if character_id not in self._characters:
            raise InvariantError(f"unknown character: {character_id}")
        ch = self._characters[character_id]
        return list(ch["cards"]), list(ch["tools"])

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

    # ---- 卡片编译器（INTERFACES_V4.md §1.2）------------------------------
    #
    # 布局按**缓存稳定性**排列。不变量 X：稳定前缀不得因运行期发现而改变。
    #   skill / 资料 → 可运行期追加（落 context.tail，位于缓存断点之后）
    #   tool         → 不可运行期新增（编译期声明全集，运行期只做启用）
    #
    # 编译规则属内核，用户不可改 —— 它决定上下文质量，是命题的一部分。

    def _compile_agent_prompt(self, resolved, node) -> tuple[str, list[dict]]:
        by_kind: dict[str, list[tuple[str, int]]] = {}
        for key, ver in resolved.get("cards", {}).items():
            kind, cid = key.split("/", 1)
            by_kind.setdefault(kind, []).append((cid, ver))

        parts: list[str] = []
        tools: list[dict[str, Any]] = []

        # [a] rules 全量前置 —— 必须遵守
        rules = [self.card_body("rules", c, v).get("text", "")
                 for c, v in sorted(by_kind.get("rules", []))]
        rules = [r for r in rules if r]
        if rules:
            parts.append("# 规则（必须遵守）\n" + "\n\n".join(rules))

        # [b] 角色。节点级 systemPrompt 视作一张内联的 prompt 卡。
        roles = [self.card_body("prompt", c, v).get("text", "")
                 for c, v in sorted(by_kind.get("prompt", []))]
        if node.get("systemPrompt"):
            roles.append(str(node["systemPrompt"]))
        roles = [r for r in roles if r]
        if roles:
            parts.append("# 角色\n" + "\n\n".join(roles))

        # [c] mcp 可用列表：名称 + 摘要，**不含全量 schema**
        mcp_lines: list[str] = []
        claimed: dict[str, str] = {}
        for cid, v in sorted(by_kind.get("mcp", [])):
            body = self.card_body("mcp", cid, v)
            for t in body.get("tools", []):
                name = t["name"]
                # #8 工具命名：内核保留名不可占用，跨卡片重名不可静默覆盖
                if name in self.KERNEL_TOOL_NAMES:
                    raise InvariantError(
                        f"mcp/{cid}@{v} 的工具 {name!r} 占用了内核保留名；"
                        f"保留名：{sorted(self.KERNEL_TOOL_NAMES)}"
                    )
                if name in claimed:
                    raise InvariantError(
                        f"工具名冲突：{name!r} 同时来自 {claimed[name]} 与 mcp/{cid}@{v}；"
                        f"请在卡片里改名，不要依赖加载顺序"
                    )
                claimed[name] = f"mcp/{cid}@{v}"
                mcp_lines.append(f"- {name}：{t.get('summary', '')}")
                tools.append({
                    "name": t["name"],
                    "description": t.get("summary", ""),
                    "source": f"mcp/{cid}@{v}",
                    # 不变量 X：工具集编译期声明齐全，运行期只启用不新增
                    "defer_loading": True,
                })
        if mcp_lines:
            parts.append("# 可用 MCP 工具\n" + "\n".join(mcp_lines))

        # [d] skill 压缩索引：只放 summary，全文运行期按需追加到 tail
        skill_lines = [
            f"- skill/{cid}@{v}：{self.card_body('skill', cid, v).get('summary', '')}"
            for cid, v in sorted(by_kind.get("skill", []))
        ]
        if skill_lines:
            parts.append("# 可用 skill（需要时索取全文）\n" + "\n".join(skill_lines))

        # [e] 输出契约 —— 由 emit 端点的 contract 生成，不是人写的
        endpoints = node.get("endpoints") or {}
        emit_ports = [ep for ep, d in endpoints.items()
                      if isinstance(d, Mapping) and "emit" in d] or list(endpoints)
        lines = []
        for ep in sorted(emit_ports):
            ref = self._endpoint_ref(node, ep, "emit")
            if ref:
                fields, required = self._fields_of(self._contract(ref))
                lines.append(f"- {ep}：{ref} 字段 {sorted(fields)}"
                             f"（必需 {sorted(required)}）")
            else:
                lines.append(f"- {ep}")
        if lines:
            parts.append("# 输出契约\n完成后调用 emit 输出，port 只能取以下之一：\n"
                         + "\n".join(lines))

        return "\n\n".join(parts), tools

    @staticmethod
    def prefix_fingerprint(spec: Mapping[str, Any]) -> str:
        """稳定前缀指纹。运行期发现若改变了它，就是违反不变量 X。"""
        blob = str(spec.get("systemPrompt") or "") + json.dumps(
            spec.get("tools") or [], sort_keys=True, ensure_ascii=False, default=repr)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

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
        self._validate_edges(template_id, spec)     # 连接期校验
        ref = f"{template_id}@1"
        # 定义层不可变：注册后调用方修改原 dict 不得影响模板（边界 B1/B6）。
        # _layout（画布坐标）不进入语义层（边界 Lb）：剥离存储。
        stored = copy.deepcopy(spec)
        stored.pop("_layout", None)
        self._templates[ref] = stored
        return ref

    # ---- MessageContract 与端点声明 ---------------------------------------

    def register_contract(self, contract_id, version, schema) -> str:
        """不可变契约。运行消息只能引用精确版本（不变量 V4 的同款规则）。"""
        ref = f"{contract_id}@{version}"
        if ref in self._contracts:
            raise InvariantError(f"契约已存在，不可覆盖：{ref}")
        self._contracts[ref] = copy.deepcopy(schema)   # 边界 B1b：快照
        return ref

    def _contract(self, ref: str | None):
        if ref is None:
            return None
        if "@" not in ref:
            raise InvariantError(f"契约引用必须精确到版本：{ref!r}")
        if ref not in self._contracts:
            raise InvariantError(f"未注册的契约：{ref}")
        return self._contracts[ref]

    @staticmethod
    def _endpoint_ref(node, ep_name, direction, operation="PUSH") -> str | None:
        """端点不是永久的 input/output 两类；方向来自本次 operation。

        未声明 = 未约束（向后兼容），不是"禁止"。
        """
        ep = (node.get("endpoints") or {}).get(ep_name)
        if not isinstance(ep, Mapping):
            return None
        block = ep.get(direction)
        if not isinstance(block, Mapping):
            return None
        entry = block.get(operation)
        if isinstance(entry, Mapping):
            return entry.get("contract")
        return entry if isinstance(entry, str) else None

    @staticmethod
    def _fields_of(schema) -> tuple[set[str], set[str]]:
        if not schema:
            return set(), set()
        return set(schema.get("properties", {})), set(schema.get("required", []))

    def _servo_fields(self, fields: set[str], transform_id: str | None) -> set[str]:
        """符号化推演 Servo 之后的字段集 —— 连接期校验的依据。"""
        if not transform_id:
            return set(fields)
        body = self._transforms[transform_id]["body"]
        out = set(fields)
        for src, dst in (body.get("map") or {}).items():
            if src in out:
                out.discard(src)
            out.add(dst)
        out |= set(body.get("set") or {})
        out -= set(body.get("drop") or ())
        return out

    def _validate_edges(self, template_id: str, spec: Mapping) -> None:
        """连接期校验：边一旦画上就要能跑通，而不是运行到一半才炸。"""
        nodes = spec.get("nodes", {})
        strict = bool(spec.get("strict_contracts"))
        for edge in spec.get("edges", []):
            eid = edge.get("id", f"{edge['from']}->{edge['to']}")
            op = edge.get("operation", "PUSH")
            if op != "PUSH":
                # 契约诚实：V4 的边只实现单向 PUSH 数据流。
                # CALL 需要等待与关联，落在 subflow 节点或队列 REQUEST + callback 上
                # （不变量 M3）；这里若接受 CALL 边而运行时按 PUSH 投递，
                # 是静默降级 —— 宁可注册期拒绝。
                raise InvariantError(
                    f"边 {eid} 不合法：operation={op!r} 未实现。"
                    f"V4 边只支持 PUSH；需要调用语义请用 subflow 节点或"
                    f"队列 REQUEST + callback（不变量 M3）"
                )
            src_node_id, src_ep = edge["from"].split(".", 1)
            tgt_node_id, tgt_ep = edge["to"].split(".", 1)

            for node_id, ep in ((src_node_id, src_ep), (tgt_node_id, tgt_ep)):
                node = nodes.get(node_id)
                if node is None:
                    raise InvariantError(
                        f"边 {eid} 不合法：节点 {node_id!r} 不存在。"
                        f"可用节点：{sorted(nodes)}"
                    )
                if ep not in (node.get("endpoints") or {}):
                    raise InvariantError(
                        f"边 {eid} 不合法：节点 {node_id!r} 没有端点 {ep!r}。"
                        f"可用端点：{sorted((node.get('endpoints') or {}))}"
                    )

            src_ref = self._endpoint_ref(nodes[src_node_id], src_ep, "emit", op)
            tgt_ref = self._endpoint_ref(nodes[tgt_node_id], tgt_ep, "receive", op)
            if src_ref is None or tgt_ref is None:
                if strict:
                    raise InvariantError(
                        f"边 {eid} 不合法：模板声明了 strict_contracts，"
                        f"但 {'源' if src_ref is None else '目标'}端点未声明 {op} 契约"
                    )
                continue                     # 未声明 = 未约束

            src_all, _ = self._fields_of(self._contract(src_ref))
            tgt_all, tgt_req = self._fields_of(self._contract(tgt_ref))
            servo = edge.get("servo")
            after = self._servo_fields(src_all, servo)
            missing = tgt_req - after
            if missing:
                raise InvariantError(
                    f"边 {eid} 不合法：\n"
                    f"  源    {edge['from']}  产出 {src_ref}  {sorted(src_all)}\n"
                    f"  Servo {servo or '（无）'} 之后  {sorted(after)}\n"
                    f"  目标  {edge['to']}  要求 {tgt_ref}  必需 {sorted(tgt_req)}\n"
                    f"  缺失字段：{sorted(missing)}。可用的映射来源：{sorted(after)}"
                )

    def register_topic(self, topic_id, *, request_contract, reply_contract=None) -> str:
        self._topics[topic_id] = {
            "request_contract": copy.deepcopy(request_contract),
            "reply_contract": copy.deepcopy(reply_contract),
        }
        self._subs.setdefault(topic_id, [])
        return topic_id

    def register_transform(self, transform_id, *, role, body) -> str:
        self._transforms[transform_id] = {"role": role, "body": copy.deepcopy(body)}
        return transform_id

    def register_policy(self, policy_id, spec) -> str:
        self._policies[policy_id] = copy.deepcopy(spec)   # 边界 B1c：快照
        return policy_id

    def register_handler(self, name: str, fn: Callable[..., Any]) -> str:
        self._handlers[name] = fn
        return name

    # ---- 实例层 -----------------------------------------------------------

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

    # ---- 驱动 -------------------------------------------------------------

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

    def publish(self, topic_id, payload, *, sender=None, callback=None) -> str:
        with self._lock:
            if topic_id not in self._topics:
                raise InvariantError(f"unknown topic: {topic_id}")
            if isinstance(payload, Mapping) and "edgeId" in payload:
                raise InvariantError("消息不得指定下游边（不变量 M1）")
            ids = []
            for _sid, target in self._subs.get(topic_id, []):
                gid = target[0]
                inst = self._instances.get(gid)
                if inst is None or inst.status == "CLOSED":
                    # CLOSED 是终态：投递只会制造永不到达的死信，
                    # 静默排队会让 queue 深度永远非零 —— 跳过。
                    # PAUSED 仍接收（恢复后会消费），仅 CLOSED 被过滤。
                    continue
                # 每个订阅者拿独立 payload 副本
                ids.append(
                    self._new_message(target, dict(payload),
                                      callback=callback, topic=topic_id)
                )
            return ids[0] if ids else ""

    def _new_message(self, target, payload, *, callback=None, topic=None,
                     mkind="DATA", exit_port=None) -> str:
        with self._lock:
            mid = self._nid("msg")
            self._messages[mid] = _Message(
                mid=mid, target=target, payload=payload, callback=callback,
                topic=topic, mkind=mkind, exit_port=exit_port,
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

    # ---- 调度：选取/claim 在锁内，执行在锁外 ------------------------------

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
                    batch = self._select_for_strategy(inst, node_id, node)
                    if batch is None:
                        continue                  # 未就绪，让给别的消息
                    for m in batch:
                        m.state = "CLAIMED"
                    ev = node.get("evaluator") or {}
                    if ev.get("kind") == "model":
                        # 模型驱动的判断也是一次执行，必须走三段式在锁外跑
                        eid = self._claim(inst, node_id, node, batch,
                                          spec_id=ev["spec"])
                        unit = _Unit("model_strategy", inst, node_id, node,
                                     batch=batch, execution_id=eid)
                    else:
                        unit = _Unit("strategy", inst, node_id, node, batch=batch)
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
                            # 模型的输出提案 → decision.emit，其余一律不接受
                            self._handle_strategy(
                                unit.inst, unit.node_id, unit.node, unit.batch,
                                decision={"emit": {p: pl for p, pl in result.emissions}},
                                trusted=False,
                            )
                        except InvariantError:
                            self._release(unit.execution_id, "FAILED",
                                          reason="APPLY_REJECTED")
            elif unit.kind == "strategy":
                with self._lock:
                    self._handle_strategy(unit.inst, unit.node_id, unit.node,
                                          unit.batch)
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

    # ---- evaluator 守门（第一不变量在策略节点上的落点）---------------------

    #: evaluator 允许返回的顶层键。模型驱动时更窄，见 _guard_decision。
    #: 内核注入的工具名，卡片不得占用（#8）
    KERNEL_TOOL_NAMES = frozenset({"emit", "read_artifact", "publish", "spawn"})

    DECISION_KEYS = frozenset({"emit", "items", "annotate"})
    MODEL_DECISION_KEYS = frozenset({"emit"})

    def _guard_decision(self, node, policy, decision, *, trusted: bool):
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

        declared = set(node.get("endpoints", {}))
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
                         decision=None, trusted=True) -> None:
        tpl = self._templates[inst.template_ref]
        for m in batch:
            m.state = "CLAIMED"
        payloads = {m.target[2]: m.payload for m in batch}
        policy = self._policies[node["policy"]]

        if decision is None:
            evaluator = self._handlers.get(node.get("handler"))
            decision = (
                evaluator(payloads, self._node_ctx(inst, node_id)) if evaluator else {}
            ) or {}
        decision = self._guard_decision(node, policy, decision, trusted=trusted)

        out_policy = policy.get("output", {})
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

    def _instance_busy(self, gid: str) -> bool:
        """该实例是否仍有未完成的工作（QUEUED/CLAIMED/AWAITING 消息）。

        WARM_POOL 复用前的隔离检查：池实例忙时不复用，
        避免上一调用的遗留消息混入新调用（复用状态污染的来源）。
        """
        return any(
            m.target[0] == gid and m.state in ("QUEUED", "CLAIMED", "AWAITING")
            for m in self._messages.values()
        )

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

        # 回程端口由 slot.exit 声明（#9）；未声明时退回 "reply" 兼容默认
        back = msg.exit_port or "reply"
        if back in outputs and msg.callback is not None:
            self._emit_reply(inst, gid, node_id, msg,
                             outputs.pop(back), where=f"{gid}/{node_id}")

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

    def _route(self, inst, tpl, node_id, port, payload) -> list[str]:
        """边路由 —— 两段式，fan-out 原子（边界 B5b）。

        第一段（纯函数）：对全部匹配边完成地址解析、源契约校验、
        Servo、目标契约校验，只收集结果，不产生任何消息；
        任一边失败 → 整个 fan-out 失败，零副作用（由调用方决定
        如何释放执行并进图）。第二段（物化）：全部通过后统一创建消息。
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

        traversed = []
        for eid, tgt_node, tgt_ep, out in prepared:
            self._new_message((inst.gid, tgt_node, tgt_ep), out)
            traversed.append(eid)
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
        allowed = rec.request.output_contract.allowed_emit_ports
        outputs: dict[str, Any] = {}
        for port, payload in result.emissions:
            if port not in allowed and port != "reply":
                raise InvariantError(f"agent emitted undeclared port: {port}")
            outputs[port] = payload

        produced: list[str] = []
        for kind_, oid, body in result.artifacts:
            if kind_ in self.store.KERNEL_KINDS or                     oid.startswith("run/") or oid.startswith("annotation/"):
                raise InvariantError(
                    f"backend 不得提交内核保留对象：kind={kind_!r} oid={oid!r}；"
                    f"内核 kind 与 run//annotation/ 前缀归内核，"
                    f"用户 kind（plan/spec/…）自由")
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
                payload = outputs.pop("reply")
                cb_inst = self._instances.get(cb[0])
                if cb_inst is None or cb_inst.status != "OPEN":
                    # 终态气密（R13）：目标已关闭/不存在，不滞留死信
                    raise InvariantError(
                        f"REPLY 目标 {cb[0]} 已 {cb_inst.status if cb_inst else '不存在'}，"
                        f"拒绝提交回程消息")
                self._new_message(cb, payload, mkind="REPLY")
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

    # ---- 错误分类与失败如何进入图（#7）-----------------------------------
    #
    #   CANCELLED / BUDGET  不可重试 —— 是意图，不是故障
    #   INVALID_OUTPUT      执行面内已重试过，到这里算耗尽
    #   FAILED              按 max_attempts 重试
    #
    # 重试耗尽后：若节点声明了 on_error 端点，错误**沿边进入图**，
    # 由策略节点决定怎么办；否则消息进 FAILED 终态，不再被调度。

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

    def append_context_tail(self, gid: str, node_id: str, ref: str) -> None:
        """运行期发现的卡片追加到该实例的 tail。不回写模板。"""
        with self._lock:
            self._instances[gid].nodes[node_id].tail.append(ref)

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
        ov = self.store.put(oid, kind, body, provenance)
        # 每条 RunSnapshot 恰好对应一次提交 —— 持久化挂在这里，一处覆盖全部提交路径
        if kind == "run" and self.on_commit is not None:
            self.on_commit(self, ov)
        return ov

    def artifact_versions(self, oid) -> list[int]:
        return [ov.version for ov in self.store.history(oid)]

    def artifact(self, oid, version) -> Mapping[str, Any]:
        return self.store.get(oid, version).body

    def annotations(self, gid) -> Sequence[ObjectVersion]:
        """Annotation 就是 kind="annotation" 的 ObjectVersion。"""
        return self.store.history(f"annotation/{gid}")

    def estimate_tokens(self, ctx: InvocationContext) -> int:
        blob = "".join(str(x) for x in (ctx.head, ctx.messages, ctx.tail, ctx.transient))
        return self.estimate_text_tokens(blob)

    def estimate_text_tokens(self, text: str) -> int:
        """粗略估算。CJK 与拉丁字符的 token 密度差好几倍，分开算。

        系数由 `test_context_budget.py` 的校准用例对着真实 usage 量出来，
        不是拍的。改系数前先跑那条。
        """
        cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿"
                  or "豈" <= ch <= "﫿"
                  or "぀" <= ch <= "ヿ")
        return int(cjk / self.cjk_chars_per_token
                   + (len(text) - cjk) / self.chars_per_token)

    # ---- 上下文预算：分配与降级 ------------------------------------------

    def estimate_spec_tokens(self, spec: Mapping[str, Any]) -> int:
        """system prompt 与工具 schema 也占输入预算 —— 漏算它们会系统性低估。"""
        blob = str(spec.get("systemPrompt") or "")
        blob += json.dumps(spec.get("tools") or [], ensure_ascii=False, default=repr)
        return self.estimate_text_tokens(blob)

    def _fit_context(self, ctx: InvocationContext, budget: int | None,
                     *, gid: str, node_id: str, overhead: int = 0):
        """把上下文裁到预算内。

        **head 永不裁剪** —— 它是实例化时固定的引用，动它等于换任务。
        head 自己就超预算 ⇒ 图切分过粗，直接失败，不要悄悄降级。

        其余按 `truncation_order` 依次砍**最旧**的。每次裁剪产生一条告警，
        与压缩同级 —— 都是"这个节点承担的任务过大"的信号。
        """
        if budget is None:
            return ctx, []
        head_only = InvocationContext(head=ctx.head)
        head_tokens = self.estimate_tokens(head_only) + overhead
        if head_tokens > budget:
            raise InvariantError(
                f"{gid}/{node_id}：head + spec 开销 {head_tokens} tokens 已超预算 {budget}；"
                f"head 不可裁剪（图切分过粗，应拆分节点）"
            )
        trims: list[dict[str, Any]] = []
        cur = ctx
        for section in self.truncation_order:
            keep = self.min_keep.get(section, 0)
            while self.estimate_tokens(cur) + overhead > budget:
                items = getattr(cur, section)
                if len(items) <= keep:
                    break
                trims.append({
                    "section": section,
                    "dropped_index": len(trims),
                    "approx_tokens": self.estimate_text_tokens(str(items[0])),
                })
                cur = replace(cur, **{section: tuple(items[1:])})   # 砍最旧
            if self.estimate_tokens(cur) + overhead <= budget:
                break
        if self.estimate_tokens(cur) + overhead > budget:
            raise InvariantError(
                f"{gid}/{node_id}：裁到无可再裁仍超预算"
                f"（{self.estimate_tokens(cur) + overhead} > {budget}，"
                f"其中 spec 开销 {overhead}）"
            )
        return cur, trims

    def queue(self, topic_id) -> QueueView:
        with self._lock:
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
            body = ov.body
            u = body.get("usage")
            if isinstance(u, Mapping) and u.get("compactions"):
                out.append({
                    "kind": "compaction",
                    "node": body.get("node"),
                    "execution": body.get("execution"),
                    "compactions": u["compactions"],
                    "reason": "上下文压缩发生 —— 该节点承担的任务过大，应拆分",
                })
            trims = body.get("context_trims") or []
            if trims:
                out.append({
                    "kind": "truncation",
                    "node": body.get("node"),
                    "execution": body.get("execution"),
                    "trims": list(trims),
                    "reason": "为塞进预算裁剪了上下文 —— 与压缩同级的失败信号",
                })
        return out

    def commit_seq(self, gid): return self._instances[gid].seq

    # 注：没有 fork_from_checkpoint。
    # fork = 用某条 Annotation 的 object_refs 作为 params 调 instantiate()。
