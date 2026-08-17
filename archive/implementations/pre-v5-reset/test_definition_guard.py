"""定义层注册期守卫 —— Phase 0 收口

发布后不可变 + 注册即完整：模板/主题/变换/策略/handler 重复注册必须拒绝，
模板里的全部引用（spec/policy/handler/slot/topic/端点/Servo）必须在注册期
全部解析，错误信息面向 LLM / 画布。

运行：python -m unittest test_definition_guard -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import InvariantError, Runtime


def _plain_spec(handler="record", endpoints=None) -> dict:
    return {
        "nodes": {"n": {"kind": "plain", "handler": handler,
                         "endpoints": endpoints or {"io": {}}}},
        "edges": [],
    }


class DefinitionGuardTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_handler("record", lambda p, c: {})


class TestDefinitionImmutability(DefinitionGuardTestCase):

    def test_D1_template_cannot_be_overwritten(self):
        self.rt.register_graph_template("t", _plain_spec())
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("t", _plain_spec())
        self.assertIn("不可变", str(cm.exception))
        self.assertEqual(list(self.rt._templates), ["t@1"])

    def test_D2_topic_transform_policy_handler_cannot_be_overwritten(self):
        self.rt.register_topic("q", request_contract={"type": "object"})
        with self.assertRaises(InvariantError):
            self.rt.register_topic("q", request_contract={"type": "object"})

        self.rt.register_transform("x", role="EDGE_SERVO", body={})
        with self.assertRaises(InvariantError):
            self.rt.register_transform("x", role="EDGE_SERVO", body={"set": {}})

        self.rt.register_policy("p", {"readiness": "ANY"})
        with self.assertRaises(InvariantError):
            self.rt.register_policy("p", {"readiness": "ALL_REQUIRED"})

        with self.assertRaises(InvariantError):
            self.rt.register_handler("record", lambda p, c: {})

    def test_D3_template_id_cannot_contain_at_sign(self):
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("x@2", _plain_spec())


class TestTemplateReferences(DefinitionGuardTestCase):

    def test_D4_unknown_spec_is_rejected(self):
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("t", {
                "nodes": {"a": {"kind": "agent", "spec": "nope",
                                "endpoints": {"io": {}}}},
                "edges": [],
            })
        self.assertIn("nope", str(cm.exception))

    def test_D5_unknown_handler_is_rejected(self):
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("t", _plain_spec(handler="ghost"))
        self.assertIn("ghost", str(cm.exception))

    def test_D6_unknown_policy_or_model_evaluator_spec_is_rejected(self):
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"s": {"kind": "strategy", "policy": "nope",
                                "handler": "record", "endpoints": {"io": {}}}},
                "edges": [],
            })
        self.rt.register_policy("p", {"readiness": "ANY"})
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"s": {"kind": "strategy", "policy": "p",
                                "evaluator": {"kind": "model", "spec": "nope"},
                                "endpoints": {"io": {}}}},
                "edges": [],
            })

    def test_D7_all_required_endpoints_must_exist(self):
        self.rt.register_policy("join", {"readiness": "ALL_REQUIRED",
                                         "required_inputs": ["a", "b"]})
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("t", {
                "nodes": {"j": {"kind": "strategy", "policy": "join",
                                "handler": "record", "endpoints": {"a": {}}}},
                "edges": [],
            })
        self.assertIn("b", str(cm.exception))

    def test_D8_fanout_slot_and_max_items_are_checked(self):
        self.rt.register_policy("fan", {"readiness": "ANY",
                                        "output": {"mode": "FANOUT_TO_SLOT",
                                                   "slot": "kids"}})
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"s": {"kind": "strategy", "policy": "fan",
                                "handler": "record", "endpoints": {"io": {}}}},
                "edges": [],
            })
        self.rt.register_policy("fan-bad-cap", {
            "readiness": "ANY",
            "output": {"mode": "FANOUT_TO_SLOT", "slot": "kids",
                       "max_items": 0}})
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"s": {"kind": "strategy", "policy": "fan-bad-cap",
                                "handler": "record", "endpoints": {"io": {}}}},
                "edges": [],
            })

    def test_D9_slot_template_entry_exit_and_instantiation_are_checked(self):
        child = self.rt.register_graph_template("child", _plain_spec())
        slot = {"template": "nope", "instantiation": "PER_CALL", "entry": "n.io"}
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("parent", {
                "nodes": {"s": {"kind": "subflow", "slot": "k",
                                "endpoints": {"io": {}}}},
                "edges": [], "slots": {"k": slot}})
        slot["template"] = child
        slot["entry"] = "n.ghost"
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("parent", {
                "nodes": {"s": {"kind": "subflow", "slot": "k",
                                "endpoints": {"io": {}}}},
                "edges": [], "slots": {"k": slot}})
        slot["entry"] = "n.io"
        slot["instantiation"] = "WARM_POOL(0)"
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("parent", {
                "nodes": {"s": {"kind": "subflow", "slot": "k",
                                "endpoints": {"io": {}}}},
                "edges": [], "slots": {"k": slot}})
        slot["instantiation"] = "PER_CALL"
        slot["exit"] = {"endpoint": "n.ghost"}
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("parent", {
                "nodes": {"s": {"kind": "subflow", "slot": "k",
                                "endpoints": {"io": {}}}},
                "edges": [], "slots": {"k": slot}})

    def test_D10_subscription_topic_and_endpoint_are_checked(self):
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"n": {"kind": "plain", "handler": "record",
                                "endpoints": {"io": {}}}},
                "edges": [],
                "subscriptions": [{"topic": "ghost", "endpoint": "n.io"}],
            })
        self.rt.register_topic("q", request_contract={"type": "object"})
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"n": {"kind": "plain", "handler": "record",
                                "endpoints": {"io": {}}}},
                "edges": [],
                "subscriptions": [{"topic": "q", "endpoint": "n.ghost"}],
            })

    def test_D11_missing_endpoints_or_start_emit_are_rejected(self):
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"n": {"kind": "plain", "handler": "record"}},
                "edges": [],
            })
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", {
                "nodes": {"s": {"kind": "start", "emit": "ghost",
                                "endpoints": {"io": {}}}},
                "edges": [],
            })

    def test_D12_unknown_or_illegal_servo_is_rejected_at_registration(self):
        spec = {
            "nodes": {
                "a": {"kind": "plain", "handler": "record",
                      "endpoints": {"io": {}, "out": {}}},
                "b": {"kind": "plain", "handler": "record",
                      "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "a.out", "to": "b.io"}],
        }
        spec["edges"][0]["servo"] = "ghost"
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("t", spec)
        self.rt.register_transform("ok", role="EDGE_SERVO", body={"set": {"a": 1}})
        spec["edges"][0]["servo"] = "ok"
        self.assertTrue(self.rt.register_graph_template("t-ok", spec))


    def test_D13_end_is_a_terminal_sink_without_out_edges(self):
        """V4 close/end 定案：end 只进不出，关闭由控制面 control(close) 承担。"""
        spec = {
            "nodes": {
                "start": {"kind": "start", "emit": "out",
                          "endpoints": {"io": {}, "out": {}}},
                "end": {"kind": "end", "endpoints": {"io": {}, "out": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "end.io"},
                      {"id": "e2", "from": "end.out", "to": "start.io"}],
        }
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("bad-end", spec)
        self.assertIn("终态汇点", str(cm.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
