"""Executable discussion specification for Nodeflow Runtime V2.

The model deliberately stores callback waiting on CALL messages and keeps
strategy state inside node instances. It is a discussion simulator, not a
durable distributed scheduler.
"""

from __future__ import annotations

import hashlib
import json
import threading
from copy import deepcopy
from dataclasses import dataclass, field
from itertools import count
from typing import Any, Callable, Iterable, Mapping


class InvariantError(RuntimeError):
    pass


class AuthorizationError(InvariantError):
    pass


class _CommitDeferred(RuntimeError):
    pass


@dataclass(frozen=True)
class MessageDraft:
    operation: str
    payload: Mapping[str, Any]
    tags: frozenset[str] = frozenset()

    @classmethod
    def push(
        cls,
        payload: Mapping[str, Any],
        *,
        tags: Iterable[str] = (),
    ) -> "MessageDraft":
        return cls("PUSH", deepcopy(dict(payload)), frozenset(tags))


@dataclass
class MessageInstance:
    id: str
    container_id: str
    origin_graph_instance_id: str
    target_graph_instance_id: str
    target_endpoint: str
    operation: str
    payload: dict[str, Any]
    tags: frozenset[str]
    delivery_state: str = "QUEUED"
    callback_state: str = "NONE"
    reply_target: str | None = None
    reply_target_graph_instance_id: str | None = None
    reply_to_message_id: str | None = None
    reply_message_id: str | None = None
    source_endpoint: str | None = None
    causation_ids: frozenset[str] = frozenset()
    queue_instance_id: str | None = None
    actor_id: str | None = None


@dataclass
class QueueInstance:
    id: str
    container_id: str
    template_id: str
    message_ids: list[str] = field(default_factory=list)


@dataclass
class GraphInstance:
    id: str
    container_id: str
    template_id: str
    parent_graph_instance_id: str | None = None
    status: str = "OPEN"
    queue_bindings: dict[str, str] = field(default_factory=dict)
    context_head: tuple[str, ...] = ()
    context_tail: list[str] = field(default_factory=list)
    node_state: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class ContainerInstance:
    id: str
    template_id: str
    owner_id: str
    graph_ids: list[str] = field(default_factory=list)
    queue_ids: list[str] = field(default_factory=list)
    assets: dict[str, Any] = field(default_factory=dict)


@dataclass
class _Selection:
    batch: dict[str, list[MessageInstance]]
    selected: list[MessageInstance]
    claimed: list[MessageInstance]
    context: dict[str, Any]


