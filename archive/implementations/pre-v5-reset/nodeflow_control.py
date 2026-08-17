"""Nodeflow V4 —— 控制面工具层（Phase 2）

把装配/编排/控制 API 封装成一组**声明式工具 schema + 单一 dispatch 入口**，
供助手 AI / MCP server 调用。设计约束：

- actor 由可信边界注入（`dispatch(..., actor=...)`），payload 里的
  `proposer` / `actor` 字段一律不可信 —— 提案的 proposer 恒取注入的 actor。
- 所有写操作都落到既有提交/版本事实里（定义是 ObjectVersion，控制是
  RunSnapshot，审批是 proposal 状态迁移），本层不发明新的旁路。
- 返回值只含 JSON 可序列化数据；handler/函数对象不能过这条边界。

这还不是完整 MCP server（stdio/SSE 传输层留给接入方），但 tool schema
已经是 MCP `Tool.inputSchema` 的形状，接入时逐条搬运即可。
"""

from __future__ import annotations

from typing import Any, Mapping

from nodeflow_v4 import (
    AuthorizationError, InvariantError, Principal, Runtime,
)

TOOLS: dict[str, Mapping[str, Any]] = {
    "register_card": {
        "description": "注册一张装配面卡片（skill/mcp/rules/prompt）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"enum": ["skill", "mcp", "rules", "prompt"]},
                "card_id": {"type": "string"},
                "version": {"type": "integer"},
                "body": {"type": "object"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["kind", "card_id", "version", "body"],
        },
    },
    "compile_agent_spec": {
        "description": "把卡片组合编译成 AgentSpec（pin 精确版本）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "spec_id": {"type": "string"},
                "model": {"type": "string"},
                "cards": {"type": "array"},
                "tools": {"type": "array"},
            },
            "required": ["spec_id", "model"],
        },
    },
    "register_graph_template": {
        "description": "发布 GraphTemplate @1（重复 id 拒绝；演进走 publish_graph_template）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template_id": {"type": "string"},
                "spec": {"type": "object"},
            },
            "required": ["template_id", "spec"],
        },
    },
    "publish_graph_template": {
        "description": "版本化发布 GraphTemplate（@2、@3…，旧 ref 保持可用）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template_id": {"type": "string"},
                "spec": {"type": "object"},
                "derived_from": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["template_id", "spec"],
        },
    },
    "propose_graph_template": {
        "description": "提出图模板定义（只落提案，不注册；proposer 取可信 actor）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_id": {"type": "string"},
                "template_id": {"type": "string"},
                "spec": {"type": "object"},
                "required_approvers": {
                    "type": "array", "items": {"type": "string"}},
                "derived_from": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["proposal_id", "template_id", "spec"],
        },
    },
    "approve_graph_template": {
        "description": "审批图模板提案（校验+发布+留 approved 事实）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_id": {"type": "string"},
                "modifications": {"type": "object"},
            },
            "required": ["proposal_id"],
        },
    },
    "instantiate": {
        "description": "由精确模板 ref 创建 GraphInstance。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template_ref": {"type": "string"},
                "owner": {"type": "string"},
                "params": {"type": "object"},
                "controllers": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["template_ref", "owner"],
        },
    },
    "send": {
        "description": "向实例端点发送一条数据消息。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "array", "items": {"type": "string"},
                           "minItems": 3, "maxItems": 3},
                "payload": {},
            },
            "required": ["target", "payload"],
        },
    },
    "publish": {
        "description": "向主题发布消息（发给所有 OPEN 订阅者）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic_id": {"type": "string"},
                "payload": {},
                "sender": {"type": "array", "items": {"type": "string"}},
                "callback": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["topic_id", "payload"],
        },
    },
    "subscribe": {
        "description": "订阅主题（target = [gid, node_id, endpoint]）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic_id": {"type": "string"},
                "target": {"type": "array", "items": {"type": "string"},
                           "minItems": 3, "maxItems": 3},
            },
            "required": ["topic_id", "target"],
        },
    },
    "drain": {
        "description": "排空指定实例（不传 gids 排空全部）。",
        "inputSchema": {
            "type": "object",
            "properties": {"gids": {"type": "array", "items": {"type": "string"}}},
        },
    },
    "control": {
        "description": "控制面动作（pause/resume/close），需实例 controllers 授权。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "gid": {"type": "string"},
                "action": {"enum": ["pause", "resume", "close"]},
            },
            "required": ["gid", "action"],
        },
    },
    "approve_node": {
        "description": "审批节点动作（allow/deny），需节点 authorized_actors 授权。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "gid": {"type": "string"},
                "node_id": {"type": "string"},
                "decision": {"enum": ["allow", "deny"]},
                "payload": {},
            },
            "required": ["gid", "node_id", "decision"],
        },
    },
    "query_graph": {
        "description": "查询实例状态与节点状态。",
        "inputSchema": {
            "type": "object",
            "properties": {"gid": {"type": "string"}},
            "required": ["gid"],
        },
    },
    "query_template_versions": {
        "description": "查询 GraphTemplate 定义版本历史。",
        "inputSchema": {
            "type": "object",
            "properties": {"template_id": {"type": "string"}},
            "required": ["template_id"],
        },
    },
}


