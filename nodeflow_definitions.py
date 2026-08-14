"""Nodeflow V4 —— 定义层

卡片、AgentSpec 编译、模板、契约、端点、Servo、主题、策略、handler。
注册即快照；连接期校验在此发生。

本文件由 `Runtime` 通过 mixin 组合；状态仍集中在 `Runtime` 实例上。
这是**模块级职责划分**，不是对象级解耦 —— 真正抽出独立对象留待具体实现阶段，
届时边界已由本文件画好。
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Callable, Mapping

from nodeflow_core import (
    InvariantError, _ALLOWED_NODE_KINDS,
)


class DefinitionsMixin:
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

    #: evaluator 允许返回的顶层键。模型驱动时更窄，见 _guard_decision。
    #: 内核注入的工具名，卡片不得占用（#8）
    KERNEL_TOOL_NAMES = frozenset({"emit", "read_artifact", "publish", "spawn"})
