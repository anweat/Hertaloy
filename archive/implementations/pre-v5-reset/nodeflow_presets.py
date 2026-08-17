"""Nodeflow V4 —— 预置策略模板（Phase 3）

这些是**随产品附带的配置组合**，不是内核类型：每个 preset 只是注册一条
policy + 一个普通 handler（或返回一段 approval 节点 dict），用户可改可弃。
FOUNDATION §5.6 的"循环锚点不是内核机制"在这里得到最终形态：
fixed_rounds / threshold_loop 全部由 Strategy 配置 + Annotation 表达。
"""

from __future__ import annotations

from typing import Any, Mapping

from nodeflow_v4 import Runtime


def _first(payloads: Mapping[str, Any]) -> Any:
    return next(iter(payloads.values()))


def register_fanout_preset(rt: Runtime, *, policy_id, handler_id, slot,
                           max_items=None) -> dict[str, Any]:
    """按 payload.items 展开 N 个并行子容器（FANOUT_TO_SLOT）。"""
    rt.register_policy(policy_id, {
        "readiness": "ANY",
        "output": {"mode": "FANOUT_TO_SLOT", "slot": slot,
                   **({"max_items": max_items} if max_items is not None else {})},
    })

    def split(payloads, ctx):
        body = _first(payloads)
        items = body.get("items") if isinstance(body, Mapping) else []
        return {"items": list(items)}

    rt.register_handler(handler_id, split)
    return {"policy": policy_id, "handler": handler_id}


def register_review_preset(rt: Runtime, *, policy_id, handler_id,
                           required_inputs) -> dict[str, Any]:
    """多路汇聚：每个必需端点各取一条，合并后从 out 输出。"""
    rt.register_policy(policy_id, {
        "readiness": "ALL_REQUIRED",
        "required_inputs": list(required_inputs),
        "selection": "ONE_PER_INPUT",
    })

    def review(payloads, ctx):
        return {"emit": {"out": {"merged": dict(payloads)}}}

    rt.register_handler(handler_id, review)
    return {"policy": policy_id, "handler": handler_id}


def register_fixed_rounds_preset(rt: Runtime, *, policy_id, handler_id,
                                 rounds) -> dict[str, Any]:
    """固定轮次循环：again 边跑 rounds 次后从 done 退出，每轮写 Annotation。"""
    rt.register_policy(policy_id, {"readiness": "ANY"})

    def loop(payloads, ctx):
        epoch = ctx["state"].get("epoch", 0) + 1
        ctx["state"]["epoch"] = epoch
        return {
            "annotate": {
                "object_refs": {},
                "fields": {"epoch": epoch, "tags": ["fixed-rounds"]},
            },
            "emit": {("again" if epoch < rounds else "done"):
                     _first(payloads)},
        }

    rt.register_handler(handler_id, loop)
    return {"policy": policy_id, "handler": handler_id}


def register_threshold_loop_preset(rt: Runtime, *, policy_id, handler_id,
                                   field, threshold, mode="max",
                                   ) -> dict[str, Any]:
    """阈值循环：payload[field] 达到阈值（max: >threshold）前走 again，否则 done。"""
    rt.register_policy(policy_id, {"readiness": "ANY"})

    def loop(payloads, ctx):
        epoch = ctx["state"].get("epoch", 0) + 1
        ctx["state"]["epoch"] = epoch
        value = _first(payloads)[field]
        reached = value > threshold if mode == "max" else value < threshold
        return {
            "annotate": {
                "object_refs": {},
                "fields": {"epoch": epoch, field: value,
                           "tags": ["threshold-loop"]},
            },
            "emit": {("done" if reached else "again"): _first(payloads)},
        }

    rt.register_handler(handler_id, loop)
    return {"policy": policy_id, "handler": handler_id}


def approval_node_preset(*, authorized_actors, approve_port="out",
                         deny_port="denied") -> dict[str, Any]:
    """人工放行节点配置（NodeDefinition 片段，不是 policy）。"""
    return {
        "kind": "approval",
        "authorized_actors": list(authorized_actors),
        "approve_port": approve_port,
        "deny_port": deny_port,
        "endpoints": {"io": {}, approve_port: {}, deny_port: {}},
    }


#: 发现/画布可枚举的预置清单（只描述，不实例化）
STRATEGY_PRESETS = {
    "fanout": register_fanout_preset,
    "review": register_review_preset,
    "fixed_rounds": register_fixed_rounds_preset,
    "threshold_loop": register_threshold_loop_preset,
}
