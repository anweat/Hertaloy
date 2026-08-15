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
import re
from typing import Any, Callable, Mapping

from nodeflow_core import (
    InvariantError, _ALLOWED_NODE_KINDS,
)

#: 边 Servo 允许的 payload 操作集 —— 与调度层 _apply_servo 保持一致。
_SERVO_OPS = frozenset({"set", "map", "drop"})


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

    @staticmethod
    def _normalize_tools(tools) -> list[dict[str, Any]]:
        """工具声明允许两种形状：裸字符串名，或 {name, description, ...}。"""
        out = []
        for t in tools:
            if isinstance(t, str):
                out.append({"name": t})
            elif isinstance(t, Mapping):
                out.append(dict(t))
            else:
                raise InvariantError(
                    f"工具声明必须是字符串名或映射：{t!r}")
        return out

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
            "tools": self._normalize_tools(tools),
        }
        self._specs[spec_id] = spec
        resolved = self._resolve_spec(spec_id)
        # 编译期就校验工具全集：内核保留名 / 跨来源重名（#8），
        # 而不是等到第一次 claim 才在 prompt 编译里炸。
        self._collect_tools(resolved)
        return resolved

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
            "tools": self._normalize_tools(tools),
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

    def _collect_tools(self, resolved) -> list[dict[str, Any]]:
        """把显式声明工具与 MCP 卡片工具合并成工具全集。

        编译规则归内核：显式 tools 与 mcp 卡的工具地位相同，全部编译期定型；
        内核保留名不可占用，跨来源重名显式报错，不依赖加载顺序（#8）。
        """
        tools: list[dict[str, Any]] = []
        claimed: dict[str, str] = {}

        def _add(name: Any, description: Any, source: str) -> None:
            if not isinstance(name, str) or not name:
                raise InvariantError(
                    f"{source} 的工具名必须是字符串：{name!r}")
            if name in self.KERNEL_TOOL_NAMES:
                raise InvariantError(
                    f"{source} 的工具 {name!r} 占用了内核保留名；"
                    f"保留名：{sorted(self.KERNEL_TOOL_NAMES)}")
            if name in claimed:
                raise InvariantError(
                    f"工具名冲突：{name!r} 同时来自 {claimed[name]} 与 {source}；"
                    f"请在卡片/spec 里改名，不要依赖加载顺序")
            claimed[name] = source
            tools.append({
                "name": name,
                "description": str(description or ""),
                "source": source,
                # 不变量 X：工具集编译期声明齐全，运行期只启用不新增
                "defer_loading": True,
                # 有显式 input schema 就带上，否则给一个开放对象 schema；
                # driver 层负责把它翻译成各家 API 的 parameters。
                "parameters": dict(t.get("parameters") or t.get("input_schema")
                                   or {"type": "object", "properties": {}}),
            })

        # [t] 显式工具（spec / character 展开后同构）—— 与 mcp 卡片工具同级
        for t in sorted(resolved.get("tools") or [],
                        key=lambda t: str(t.get("name", ""))):
            _add(t.get("name"), t.get("description"),
                 f"spec/{resolved.get('spec_id', '?')}")

        # [c] mcp 卡片工具：只带名称 + 摘要，不含全量 schema
        by_kind: dict[str, list[tuple[str, int]]] = {}
        for key, ver in resolved.get("cards", {}).items():
            kind, cid = key.split("/", 1)
            by_kind.setdefault(kind, []).append((cid, ver))
        for cid, v in sorted(by_kind.get("mcp", [])):
            body = self.card_body("mcp", cid, v)
            for t in body.get("tools", []):
                _add(t.get("name"), t.get("summary"), f"mcp/{cid}@{v}")
        return tools

    def _compile_agent_prompt(self, resolved, node) -> tuple[str, list[dict]]:
        by_kind: dict[str, list[tuple[str, int]]] = {}
        for key, ver in resolved.get("cards", {}).items():
            kind, cid = key.split("/", 1)
            by_kind.setdefault(kind, []).append((cid, ver))

        parts: list[str] = []
        tools: list[dict[str, Any]] = self._collect_tools(resolved)

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
        for cid, v in sorted(by_kind.get("mcp", [])):
            body = self.card_body("mcp", cid, v)
            for t in body.get("tools", []):
                mcp_lines.append(f"- {t['name']}：{t.get('summary', '')}")
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

    def _emit_schema_for(self, node) -> dict[str, Any]:
        """由 emit 端点契约推导 OutputContract.schema（INTERFACES §2.3）。

        产出的是 emit 工具**参数**的 JSON Schema：port 枚举 + 每个有契约的
        端口一个 oneOf 变体（payload 必须满足该端口契约）。没有契约时退化为
        自由对象。apply_execution 仍会逐端口再做源契约取值校验。
        """
        endpoints = node.get("endpoints") or {}
        ports = [ep for ep, d in endpoints.items()
                 if isinstance(d, Mapping) and "emit" in d] or list(endpoints)
        variants: list[dict[str, Any]] = []
        for ep in sorted(ports):
            ref = self._endpoint_ref(node, ep, "emit", "PUSH")
            if not ref:
                continue
            payload_schema = dict(self._contract(ref))
            payload_schema.setdefault("type", "object")
            variants.append({
                "type": "object",
                "properties": {
                    "port": {"const": ep},
                    "payload": payload_schema,
                },
                "required": ["port", "payload"],
                "x-nodeflow-contract": ref,
            })
        return {
            "type": "object",
            "properties": {
                "port": {"type": "string", "enum": sorted(ports)},
                "payload": {"oneOf": variants} if variants else {"type": "object"},
            },
            "required": ["port", "payload"],
        }

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
        if "@" in template_id:
            raise InvariantError(
                f"模板 id 不得含 '@'（版本由内核追加）：{template_id!r}")
        ref = f"{template_id}@1"
        if ref in self._templates:
            raise InvariantError(
                f"模板已存在，发布后不可变：{ref}。"
                f"要演进请注册新 id（如 {template_id}-v2）或走定义版本化通道")
        for node_id, node in spec.get("nodes", {}).items():
            kind = node.get("kind")
            if kind not in _ALLOWED_NODE_KINDS:
                raise InvariantError(
                    f"unsupported node kind {kind!r} at {node_id!r}; "
                    f"循环锚点是 strategy 的配置，不是节点种类（FOUNDATION §5.6）")
        self._validate_template(template_id, spec)      # 全引用校验
        self._validate_edges(template_id, spec)         # 连接期校验
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

    def _validate_template(self, template_id: str, spec: Mapping) -> None:
        """注册期全引用校验：模板应当一次注册就完整，而不是运行到一半才 KeyError。

        校验项：节点必需字段、spec/policy/handler/slot/订阅/servo 引用都存在，
        ALL_REQUIRED 的端点存在，FANOUT_TO_SLOT 的 slot 存在，WARM_POOL(n) 合法。
        错误信息面向 LLM/画布。
        """
        nodes = spec.get("nodes") or {}
        if not nodes:
            raise InvariantError(f"模板 {template_id} 没有节点")
        slots = spec.get("slots") or {}

        def _ep_exists(node_id: str, ep: str, *, where: str) -> None:
            node = nodes.get(node_id)
            if node is None:
                raise InvariantError(
                    f"{where}：节点 {node_id!r} 不存在。可用节点：{sorted(nodes)}")
            if ep not in (node.get("endpoints") or {}):
                raise InvariantError(
                    f"{where}：节点 {node_id!r} 没有端点 {ep!r}。"
                    f"可用端点：{sorted((node.get('endpoints') or {}))}")

        for node_id, node in nodes.items():
            kind = node.get("kind")
            endpoints = node.get("endpoints")
            if not isinstance(endpoints, Mapping) or not endpoints:
                raise InvariantError(
                    f"节点 {node_id!r} 必须声明非空 endpoints（统一端点模型）")
            if kind == "agent":
                spec_id = node.get("spec")
                if spec_id not in self._specs:
                    raise InvariantError(
                        f"节点 {node_id!r} 引用的 agent spec {spec_id!r} 未注册；"
                        f"先 compile_agent_spec。可用 spec：{sorted(self._specs)}")
            elif kind == "plain":
                if node.get("handler") not in self._handlers:
                    raise InvariantError(
                        f"节点 {node_id!r} 引用的 handler {node.get('handler')!r} 未注册；"
                        f"可用 handler：{sorted(self._handlers)}")
            elif kind == "strategy":
                policy_id = node.get("policy")
                if policy_id not in self._policies:
                    raise InvariantError(
                        f"节点 {node_id!r} 引用的 policy {policy_id!r} 未注册；"
                        f"可用 policy：{sorted(self._policies)}")
                ev = node.get("evaluator") or {}
                if ev.get("kind") == "model":
                    if ev.get("spec") not in self._specs:
                        raise InvariantError(
                            f"节点 {node_id!r} 的 model evaluator 引用了未注册 spec "
                            f"{ev.get('spec')!r}")
                elif node.get("handler") not in self._handlers:
                    raise InvariantError(
                        f"节点 {node_id!r} 引用的 handler {node.get('handler')!r} 未注册；"
                        f"model evaluator 请声明 evaluator.kind='model'")
                policy = self._policies[policy_id]
                readiness = policy.get("readiness", "ANY")
                if readiness not in ("ANY", "ALL_REQUIRED"):
                    raise InvariantError(
                        f"节点 {node_id!r} 的 policy 未实现的 readiness：{readiness!r}")
                selection = policy.get("selection") or (
                    "ONE_PER_INPUT" if readiness == "ALL_REQUIRED" else "FIRST")
                if selection not in ("FIRST", "TOP_ONE", "ONE_PER_INPUT", "CROSS_ALL"):
                    raise InvariantError(
                        f"节点 {node_id!r} 的 policy 未实现的 selection：{selection!r}")
                needs_required = (readiness == "ALL_REQUIRED"
                                  or selection in ("ONE_PER_INPUT", "CROSS_ALL"))
                required = policy.get("required_inputs")
                if needs_required:
                    if not isinstance(required, (list, tuple)) or not required:
                        raise InvariantError(
                            f"节点 {node_id!r}：{readiness}/{selection} 必须给出 "
                            f"required_inputs")
                    for ep in required:
                        _ep_exists(node_id, ep,
                                   where=f"节点 {node_id!r} 的 required_inputs")
                if selection == "CROSS_ALL" and len(required) != 2:
                    raise InvariantError(
                        f"节点 {node_id!r}：CROSS_ALL 要求恰好两个 required_inputs，"
                        f"得到 {list(required)}")
                if selection == "TOP_ONE":
                    if not isinstance(policy.get("rankField", "rank"), str):
                        raise InvariantError(
                            f"节点 {node_id!r}：TOP_ONE 的 rankField 必须是字符串")
                    if policy.get("unselected", "RETAIN") not in ("RETAIN", "DISCARD"):
                        raise InvariantError(
                            f"节点 {node_id!r}：TOP_ONE 的 unselected 必须是 "
                            f"RETAIN | DISCARD")
                out = policy.get("output") or {}
                mode = out.get("mode")
                if mode == "FANOUT_TO_SLOT":
                    slot_id = out.get("slot")
                    if slot_id not in slots:
                        raise InvariantError(
                            f"节点 {node_id!r}：FANOUT_TO_SLOT 指向未声明的 slot "
                            f"{slot_id!r}。可用 slots：{sorted(slots)}")
                    cap = out.get("max_items")
                    if cap is not None and (not isinstance(cap, int) or cap <= 0):
                        raise InvariantError(
                            f"节点 {node_id!r}：max_items 必须是正整数，得到 {cap!r}")
                elif mode == "WAIT_ALL":
                    req_outs = out.get("required_outputs")
                    if not isinstance(req_outs, (list, tuple)) or not req_outs:
                        raise InvariantError(
                            f"节点 {node_id!r}：WAIT_ALL 必须给出 required_outputs")
                    for ep in req_outs:
                        _ep_exists(node_id, ep,
                                   where=f"节点 {node_id!r} 的 required_outputs")
                elif mode == "CROSS":
                    for key in ("left", "right", "target"):
                        if not isinstance(out.get(key), str):
                            raise InvariantError(
                                f"节点 {node_id!r}：CROSS 必须给出字符串 {key}")
                    _ep_exists(node_id, out["target"],
                               where=f"节点 {node_id!r} 的 CROSS target")
                elif mode not in (None, "EMIT_EACH"):
                    raise InvariantError(
                        f"节点 {node_id!r}：未实现的 output mode {mode!r}")
            elif kind == "subflow":
                slot_id = node.get("slot")
                if slot_id not in slots:
                    raise InvariantError(
                        f"节点 {node_id!r} 引用的 slot {slot_id!r} 未声明；"
                        f"可用 slots：{sorted(slots)}")
                rp = node.get("return_port", "reply")
                if rp != "reply":
                    _ep_exists(node_id, rp,
                               where=f"节点 {node_id!r} 的 return_port")
            elif kind == "start":
                _ep_exists(node_id, node.get("emit", "io"),
                           where=f"节点 {node_id!r} 的 emit")
            elif kind == "approval":
                allowed = node.get("authorized_actors")
                if allowed is not None and not isinstance(allowed, (list, tuple)):
                    raise InvariantError(
                        f"节点 {node_id!r} 的 authorized_actors 必须是列表")

        for slot_id, slot in slots.items():
            if not isinstance(slot, Mapping):
                raise InvariantError(f"slot {slot_id!r} 必须是映射")
            child_ref = slot.get("template")
            child = self._templates.get(child_ref)
            if child is None:
                raise InvariantError(
                    f"slot {slot_id!r} 引用的模板 {child_ref!r} 未注册（先注册子模板）；"
                    f"可用模板：{sorted(self._templates)}")
            mode = slot.get("instantiation", "PER_CALL")
            m = re.fullmatch(r"WARM_POOL\((\d+)\)", str(mode))
            if mode not in ("PER_CALL", "SINGLETON") and not m:
                raise InvariantError(
                    f"slot {slot_id!r} 的 instantiation {mode!r} 不合法；"
                    f"应为 PER_CALL | WARM_POOL(n) | SINGLETON")
            if m and int(m.group(1)) <= 0:
                raise InvariantError(f"slot {slot_id!r} 的 WARM_POOL(n) 需要 n>0")
            entry = slot.get("entry")
            if not isinstance(entry, str) or "." not in entry:
                raise InvariantError(f"slot {slot_id!r} 的 entry 必须形如 node.endpoint")
            enode, eep = entry.split(".", 1)
            cnode = (child.get("nodes") or {}).get(enode)
            if cnode is None or eep not in (cnode.get("endpoints") or {}):
                raise InvariantError(
                    f"slot {slot_id!r} 的 entry {entry!r} 在子模板 "
                    f"{child_ref} 中不存在")
            exit_decl = slot.get("exit")
            if exit_decl:
                xep = (exit_decl.get("endpoint") or "").split(".", 1)
                if len(xep) != 2 or xep[0] not in (child.get("nodes") or {}) \
                        or xep[1] not in ((child.get("nodes") or {}).get(xep[0], {})
                                          .get("endpoints") or {}):
                    raise InvariantError(
                        f"slot {slot_id!r} 的 exit.endpoint 在子模板中不存在："
                        f"{exit_decl.get('endpoint')!r}")

        for sub in spec.get("subscriptions", []):
            topic = sub.get("topic")
            if topic not in self._topics:
                raise InvariantError(
                    f"订阅引用了未注册的 topic {topic!r}；先 register_topic。"
                    f"可用 topic：{sorted(self._topics)}")
            endpoint = sub.get("endpoint")
            if not isinstance(endpoint, str) or "." not in endpoint:
                raise InvariantError(f"订阅 endpoint 必须形如 node.endpoint：{endpoint!r}")
            nid, ep = endpoint.split(".", 1)
            _ep_exists(nid, ep, where=f"订阅 {topic} 的 endpoint")

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

            # V4 close/end 定案：end 是终态汇点（只进不出）。
            # 关闭/DRAIN 不在内核 —— 关闭走控制面 control(close)（留提交事实），
            # 用户排空语义由编排自行表达（test_boundaries close 实验1）。
            if nodes.get(src_node_id, {}).get("kind") == "end":
                raise InvariantError(
                    f"边 {eid} 不合法：end 是终态汇点，不得有出边；"
                    f"关闭语义由控制面 control(close) 承担")

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

            # Servo 本体校验独立于契约是否声明：契约未声明 = 未约束，
            # 但非法 Servo 任何时候都必须被拒。
            servo = edge.get("servo")
            if servo is not None:
                transform = self._transforms.get(servo)
                if transform is None:
                    raise InvariantError(
                        f"边 {eid} 不合法：Servo {servo!r} 未注册。"
                        f"可用 transform：{sorted(self._transforms)}")
                if transform["role"] != "EDGE_SERVO":
                    raise InvariantError(
                        f"边 {eid} 不合法：只有 EDGE_SERVO 能绑边，"
                        f"{servo} 的 role={transform['role']!r}")
                illegal = set(transform["body"]) - _SERVO_OPS
                if illegal:
                    raise InvariantError(
                        f"边 {eid} 不合法：Servo 只能改 payload，"
                        f"不得触碰路由/操作/契约/关联：{sorted(illegal)}")

            if src_ref is None or tgt_ref is None:
                if strict:
                    raise InvariantError(
                        f"边 {eid} 不合法：模板声明了 strict_contracts，"
                        f"但 {'源' if src_ref is None else '目标'}端点未声明 {op} 契约"
                    )
                continue                     # 未声明 = 未约束

            src_all, _ = self._fields_of(self._contract(src_ref))
            tgt_all, tgt_req = self._fields_of(self._contract(tgt_ref))
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
        if topic_id in self._topics:
            raise InvariantError(
                f"topic 已存在，不可覆盖：{topic_id!r}。"
                f"要演进请注册新 id 或走定义版本化通道")
        self._topics[topic_id] = {
            "request_contract": copy.deepcopy(request_contract),
            "reply_contract": copy.deepcopy(reply_contract),
        }
        self._subs.setdefault(topic_id, [])
        return topic_id

    def register_transform(self, transform_id, *, role, body) -> str:
        if transform_id in self._transforms:
            raise InvariantError(
                f"transform 已存在，不可覆盖：{transform_id!r}")
        self._transforms[transform_id] = {"role": role, "body": copy.deepcopy(body)}
        return transform_id

    def register_policy(self, policy_id, spec) -> str:
        if policy_id in self._policies:
            raise InvariantError(
                f"policy 已存在，不可覆盖：{policy_id!r}")
        self._policies[policy_id] = copy.deepcopy(spec)   # 边界 B1c：快照
        return policy_id

    def register_handler(self, name: str, fn: Callable[..., Any]) -> str:
        if name in self._handlers:
            raise InvariantError(
                f"handler 已存在，不可覆盖：{name!r}。"
                f"测试/装配若要替换，请用新名字")
        self._handlers[name] = fn
        return name

    #: evaluator 允许返回的顶层键。模型驱动时更窄，见 _guard_decision。
    #: 内核注入的工具名，卡片不得占用（#8）
    KERNEL_TOOL_NAMES = frozenset({"emit", "read_artifact", "publish", "spawn"})