class RuntimeHarness:
    def __init__(self) -> None:
        self._container_templates: dict[str, dict[str, Any]] = {}
        self._graph_templates: dict[str, dict[str, Any]] = {}
        self._queue_templates: dict[str, dict[str, Any]] = {}
        self._policies: dict[str, dict[str, Any]] = {}
        self._handlers: dict[str, Callable[[dict, dict], Mapping[str, Any]]] = {}
        self._containers: dict[str, ContainerInstance] = {}
        self._graphs: dict[str, GraphInstance] = {}
        self._queues: dict[str, QueueInstance] = {}
        self._messages: dict[str, MessageInstance] = {}
        self._node_locks: dict[tuple[str, str], threading.Lock] = {}
        self._ids = count(1)
        self._lock = threading.RLock()
        self._state_changed = threading.Condition(self._lock)

    def _next_id(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids)}"

    def register_container_template(self, spec: Mapping[str, Any]) -> str:
        with self._lock:
            template = deepcopy(dict(spec))
            template_id = self._required(template, "templateId")
            self._put_new(self._container_templates, template_id, template)
            return template_id

    def register_graph_template(self, spec: Mapping[str, Any]) -> str:
        with self._lock:
            template = deepcopy(dict(spec))
            template_id = self._required(template, "templateId")
            nodes = template.get("nodes", {})
            if not isinstance(nodes, dict) or not nodes:
                raise InvariantError("graph template requires nodes")
            closure_policy = template.get("closurePolicy")
            if closure_policy is not None:
                if not closure_policy.get("tag"):
                    raise InvariantError("closurePolicy requires tag")
                if closure_policy.get("mode", "DRAIN") != "DRAIN":
                    raise InvariantError("only closurePolicy mode DRAIN is supported")
            for node_id, node in nodes.items():
                kind = node.get("kind")
                if kind not in {
                    "start",
                    "end",
                    "checkpoint",
                    "ordinary",
                    "agent",
                    "strategy",
                    "subflow",
                    "sink",
                }:
                    raise InvariantError(f"unsupported node kind: {kind}")
                if not self._declared_endpoints(node):
                    raise InvariantError(f"node requires at least one endpoint: {node_id}")
                emit_endpoint = node.get("emitEndpoint")
                if emit_endpoint and emit_endpoint not in self._declared_endpoints(node):
                    raise InvariantError(
                        f"node emitEndpoint is undeclared: {node_id}.{emit_endpoint}"
                    )
                if kind in {"ordinary", "agent", "strategy"} and not node.get(
                    "handler"
                ):
                    raise InvariantError(f"node requires handler: {node_id}")
                if kind == "strategy":
                    policy_id = node.get("policy")
                    policy = self._policies.get(policy_id)
                    if policy is None:
                        raise InvariantError(
                            f"strategy references unknown policy: {policy_id}"
                        )
                    self._validate_policy_for_node(node_id, node, policy)
            for edge in template.get("edges", []):
                self._validate_endpoint_ref(nodes, edge.get("from"), output=True)
                operation = edge.get("operation", "PUSH")
                self._validate_endpoint_ref(
                    nodes,
                    edge.get("to"),
                    output=False,
                    operation=operation,
                )
                if operation not in {"PUSH", "CALL"}:
                    raise InvariantError("edge operation must be PUSH or CALL")
                if operation == "CALL":
                    reply_target = edge.get("replyTarget")
                    if reply_target is None:
                        raise InvariantError("CALL edge requires replyTarget")
                    self._validate_endpoint_ref(
                        nodes,
                        reply_target,
                        output=False,
                        operation="REPLY",
                    )
            for slot_id, slot in template.get("queueSlots", {}).items():
                if not slot.get("queueTemplateId"):
                    raise InvariantError(
                        f"queue slot requires queueTemplateId: {slot_id}"
                    )
                self._validate_endpoint_ref(
                    nodes,
                    slot.get("target"),
                    output=False,
                    operation="PUSH",
                )
            self._put_new(self._graph_templates, template_id, template)
            return template_id

    def register_queue_template(self, spec: Mapping[str, Any]) -> str:
        with self._lock:
            template = deepcopy(dict(spec))
            template_id = self._required(template, "templateId")
            self._put_new(self._queue_templates, template_id, template)
            return template_id

    def register_policy(self, policy_id: str, spec: Mapping[str, Any]) -> str:
        with self._lock:
            policy = deepcopy(dict(spec))
            self._validate_policy(policy)
            self._put_new(self._policies, policy_id, policy)
            return policy_id

    def register_handler(
        self,
        handler_id: str,
        handler: Callable[[dict, dict], Mapping[str, Any]],
    ) -> str:
        with self._lock:
            self._put_new(self._handlers, handler_id, handler)
            return handler_id

    def create_container(
        self,
        template_id: str,
        container_id: str,
        *,
        owner_id: str,
    ) -> str:
        with self._lock:
            if template_id not in self._container_templates:
                raise InvariantError(f"unknown container template: {template_id}")
            self._put_new(
                self._containers,
                container_id,
                ContainerInstance(container_id, template_id, owner_id),
            )
            return container_id

    def create_graph_instance(
        self,
        container_id: str,
        graph_template_id: str,
        graph_instance_id: str,
        *,
        queue_bindings: Mapping[str, str] | None = None,
        parent_graph_instance_id: str | None = None,
        context_head: Iterable[str] = (),
    ) -> str:
        with self._lock:
            container = self._container(container_id)
            template = self._graph_template(graph_template_id)
            allowed = self._container_templates[container.template_id].get(
                "allowedGraphTemplates", []
            )
            if allowed and graph_template_id not in allowed:
                raise AuthorizationError(
                    f"container template does not allow graph: {graph_template_id}"
                )
            if parent_graph_instance_id is not None:
                parent_graph = self._open_graph_instance(parent_graph_instance_id)
                if parent_graph.container_id != container_id:
                    raise InvariantError("parent graph instance belongs to another container")
            bindings = dict(queue_bindings or {})
            self._validate_queue_bindings(container_id, template, bindings)
            head = tuple(context_head)
            for asset_id in head:
                if asset_id not in container.assets:
                    raise InvariantError(f"unknown context head asset: {asset_id}")
            graph = GraphInstance(
                id=graph_instance_id,
                container_id=container_id,
                template_id=graph_template_id,
                parent_graph_instance_id=parent_graph_instance_id,
                queue_bindings=bindings,
                context_head=head,
                node_state={node_id: {} for node_id in template["nodes"]},
            )
            self._put_new(self._graphs, graph_instance_id, graph)
            for node_id in template["nodes"]:
                self._node_locks[(graph_instance_id, node_id)] = threading.Lock()
            container.graph_ids.append(graph_instance_id)
            return graph_instance_id

    def append_context_tail(
        self,
        graph_instance_id: str,
        asset_id: str,
        *,
        actor_id: str,
    ) -> None:
        with self._lock:
            graph = self._open_graph_instance(graph_instance_id)
            container = self._container(graph.container_id)
            if actor_id != container.owner_id:
                raise AuthorizationError("only the owning container may append context")
            if asset_id not in container.assets:
                raise InvariantError(f"unknown context tail asset: {asset_id}")
            if asset_id not in graph.context_tail:
                graph.context_tail.append(asset_id)

    def bind_queue(
        self,
        graph_instance_id: str,
        slot_id: str,
        queue_instance_id: str,
        *,
        actor_id: str,
    ) -> None:
        with self._lock:
            graph = self._open_graph_instance(graph_instance_id)
            container = self._container(graph.container_id)
            if actor_id != container.owner_id:
                raise AuthorizationError("only the owning container may bind queues")
            if slot_id in graph.queue_bindings:
                raise InvariantError(f"queue slot is already bound: {slot_id}")
            template = self._graph_template(graph.template_id)
            self._validate_queue_bindings(
                graph.container_id,
                template,
                {slot_id: queue_instance_id},
            )
            graph.queue_bindings[slot_id] = queue_instance_id

    def bind_subflow(
        self,
        parent_graph_instance_id: str,
        node_id: str,
        child_graph_instance_id: str,
        target_endpoint: str,
        *,
        return_endpoint: str,
        actor_id: str,
    ) -> None:
        with self._lock:
            parent_graph = self._open_graph_instance(parent_graph_instance_id)
            child_graph = self._open_graph_instance(child_graph_instance_id)
            container = self._container(parent_graph.container_id)
            if actor_id != container.owner_id:
                raise AuthorizationError("only the owning container may bind subflows")
            if child_graph.container_id != parent_graph.container_id:
                raise InvariantError("subflow child belongs to another container")
            if child_graph.parent_graph_instance_id != parent_graph_instance_id:
                raise InvariantError(
                    "subflow child is not owned by the parent graph instance"
                )
            parent_template = self._graph_template(parent_graph.template_id)
            node = parent_template["nodes"].get(node_id)
            if node is None or node.get("kind") != "subflow":
                raise InvariantError("subflow binding target is not a subflow node")
            return_node_id, _ = self._split_endpoint(return_endpoint)
            if return_node_id != node_id:
                raise InvariantError("subflow return endpoint must belong to the same node")
            self._validate_endpoint_ref(
                parent_template["nodes"],
                return_endpoint,
                output=False,
                operation="REPLY",
            )
            self._validate_endpoint_ref(
                self._graph_template(child_graph.template_id)["nodes"],
                target_endpoint,
                output=False,
                operation="CALL",
            )
            self._authorize_control_message(
                child_graph_instance_id,
                target_endpoint,
                (),
                actor_id=None,
            )
            node_state = parent_graph.node_state[node_id]
            if "subflowBinding" in node_state:
                raise InvariantError("subflow node is already bound")
            node_state["subflowBinding"] = {
                "childGraphInstanceId": child_graph_instance_id,
                "targetEndpoint": target_endpoint,
                "returnEndpoint": return_endpoint,
            }

    def create_queue(
        self,
        container_id: str,
        queue_template_id: str,
        queue_instance_id: str,
    ) -> str:
        with self._lock:
            container = self._container(container_id)
            if queue_template_id not in self._queue_templates:
                raise InvariantError(f"unknown queue template: {queue_template_id}")
            queue = QueueInstance(queue_instance_id, container_id, queue_template_id)
            self._put_new(self._queues, queue_instance_id, queue)
            container.queue_ids.append(queue_instance_id)
            return queue_instance_id

    def register_asset(
        self,
        container_id: str,
        asset_id: str,
        content: Any,
    ) -> str:
        with self._lock:
            container = self._container(container_id)
            if asset_id in container.assets:
                raise InvariantError(f"asset already exists: {asset_id}")
            container.assets[asset_id] = deepcopy(content)
            return asset_id

    def send(
        self,
        graph_instance_id: str,
        target_endpoint: str,
        draft: MessageDraft,
        *,
        actor_id: str | None = None,
    ) -> str:
        with self._lock:
            if draft.operation != "PUSH":
                raise InvariantError("public ingress accepts PUSH only; use call/reply APIs")
            graph = self._open_graph_instance(graph_instance_id)
            template = self._graph_template(graph.template_id)
            self._validate_endpoint_ref(
                template["nodes"],
                target_endpoint,
                output=False,
                operation="PUSH",
            )
            self._authorize_control_message(
                graph_instance_id,
                target_endpoint,
                draft.tags,
                actor_id,
            )
            message = self._new_message(
                origin_graph_instance_id=graph_instance_id,
                target_graph_instance_id=graph_instance_id,
                target_endpoint=target_endpoint,
                operation=draft.operation,
                payload=draft.payload,
                tags=draft.tags,
                actor_id=actor_id,
            )
            return message.id

    def call(
        self,
        source_graph_instance_id: str,
        target_graph_instance_id: str,
        target_endpoint: str,
        payload: Mapping[str, Any],
        reply_target: str,
    ) -> str:
        with self._lock:
            source_graph = self._open_graph_instance(source_graph_instance_id)
            target_graph = self._open_graph_instance(target_graph_instance_id)
            if source_graph.container_id != target_graph.container_id:
                raise InvariantError("cross-container CALL is outside the V2 harness")
            self._validate_endpoint_ref(
                self._graph_template(target_graph.template_id)["nodes"],
                target_endpoint,
                output=False,
                operation="CALL",
            )
            self._authorize_control_message(
                target_graph_instance_id,
                target_endpoint,
                (),
                actor_id=None,
            )
            self._validate_endpoint_ref(
                self._graph_template(source_graph.template_id)["nodes"],
                reply_target,
                output=False,
                operation="REPLY",
            )
            message = self._new_message(
                origin_graph_instance_id=source_graph_instance_id,
                target_graph_instance_id=target_graph_instance_id,
                target_endpoint=target_endpoint,
                operation="CALL",
                payload=payload,
                tags=(),
                callback_state="WAITING",
                reply_target=reply_target,
                reply_target_graph_instance_id=source_graph_instance_id,
            )
            return message.id

    def reply(
        self,
        source_graph_instance_id: str,
        call_message_id: str,
        payload: Mapping[str, Any],
    ) -> str:
        with self._lock:
            call = self._message(call_message_id)
            return self._resolve_call(source_graph_instance_id, call, payload).id

    def queue_send(
        self,
        graph_instance_id: str,
        slot_id: str,
        payload: Mapping[str, Any],
    ) -> str:
        with self._lock:
            graph = self._open_graph_instance(graph_instance_id)
            template = self._graph_template(graph.template_id)
            slot = template.get("queueSlots", {}).get(slot_id)
            if slot is None:
                raise InvariantError(f"unknown queue slot: {slot_id}")
            queue_id = graph.queue_bindings.get(slot_id)
            if queue_id is None:
                raise InvariantError(f"queue slot is unresolved: {slot_id}")
            queue = self._queue(queue_id)
            self._authorize_control_message(
                graph_instance_id,
                slot["target"],
                (),
                actor_id=None,
            )
            message = self._new_message(
                origin_graph_instance_id=graph_instance_id,
                target_graph_instance_id=graph_instance_id,
                target_endpoint=slot["target"],
                operation="PUSH",
                payload=payload,
                tags=(),
                queue_instance_id=queue_id,
            )
            queue.message_ids.append(message.id)
            return message.id

    def step(self, graph_instance_id: str, *, max_commits: int = 1) -> int:
        if max_commits < 1:
            return 0
        commits = 0
        while commits < max_commits:
            with self._lock:
                graph = self._graph(graph_instance_id)
                if graph.status != "OPEN":
                    return commits
                template = self._graph_template(graph.template_id)
                nodes = template["nodes"]
                ordered_nodes = [
                    (node_id, node)
                    for node_id, node in nodes.items()
                    if node.get("kind") != "end"
                ] + [
                    (node_id, node)
                    for node_id, node in nodes.items()
                    if node.get("kind") == "end"
                ]

            progressed = False
            for node_id, node in ordered_nodes:
                node_lock = self._node_locks[(graph_instance_id, node_id)]
                if not node_lock.acquire(blocking=False):
                    continue
                try:
                    with self._lock:
                        graph = self._graph(graph_instance_id)
                        if graph.status != "OPEN":
                            return commits
                        template = self._graph_template(graph.template_id)
                        selection = self._select_for_node(
                            graph_instance_id,
                            template,
                            node_id,
                            node,
                        )
                        if selection is None:
                            continue
                        for message in selection.claimed:
                            if message.delivery_state != "QUEUED":
                                raise InvariantError("selected message is no longer queued")
                            message.delivery_state = "CLAIMED"
                    try:
                        self._execute_claimed_node(
                            graph_instance_id,
                            graph,
                            template,
                            node_id,
                            node,
                            selection,
                        )
                    except _CommitDeferred:
                        with self._lock:
                            self._rollback_claim(selection)
                            self._state_changed.notify_all()
                        continue
                    except BaseException:
                        with self._lock:
                            self._rollback_claim(selection)
                            self._state_changed.notify_all()
                        raise
                    commits += 1
                    progressed = True
                    break
                finally:
                    node_lock.release()
            if not progressed:
                break
        return commits

    def drain(self, *graph_instance_ids: str) -> None:
        for _ in range(10000):
            progressed = sum(
                self.step(graph_instance_id)
                for graph_instance_id in graph_instance_ids
            )
            if progressed == 0:
                with self._state_changed:
                    has_in_flight = any(
                        message.target_graph_instance_id in graph_instance_ids
                        and message.delivery_state == "CLAIMED"
                        for message in self._messages.values()
                    )
                    if not has_in_flight:
                        if self._has_selectable_work(graph_instance_ids):
                            continue
                        return
                    self._state_changed.wait(timeout=1)
        raise InvariantError("drain exceeded 10000 commits")

    def message(self, message_id: str) -> MessageInstance:
        with self._lock:
            return deepcopy(self._message(message_id))

    def messages(
        self,
        graph_instance_id: str,
        *,
        target_endpoint: str | None = None,
        tag: str | None = None,
    ) -> list[MessageInstance]:
        with self._lock:
            result = [
                message
                for message in self._messages.values()
                if message.target_graph_instance_id == graph_instance_id
                and (target_endpoint is None or message.target_endpoint == target_endpoint)
                and (tag is None or tag in message.tags)
            ]
            return deepcopy(result)

    def graph_instance(self, graph_instance_id: str) -> GraphInstance:
        with self._lock:
            return deepcopy(self._graph(graph_instance_id))

    def node_state(self, graph_instance_id: str, node_id: str) -> dict[str, Any]:
        with self._lock:
            graph = self._graph(graph_instance_id)
            try:
                return deepcopy(graph.node_state[node_id])
            except KeyError as exc:
                raise InvariantError(f"unknown node: {node_id}") from exc

    def graph_template(self, template_id: str) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._graph_template(template_id))

    def graph_template_fingerprint(self, template_id: str) -> str:
        with self._lock:
            encoded = json.dumps(
                self._graph_template(template_id),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            return hashlib.sha256(encoded).hexdigest()

    def queues(self, container_id: str) -> list[QueueInstance]:
        with self._lock:
            container = self._container(container_id)
            return deepcopy([self._queues[queue_id] for queue_id in container.queue_ids])

    def snapshot_container(self, container_id: str) -> dict[str, Any]:
        with self._lock:
            container = self._container(container_id)
            graphs: dict[str, Any] = {}
            for graph_id in container.graph_ids:
                graph = self._graphs[graph_id]
                graphs[graph_id] = {
                    "templateId": graph.template_id,
                    "parentGraphInstanceId": graph.parent_graph_instance_id,
                    "status": graph.status,
                    "queueBindings": deepcopy(graph.queue_bindings),
                    "context": {
                        "head": list(graph.context_head),
                        "tail": list(graph.context_tail),
                    },
                    "nodes": deepcopy(graph.node_state),
                }
            messages = {
                message.id: {
                    "originGraphInstanceId": message.origin_graph_instance_id,
                    "targetGraphInstanceId": message.target_graph_instance_id,
                    "targetEndpoint": message.target_endpoint,
                    "operation": message.operation,
                    "deliveryState": message.delivery_state,
                    "payload": deepcopy(message.payload),
                    "tags": sorted(message.tags),
                    "replyToMessageId": message.reply_to_message_id,
                    "callback": {
                        "state": message.callback_state,
                        "replyTarget": message.reply_target,
                        "replyTargetGraphInstanceId": (
                            message.reply_target_graph_instance_id
                        ),
                        "replyMessageId": message.reply_message_id,
                    },
                }
                for message in self._messages.values()
                if message.container_id == container_id
            }
            return {
                "container": {
                    "id": container.id,
                    "templateId": container.template_id,
                    "ownerId": container.owner_id,
                },
                "graphs": graphs,
                "messages": messages,
                "queues": {
                    queue_id: {
                        "templateId": self._queues[queue_id].template_id,
                        "messageIds": list(self._queues[queue_id].message_ids),
                    }
                    for queue_id in container.queue_ids
                },
                "assets": deepcopy(container.assets),
            }

    def _select_for_node(
        self,
        graph_instance_id: str,
        template: dict[str, Any],
        node_id: str,
        node: dict[str, Any],
    ) -> _Selection | None:
        kind = node.get("kind")
        queued_by_input = self._queued_by_input(graph_instance_id, node_id, node)
        if kind == "strategy":
            return self._select_strategy(node, queued_by_input)
        if kind == "end":
            candidates = [
                message
                for messages in queued_by_input.values()
                for message in messages
                if self._is_close_message(template, message)
            ]
            if not candidates or not self._can_close(
                graph_instance_id, {message.id for message in candidates}
            ):
                return None
            batch: dict[str, list[MessageInstance]] = {}
            for message in candidates:
                batch.setdefault(self._endpoint_name(message.target_endpoint), []).append(
                    message
                )
            return _Selection(batch, candidates, candidates, {})
        candidates = [
            message for messages in queued_by_input.values() for message in messages
        ]
        if not candidates:
            return None
        message = candidates[0]
        endpoint = self._endpoint_name(message.target_endpoint)
        return _Selection({endpoint: [message]}, [message], [message], {})

    def _select_strategy(
        self,
        node: dict[str, Any],
        queued_by_input: dict[str, list[MessageInstance]],
    ) -> _Selection | None:
        policy_id = node.get("policy")
        policy = self._policies.get(policy_id)
        if policy is None:
            raise InvariantError(f"unknown strategy policy: {policy_id}")
        selection = policy.get("selection", "FIRST")
        if policy.get("readiness") == "ALL_REQUIRED":
            required = policy.get("requiredInputs", node.get("inputs", []))
            if any(not queued_by_input.get(endpoint) for endpoint in required):
                return None
        elif not any(queued_by_input.values()):
            return None

        context: dict[str, Any] = {}
        if selection == "FIRST":
            endpoint, messages = next(
                (endpoint, messages)
                for endpoint, messages in queued_by_input.items()
                if messages
            )
            batch = {endpoint: [messages[0]]}
        elif selection == "TOP_ONE":
            candidates = [
                message for messages in queued_by_input.values() for message in messages
            ]
            rank_field = policy.get("rankField", "rank")
            selected = max(candidates, key=lambda message: message.payload[rank_field])
            batch = {self._endpoint_name(selected.target_endpoint): [selected]}
        elif selection == "ONE_PER_INPUT":
            required = policy.get("requiredInputs", node.get("inputs", []))
            batch = {endpoint: [queued_by_input[endpoint][0]] for endpoint in required}
        elif selection == "CROSS_ALL":
            required = policy.get("requiredInputs", node.get("inputs", []))
            if len(required) != 2:
                raise InvariantError("CROSS_ALL currently requires two inputs")
            left = list(queued_by_input[required[0]])
            right = list(queued_by_input[required[1]])
            batch = {required[0]: left, required[1]: right}
            context["crossPairs"] = [
                (left_message, right_message)
                for left_message in left
                for right_message in right
            ]
        else:
            raise InvariantError(f"unsupported strategy selection: {selection}")

        selected_messages = list(
            dict.fromkeys(
                message.id
                for messages in batch.values()
                for message in messages
            )
        )
        selected = [self._messages[message_id] for message_id in selected_messages]
        claimed = list(selected)
        if policy.get("unselected") == "DISCARD":
            selected_ids = {message.id for message in selected}
            for messages in queued_by_input.values():
                for message in messages:
                    if message.id not in selected_ids:
                        claimed.append(message)
        return _Selection(batch, selected, claimed, context)

    def _execute_claimed_node(
        self,
        graph_instance_id: str,
        graph: GraphInstance,
        template: dict[str, Any],
        node_id: str,
        node: dict[str, Any],
        selection: _Selection,
    ) -> None:
        kind = node.get("kind")
        selected = selection.selected
        batch = selection.batch
        checkpoint: dict[str, Any] | None = None
        subflow_call: dict[str, Any] | None = None
        subflow_outer_call_id: str | None = None
        output_causation: frozenset[str] | None = None
        outputs: Mapping[str, Any] | None = None
        if kind == "start":
            first = selected[0]
            outputs = {
                self._default_emit_endpoint(node): deepcopy(first.payload)
            }
        elif kind == "checkpoint":
            first = selected[0]
            checkpoint = {
                "lastObservedMessageId": first.id,
            }
            outputs = {
                self._default_emit_endpoint(node): deepcopy(first.payload)
            }
        elif kind in {"ordinary", "agent", "strategy"}:
            with self._lock:
                handler_id = node.get("handler")
                handler = self._handlers.get(handler_id)
                if handler is None:
                    raise InvariantError(f"unknown node handler: {handler_id}")
                context = self._build_context(
                    graph_instance_id,
                    graph,
                    template,
                    selected,
                    selection.context,
                )
            outputs = handler(deepcopy(batch), context)
        elif kind == "subflow":
            first = selected[0]
            with self._lock:
                binding = deepcopy(
                    graph.node_state[node_id].get("subflowBinding")
                )
            if binding is None:
                raise InvariantError("subflow node has no bound child instance")
            if first.operation == "REPLY":
                if first.target_endpoint != binding["returnEndpoint"]:
                    raise InvariantError("subflow reply arrived at the wrong endpoint")
                if first.reply_to_message_id is None:
                    raise InvariantError("subflow REPLY has no child CALL correlation")
                child_call = self._message(first.reply_to_message_id)
                outer_calls = [
                    self._message(message_id)
                    for message_id in child_call.causation_ids
                    if self._message(message_id).operation == "CALL"
                    and self._message(message_id).target_graph_instance_id
                    == graph_instance_id
                    and self._message(message_id).target_endpoint.startswith(
                        f"{node_id}."
                    )
                ]
                if len(outer_calls) > 1:
                    raise InvariantError("subflow child CALL has multiple outer CALLs")
                if outer_calls:
                    subflow_outer_call_id = outer_calls[0].id
                    outputs = None
                else:
                    outputs = {
                        node.get("returnOutput", "out"): deepcopy(first.payload)
                    }
            elif first.operation in {"PUSH", "CALL"}:
                subflow_call = binding
                outputs = None
            else:
                raise InvariantError(
                    f"subflow node cannot process operation: {first.operation}"
                )
        elif kind in {"sink", "end"}:
            outputs = None
        else:
            raise InvariantError(f"unsupported node kind: {kind}")

        with self._lock:
            node_state = graph.node_state[node_id]
            if graph.status != "OPEN":
                raise InvariantError("graph instance closed before node commit")
            node_state_before = deepcopy(node_state)
            graph_status_before = graph.status
            created_message_ids: list[str] = []
            outer_call_before = (
                deepcopy(self._message(subflow_outer_call_id))
                if subflow_outer_call_id is not None
                else None
            )
            try:
                if checkpoint is not None:
                    node_state["checkpoint"] = checkpoint
                if kind == "strategy":
                    outputs, output_causation = self._apply_strategy_output_policy(
                        graph,
                        graph_instance_id,
                        node_id,
                        node,
                        outputs,
                        selected,
                    )
                if kind == "end":
                    close_message_ids = {
                        message.id for message in selection.claimed
                    }
                    if not self._can_close(graph_instance_id, close_message_ids):
                        raise _CommitDeferred()
                    graph.status = "CLOSED"
                elif kind == "subflow" and subflow_call is not None:
                    first = selected[0]
                    child_graph_instance_id = subflow_call["childGraphInstanceId"]
                    self._open_graph_instance(child_graph_instance_id)
                    child_call = self._new_message(
                        origin_graph_instance_id=graph_instance_id,
                        target_graph_instance_id=child_graph_instance_id,
                        target_endpoint=subflow_call["targetEndpoint"],
                        source_endpoint=first.target_endpoint,
                        operation="CALL",
                        payload=first.payload,
                        tags=(),
                        callback_state="WAITING",
                        reply_target=subflow_call["returnEndpoint"],
                        reply_target_graph_instance_id=graph_instance_id,
                        causation_ids={message.id for message in selected},
                        actor_id=f"node:{node_id}",
                    )
                    created_message_ids.append(child_call.id)
                elif kind == "subflow" and subflow_outer_call_id is not None:
                    reply = self._resolve_call(
                        graph_instance_id,
                        self._message(subflow_outer_call_id),
                        selected[0].payload,
                    )
                    created_message_ids.append(reply.id)
                else:
                    self._emit_outputs(
                        graph_instance_id,
                        graph,
                        template,
                        node_id,
                        node,
                        outputs,
                        selected,
                        causation_ids=output_causation,
                        created_message_ids=created_message_ids,
                    )
                for message in selection.claimed:
                    if message.delivery_state != "CLAIMED":
                        raise InvariantError("message claim changed before commit")
                    message.delivery_state = "CONSUMED"
                self._state_changed.notify_all()
            except BaseException:
                graph.node_state[node_id] = node_state_before
                graph.status = graph_status_before
                for selected_message in selection.claimed:
                    live_message = self._messages.get(selected_message.id)
                    if live_message is not None:
                        live_message.delivery_state = "CLAIMED"
                if outer_call_before is not None:
                    live_outer_call = self._messages.get(outer_call_before.id)
                    if live_outer_call is not None:
                        live_outer_call.callback_state = outer_call_before.callback_state
                        live_outer_call.reply_message_id = outer_call_before.reply_message_id
                for message_id in created_message_ids:
                    self._messages.pop(message_id, None)
                for queue in self._queues.values():
                    queue.message_ids = [
                        message_id
                        for message_id in queue.message_ids
                        if message_id not in created_message_ids
                    ]
                raise

    def _rollback_claim(
        self,
        selection: _Selection,
    ) -> None:
        for selected_message in selection.claimed:
            message = self._message(selected_message.id)
            if message.delivery_state == "CLAIMED":
                message.delivery_state = "QUEUED"

    def _apply_strategy_output_policy(
        self,
        graph: GraphInstance,
        graph_instance_id: str,
        node_id: str,
        node: dict[str, Any],
        outputs: Mapping[str, Any] | None,
        selected: list[MessageInstance],
    ) -> tuple[Mapping[str, Any], frozenset[str] | None]:
        if not outputs:
            return {}, None
        policy_id = node.get("policy")
        policy = self._policies.get(policy_id)
        if policy is None:
            raise InvariantError(f"unknown strategy policy: {policy_id}")
        output_policy = policy.get("output", "EMIT_EACH")
        if output_policy == "EMIT_EACH":
            return outputs, None
        if not isinstance(output_policy, dict):
            raise InvariantError(f"unsupported output policy: {output_policy}")

        mode = output_policy.get("mode")
        if mode == "WAIT_ALL":
            required = output_policy.get("requiredOutputs", node.get("outputs", []))
            policy_state = graph.node_state[node_id].setdefault(
                "policyState", {}
            )
            staged = policy_state.setdefault("stagedOutputs", {})
            staged_causation = policy_state.setdefault("stagedCausationIds", [])
            for message in selected:
                if message.id not in staged_causation:
                    staged_causation.append(message.id)
            for output_name, raw in outputs.items():
                staged.setdefault(output_name, []).extend(
                    deepcopy(raw if isinstance(raw, list) else [raw])
                )
            if any(not staged.get(output_name) for output_name in required):
                return {}, None
            ready = {
                output_name: deepcopy(staged[output_name])
                for output_name in required
            }
            policy_state["stagedOutputs"] = {}
            causation = frozenset(staged_causation)
            policy_state["stagedCausationIds"] = []
            return ready, causation

        if mode == "CROSS":
            left_name = output_policy["left"]
            right_name = output_policy["right"]
            target_name = output_policy["target"]
            left_key = output_policy.get("leftKey", "left")
            right_key = output_policy.get("rightKey", "right")
            left_values = outputs.get(left_name, [])
            right_values = outputs.get(right_name, [])
            left_items = left_values if isinstance(left_values, list) else [left_values]
            right_items = (
                right_values if isinstance(right_values, list) else [right_values]
            )
            return ({
                target_name: [
                    {
                        left_key: deepcopy(left_item),
                        right_key: deepcopy(right_item),
                    }
                    for left_item in left_items
                    for right_item in right_items
                ]
            }, None)

        raise InvariantError(f"unsupported output policy mode: {mode}")

    def _emit_outputs(
        self,
        graph_instance_id: str,
        graph: GraphInstance,
        template: dict[str, Any],
        node_id: str,
        node: dict[str, Any],
        outputs: Mapping[str, Any] | None,
        selected: list[MessageInstance],
        *,
        causation_ids: frozenset[str] | None = None,
        created_message_ids: list[str] | None = None,
    ) -> None:
        if not outputs:
            return
        edges = template.get("edges", [])
        causation = (
            set(causation_ids)
            if causation_ids is not None
            else {message.id for message in selected}
        )
        for output_name, raw in outputs.items():
            source_ref = f"{node_id}.{output_name}"
            matching_edges = [edge for edge in edges if edge.get("from") == source_ref]
            if not matching_edges:
                continue
            drafts = raw if isinstance(raw, list) else [raw]
            for item in drafts:
                payload, tags, item_causation = self._output_item(item)
                effective_causation = (
                    causation if item_causation is None else set(item_causation)
                )
                if not effective_causation.issubset(causation):
                    raise InvariantError(
                        "node output causation must reference claimed inputs only"
                    )
                for edge in matching_edges:
                    transformed = self._apply_servo(payload, edge.get("servo"))
                    actor_id = (
                        f"strategy:{node_id}"
                        if node.get("kind") == "strategy"
                        else f"node:{node_id}"
                    )
                    self._authorize_control_message(
                        graph_instance_id,
                        edge["to"],
                        tags,
                        actor_id,
                    )
                    operation = edge.get("operation", "PUSH")
                    if self._is_close_tags(template, tags) and operation != "PUSH":
                        raise InvariantError("close control messages must use PUSH")
                    callback_state = "WAITING" if operation == "CALL" else "NONE"
                    emitted = self._new_message(
                        origin_graph_instance_id=graph_instance_id,
                        target_graph_instance_id=graph_instance_id,
                        target_endpoint=edge["to"],
                        source_endpoint=source_ref,
                        operation=operation,
                        payload=transformed,
                        tags=tags,
                        causation_ids=effective_causation,
                        callback_state=callback_state,
                        reply_target=edge.get("replyTarget"),
                        reply_target_graph_instance_id=(
                            graph_instance_id if edge.get("replyTarget") else None
                        ),
                        actor_id=actor_id,
                    )
                    if created_message_ids is not None:
                        created_message_ids.append(emitted.id)

    def _build_context(
        self,
        graph_instance_id: str,
        graph: GraphInstance,
        template: dict[str, Any],
        selected: list[MessageInstance],
        selection_context: dict[str, Any],
    ) -> dict[str, Any]:
        container = self._container(graph.container_id)
        requested_assets: list[str] = []
        for message in selected:
            refs = message.payload.get("assetRefs", [])
            if isinstance(refs, list):
                for asset_id in refs:
                    if asset_id not in requested_assets:
                        requested_assets.append(asset_id)
        max_assets = template.get("contextPolicy", {}).get(
            "maxMessageAssets", len(requested_assets)
        )
        visible = []
        for asset_id in requested_assets[:max_assets]:
            if asset_id not in container.assets:
                raise InvariantError(f"unknown asset: {asset_id}")
            visible.append(asset_id)
        loaded_ids = list(
            dict.fromkeys([*graph.context_head, *visible, *graph.context_tail])
        )
        context = {
            "graphInstanceId": graph_instance_id,
            "headAssetIds": list(graph.context_head),
            "messageAssetIds": visible,
            "tailAssetIds": list(graph.context_tail),
            "assets": {
                asset_id: deepcopy(container.assets[asset_id])
                for asset_id in loaded_ids
            },
            "transient": {},
        }
        context.update(selection_context)
        return context

    def _queued_by_input(
        self,
        graph_instance_id: str,
        node_id: str,
        node: dict[str, Any],
    ) -> dict[str, list[MessageInstance]]:
        result = {endpoint: [] for endpoint in self._declared_endpoints(node)}
        prefix = f"{node_id}."
        for message in self._messages.values():
            if (
                message.target_graph_instance_id == graph_instance_id
                and message.delivery_state == "QUEUED"
                and message.target_endpoint.startswith(prefix)
            ):
                endpoint = self._endpoint_name(message.target_endpoint)
                if endpoint in result:
                    result[endpoint].append(message)
        return result

    def _can_close(
        self,
        graph_instance_id: str,
        close_message_ids: Iterable[str],
    ) -> bool:
        ignored_close_ids = set(close_message_ids)
        for message in self._messages.values():
            related = (
                message.origin_graph_instance_id == graph_instance_id
                or message.target_graph_instance_id == graph_instance_id
            )
            if not related:
                continue
            if message.id in ignored_close_ids:
                continue
            if message.callback_state == "WAITING":
                return False
            if message.delivery_state == "CLAIMED":
                return False
            if (
                message.target_graph_instance_id == graph_instance_id
                and message.delivery_state == "QUEUED"
                and message.id not in ignored_close_ids
            ):
                return False
        for child in self._graphs.values():
            if (
                child.parent_graph_instance_id == graph_instance_id
                and child.status == "OPEN"
            ):
                return False
        return True

    def _has_selectable_work(self, graph_instance_ids: Iterable[str]) -> bool:
        for graph_instance_id in graph_instance_ids:
            graph = self._graph(graph_instance_id)
            if graph.status != "OPEN":
                continue
            template = self._graph_template(graph.template_id)
            nodes = template["nodes"]
            ordered_nodes = [
                (node_id, node)
                for node_id, node in nodes.items()
                if node.get("kind") != "end"
            ] + [
                (node_id, node)
                for node_id, node in nodes.items()
                if node.get("kind") == "end"
            ]
            if any(
                self._select_for_node(graph_instance_id, template, node_id, node)
                is not None
                for node_id, node in ordered_nodes
            ):
                return True
        return False

    def _authorize_control_message(
        self,
        graph_instance_id: str,
        target_endpoint: str,
        tags: Iterable[str],
        actor_id: str | None,
    ) -> None:
        graph = self._graph(graph_instance_id)
        template = self._graph_template(graph.template_id)
        close_tag = template.get("closurePolicy", {}).get("tag")
        node_id, _ = self._split_endpoint(target_endpoint)
        node = template["nodes"].get(node_id)
        if node is None:
            raise InvariantError(f"unknown target node: {node_id}")
        is_close = close_tag is not None and close_tag in tags
        if node.get("kind") == "end" and not is_close:
            raise AuthorizationError("End node accepts close control messages only")
        if not is_close:
            return
        if node.get("kind") != "end":
            raise AuthorizationError("close control message must target an End node")
        if actor_id in template.get("controllers", []):
            return
        if actor_id and actor_id.startswith("strategy:"):
            strategy_node_id = actor_id.split(":", 1)[1]
            strategy_node = template["nodes"].get(strategy_node_id)
            if strategy_node and strategy_node.get("kind") == "strategy":
                return
        raise AuthorizationError("actor cannot emit close control message")

    def _is_close_message(
        self,
        template: dict[str, Any],
        message: MessageInstance,
    ) -> bool:
        close_tag = template.get("closurePolicy", {}).get("tag")
        return close_tag is not None and close_tag in message.tags

    @staticmethod
    def _is_close_tags(template: Mapping[str, Any], tags: Iterable[str]) -> bool:
        close_tag = template.get("closurePolicy", {}).get("tag")
        return close_tag is not None and close_tag in tags

    def _resolve_call(
        self,
        source_graph_instance_id: str,
        call: MessageInstance,
        payload: Mapping[str, Any],
    ) -> MessageInstance:
        self._open_graph_instance(source_graph_instance_id)
        if call.operation != "CALL":
            raise InvariantError("reply target is not a CALL message")
        if call.target_graph_instance_id != source_graph_instance_id:
            raise AuthorizationError(
                "reply source is not the CALL target graph instance"
            )
        if call.delivery_state != "CONSUMED":
            raise InvariantError("CALL cannot be replied before consumption")
        if call.callback_state != "WAITING":
            raise InvariantError("CALL callback is already resolved")
        if (
            call.reply_target is None
            or call.reply_target_graph_instance_id is None
        ):
            raise InvariantError("CALL has no reply target")
        target_graph = self._open_graph_instance(
            call.reply_target_graph_instance_id
        )
        self._validate_endpoint_ref(
            self._graph_template(target_graph.template_id)["nodes"],
            call.reply_target,
            output=False,
            operation="REPLY",
        )
        self._authorize_control_message(
            call.reply_target_graph_instance_id,
            call.reply_target,
            (),
            actor_id=None,
        )
        reply = self._new_message(
            origin_graph_instance_id=source_graph_instance_id,
            target_graph_instance_id=call.reply_target_graph_instance_id,
            target_endpoint=call.reply_target,
            operation="REPLY",
            payload=payload,
            tags=(),
            reply_to_message_id=call.id,
            causation_ids={call.id},
        )
        call.callback_state = "RESOLVED"
        call.reply_message_id = reply.id
        return reply

    def _new_message(
        self,
        *,
        origin_graph_instance_id: str,
        target_graph_instance_id: str,
        target_endpoint: str,
        operation: str,
        payload: Mapping[str, Any],
        tags: Iterable[str],
        callback_state: str = "NONE",
        reply_target: str | None = None,
        reply_target_graph_instance_id: str | None = None,
        reply_to_message_id: str | None = None,
        source_endpoint: str | None = None,
        causation_ids: Iterable[str] = (),
        queue_instance_id: str | None = None,
        actor_id: str | None = None,
    ) -> MessageInstance:
        origin_graph = self._graph(origin_graph_instance_id)
        message = MessageInstance(
            id=self._next_id("msg"),
            container_id=origin_graph.container_id,
            origin_graph_instance_id=origin_graph_instance_id,
            target_graph_instance_id=target_graph_instance_id,
            target_endpoint=target_endpoint,
            operation=operation,
            payload=deepcopy(dict(payload)),
            tags=frozenset(tags),
            callback_state=callback_state,
            reply_target=reply_target,
            reply_target_graph_instance_id=reply_target_graph_instance_id,
            reply_to_message_id=reply_to_message_id,
            source_endpoint=source_endpoint,
            causation_ids=frozenset(causation_ids),
            queue_instance_id=queue_instance_id,
            actor_id=actor_id,
        )
        self._messages[message.id] = message
        return message

    @staticmethod
    def _apply_servo(
        payload: Mapping[str, Any],
        servo: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        result = deepcopy(dict(payload))
        if not servo:
            return result
        mapping = servo.get("map")
        if mapping:
            projected = {}
            for target, source in mapping.items():
                if source not in payload:
                    raise InvariantError(f"Servo source field is missing: {source}")
                projected[target] = deepcopy(payload[source])
            result = projected
        for key, value in servo.get("set", {}).items():
            result[key] = deepcopy(value)
        return result

    @staticmethod
    def _output_item(
        item: Any,
    ) -> tuple[dict[str, Any], frozenset[str], frozenset[str] | None]:
        if isinstance(item, Mapping) and "payload" in item and "tags" in item:
            causation_ids = item.get("causationIds")
            return (
                deepcopy(dict(item["payload"])),
                frozenset(item["tags"]),
                None if causation_ids is None else frozenset(causation_ids),
            )
        if not isinstance(item, Mapping):
            raise InvariantError("node output payload must be a JSON object")
        return deepcopy(dict(item)), frozenset(), None

    def _validate_queue_bindings(
        self,
        container_id: str,
        graph_template: dict[str, Any],
        bindings: dict[str, str],
    ) -> None:
        slots = graph_template.get("queueSlots", {})
        if set(bindings) - set(slots):
            raise InvariantError("queue binding contains undeclared slot")
        for slot_id, queue_id in bindings.items():
            queue = self._queue(queue_id)
            if queue.container_id != container_id:
                raise InvariantError("queue belongs to another container")
            if queue.template_id != slots[slot_id]["queueTemplateId"]:
                raise InvariantError("queue template does not match slot")

    @staticmethod
    def _validate_policy(policy: Mapping[str, Any]) -> None:
        allowed_fields = {
            "readiness",
            "requiredInputs",
            "selection",
            "rankField",
            "unselected",
            "output",
        }
        unknown_fields = set(policy) - allowed_fields
        if unknown_fields:
            raise InvariantError(
                f"unknown strategy policy fields: {sorted(unknown_fields)}"
            )
        readiness = policy.get("readiness", "ANY")
        if readiness not in {"ANY", "ALL_REQUIRED"}:
            raise InvariantError(f"unsupported strategy readiness: {readiness}")
        selection = policy.get("selection", "FIRST")
        if selection not in {"FIRST", "TOP_ONE", "ONE_PER_INPUT", "CROSS_ALL"}:
            raise InvariantError(f"unsupported strategy selection: {selection}")
        required_inputs = policy.get("requiredInputs")
        if readiness == "ALL_REQUIRED" and not required_inputs:
            raise InvariantError("ALL_REQUIRED requires requiredInputs")
        if selection in {"ONE_PER_INPUT", "CROSS_ALL"} and not required_inputs:
            raise InvariantError(f"{selection} requires requiredInputs")
        if selection == "CROSS_ALL" and len(required_inputs) != 2:
            raise InvariantError("CROSS_ALL currently requires exactly two inputs")
        unselected = policy.get("unselected", "RETAIN")
        if unselected not in {"RETAIN", "DISCARD"}:
            raise InvariantError(f"unsupported unselected policy: {unselected}")
        output = policy.get("output", "EMIT_EACH")
        if output == "EMIT_EACH":
            return
        if not isinstance(output, Mapping):
            raise InvariantError(f"unsupported output policy: {output}")
        mode = output.get("mode")
        if mode == "WAIT_ALL":
            if not output.get("requiredOutputs"):
                raise InvariantError("WAIT_ALL requires requiredOutputs")
            return
        if mode == "CROSS":
            if any(name not in output for name in ("left", "right", "target")):
                raise InvariantError("output CROSS requires left, right and target")
            return
        raise InvariantError(f"unsupported output policy mode: {mode}")

    @staticmethod
    def _validate_policy_for_node(
        node_id: str,
        node: Mapping[str, Any],
        policy: Mapping[str, Any],
    ) -> None:
        endpoints = set(RuntimeHarness._declared_endpoints(node))
        required_inputs = set(policy.get("requiredInputs", []))
        if not required_inputs.issubset(endpoints):
            raise InvariantError(
                f"strategy {node_id} policy references undeclared inputs: "
                f"{sorted(required_inputs - endpoints)}"
            )
        output = policy.get("output", "EMIT_EACH")
        if not isinstance(output, Mapping):
            return
        if output.get("mode") == "WAIT_ALL":
            referenced = set(output["requiredOutputs"])
        else:
            referenced = {output["left"], output["right"], output["target"]}
        if not referenced.issubset(endpoints):
            raise InvariantError(
                f"strategy {node_id} policy references undeclared outputs: "
                f"{sorted(referenced - endpoints)}"
            )

    @staticmethod
    def _validate_endpoint_ref(
        nodes: Mapping[str, Any],
        endpoint_ref: str | None,
        *,
        output: bool,
        operation: str | None = None,
    ) -> None:
        if not endpoint_ref or "." not in endpoint_ref:
            raise InvariantError(f"invalid endpoint reference: {endpoint_ref}")
        node_id, endpoint = endpoint_ref.split(".", 1)
        node = nodes.get(node_id)
        if node is None:
            raise InvariantError(f"unknown endpoint node: {node_id}")
        endpoint_specs = node.get("endpoints")
        if isinstance(endpoint_specs, (Mapping, list)):
            endpoints = RuntimeHarness._declared_endpoints(node)
        else:
            field_name = "outputs" if output else "inputs"
            endpoints = list(node.get(field_name, []))
        if endpoint not in endpoints:
            raise InvariantError(f"unknown endpoint: {endpoint_ref}")
        if operation and isinstance(endpoint_specs, Mapping):
            endpoint_spec = endpoint_specs.get(endpoint, {})
            accepts = endpoint_spec.get("accepts") if isinstance(endpoint_spec, Mapping) else None
            if accepts and operation not in accepts:
                raise InvariantError(
                    f"endpoint {endpoint_ref} does not accept operation {operation}"
                )

    @staticmethod
    def _declared_endpoints(node: Mapping[str, Any]) -> list[str]:
        endpoint_specs = node.get("endpoints")
        if isinstance(endpoint_specs, Mapping):
            return list(endpoint_specs)
        if isinstance(endpoint_specs, list):
            return list(endpoint_specs)
        return list(dict.fromkeys([*node.get("inputs", []), *node.get("outputs", [])]))

    @classmethod
    def _default_emit_endpoint(cls, node: Mapping[str, Any]) -> str:
        configured = node.get("emitEndpoint")
        if configured:
            return configured
        endpoints = cls._declared_endpoints(node)
        if "out" in endpoints:
            return "out"
        legacy_outputs = node.get("outputs", [])
        if legacy_outputs:
            return legacy_outputs[0]
        if len(endpoints) == 1:
            return endpoints[0]
        raise InvariantError(
            "forwarding node with multiple unified endpoints requires emitEndpoint"
        )

    @staticmethod
    def _split_endpoint(endpoint_ref: str) -> tuple[str, str]:
        return tuple(endpoint_ref.split(".", 1))  # type: ignore[return-value]

    @classmethod
    def _endpoint_name(cls, endpoint_ref: str) -> str:
        return cls._split_endpoint(endpoint_ref)[1]

    @staticmethod
    def _required(mapping: Mapping[str, Any], name: str) -> Any:
        if name not in mapping:
            raise InvariantError(f"missing required field: {name}")
        return mapping[name]

    @staticmethod
    def _put_new(store: dict, key: str, value: Any) -> None:
        if key in store:
            raise InvariantError(f"object already exists: {key}")
        store[key] = value

    def _container(self, container_id: str) -> ContainerInstance:
        try:
            return self._containers[container_id]
        except KeyError as exc:
            raise InvariantError(f"unknown container: {container_id}") from exc

    def _graph(self, graph_id: str) -> GraphInstance:
        try:
            return self._graphs[graph_id]
        except KeyError as exc:
            raise InvariantError(f"unknown graph instance: {graph_id}") from exc

    def _graph_template(self, template_id: str) -> dict[str, Any]:
        try:
            return self._graph_templates[template_id]
        except KeyError as exc:
            raise InvariantError(f"unknown graph template: {template_id}") from exc

    def _open_graph_instance(self, graph_instance_id: str) -> GraphInstance:
        graph = self._graph(graph_instance_id)
        if graph.status != "OPEN":
            raise InvariantError(f"graph instance is closed: {graph_instance_id}")
        return graph

    def _message(self, message_id: str) -> MessageInstance:
        try:
            return self._messages[message_id]
        except KeyError as exc:
            raise InvariantError(f"unknown message: {message_id}") from exc

    def _queue(self, queue_id: str) -> QueueInstance:
        try:
            return self._queues[queue_id]
        except KeyError as exc:
            raise InvariantError(f"unknown queue: {queue_id}") from exc