class ControlPlane:
    """JSON 工具层的唯一入口。

    dispatch(tool, arguments, actor=...) —— actor 是**可信边界**注入的
    Principal；任何工具都不得从 arguments 里读身份。
    """

    def __init__(self, rt: Runtime):
        self.rt = rt

    def _principal(self, actor) -> Principal:
        principal = Principal.parse(actor)
        return principal

    def dispatch(self, tool: str, arguments: Mapping[str, Any],
                 *, actor) -> Any:
        if tool not in TOOLS:
            raise InvariantError(f"unknown control tool: {tool}")
        args = dict(arguments or {})
        principal = self._principal(actor)
        actor_str = str(principal)

        rt = self.rt
        if tool == "register_card":
            return rt.register_card(
                kind=args["kind"], card_id=args["card_id"],
                version=args["version"], body=args["body"],
                tags=args.get("tags", ()))
        if tool == "compile_agent_spec":
            return rt.compile_agent_spec(
                args["spec_id"], model=args["model"],
                cards=args.get("cards", ()), tools=args.get("tools", ()))
        if tool == "register_graph_template":
            return rt.register_graph_template(
                args["template_id"], args["spec"])
        if tool == "publish_graph_template":
            return rt.publish_graph_template(
                args["template_id"], args["spec"],
                derived_from=args.get("derived_from", ()))
        if tool == "propose_graph_template":
            # proposer 只信注入的 actor，payload 无法自封身份（#10）
            return rt.propose_graph_template(
                args["proposal_id"], template_id=args["template_id"],
                spec=args["spec"], proposer=actor_str,
                required_approvers=args.get("required_approvers", ()),
                derived_from=args.get("derived_from", ()))
        if tool == "approve_graph_template":
            return rt.approve_graph_template(
                args["proposal_id"], actor=actor_str,
                modifications=args.get("modifications"))
        if tool == "instantiate":
            return rt.instantiate(
                args["template_ref"], owner=args["owner"],
                params=args.get("params"),
                controllers=args.get("controllers", ()))
        if tool == "send":
            return rt.send(tuple(args["target"]), args["payload"])
        if tool == "publish":
            return rt.publish(
                args["topic_id"], args["payload"],
                sender=tuple(args["sender"]) if args.get("sender") else None,
                callback=tuple(args["callback"]) if args.get("callback") else None)
        if tool == "subscribe":
            return rt.subscribe(args["topic_id"], target=tuple(args["target"]))
        if tool == "drain":
            rt.drain(*args.get("gids", ()))
            return {"drained": True}
        if tool == "control":
            rt.control(args["gid"], args["action"], actor=actor_str)
            return {"status": rt.graph_status(args["gid"])}
        if tool == "approve_node":
            rt.approve(args["gid"], args["node_id"], actor=actor_str,
                       decision=args["decision"], payload=args.get("payload"))
            return {"approved": True}
        if tool == "query_graph":
            gid = args["gid"]
            return {
                "status": rt.graph_status(gid),
                "seq": rt.commit_seq(gid),
                "nodes": {nid: rt.node_persistent_state(gid, nid)
                          for nid in rt._instances[gid].nodes},
            }
        if tool == "query_template_versions":
            return [{"ref": ov.body.get("template_ref", f"@{ov.version}"),
                     "version": ov.version,
                     "content_hash": ov.content_hash,
                     "derived_from": ov.provenance.derived_from}
                    for ov in rt.graph_template_versions(args["template_id"])]
        raise InvariantError(f"control tool not implemented: {tool}")
