"""端点声明与契约校验 —— 连接期 + 运行期

对应 INTERFACES_V4.md §2.1（端点声明形式）与 §2.2（连接期校验）。

两条设计取舍：

1. **契约是可选的。** 未声明 = 未约束，不是"禁止"。理由：让既有模板逐步
   采纳，而不是一刀切。模板可用 `strict_contracts: true` 要求所有边都有契约。

2. **校验发生在连接期**（`register_graph_template`），不是跑到一半才炸。
   错误信息面向 LLM 与画布 —— 要能直接照着改。

运行：python -m unittest test_contracts -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import InvariantError, MockExecutionBackend, Runtime

PLAN = {"type": "object",
        "properties": {"planRef": {"type": "string"}, "tasks": {"type": "array"}},
        "required": ["planRef"]}
TASK = {"type": "object",
        "properties": {"specRef": {"type": "string"},
                       "includeTests": {"type": "boolean"}},
        "required": ["specRef"]}


class ContractTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.set_backend(MockExecutionBackend())
        self.rt.register_handler("noop", lambda p, c: {})
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}) or {})
        self.rt.register_contract("PlanResult", 2, PLAN)
        self.rt.register_contract("CodeTask", 3, TASK)

    def _tpl(self, *, servo=None, strict=False, tgt_required=("specRef",),
             planner_handler="noop"):
        task = dict(TASK, required=list(tgt_required))
        ref = self.rt.register_contract("Target", len(self.rt._contracts), task)
        spec = {
            "nodes": {
                "planner": {"kind": "plain", "handler": planner_handler, "endpoints": {
                    "io": {}, "out": {"emit": {"PUSH": {"contract": "PlanResult@2"}}},
                }},
                "coder": {"kind": "plain", "handler": "record", "endpoints": {
                    "io": {"receive": {"PUSH": {"contract": ref}}},
                }},
            },
            "edges": [{"id": "plan-to-code", "from": "planner.out",
                       "to": "coder.io", **({"servo": servo} if servo else {})}],
        }
        if strict:
            spec["strict_contracts"] = True
        return spec


# ---------------------------------------------------------------------------
# 连接期
# ---------------------------------------------------------------------------


class TestConnectionTime(ContractTestCase):

    def test_C1_incompatible_edge_is_rejected_at_registration(self):
        """★ 边不合法应在**注册模板**时就炸，不是跑到一半。"""
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("bad", self._tpl())
        msg = str(cm.exception)
        self.assertIn("plan-to-code", msg)
        self.assertIn("specRef", msg)

    def test_C2_error_message_is_actionable(self):
        """错误信息的读者是 LLM 和画布 —— 必须能照着改。"""
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("bad", self._tpl())
        msg = str(cm.exception)
        for expected in ("源", "Servo", "目标", "缺失字段", "可用的映射来源"):
            self.assertIn(expected, msg)
        self.assertIn("planRef", msg)          # 告诉它有什么可用

    def test_C3_servo_can_bridge_the_gap(self):
        """Servo 把 planRef 映射成 specRef —— 符号推演后应当放行。"""
        self.rt.register_transform("bridge", role="EDGE_SERVO",
                                   body={"map": {"planRef": "specRef"}})
        ref = self.rt.register_graph_template("good", self._tpl(servo="bridge"))
        self.assertTrue(ref)

    def test_C4_servo_set_also_counts(self):
        """`set` 补出来的字段同样算数。"""
        self.rt.register_transform("inject", role="EDGE_SERVO",
                                   body={"set": {"specRef": "spec@1"}})
        self.assertTrue(
            self.rt.register_graph_template("good2", self._tpl(servo="inject")))

    def test_C5_servo_drop_can_break_an_edge(self):
        """`drop` 掉必需字段应被抓住。"""
        self.rt.register_transform("bad-drop", role="EDGE_SERVO",
                                   body={"map": {"planRef": "specRef"},
                                         "drop": ["specRef"]})
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("bad3", self._tpl(servo="bad-drop"))
        self.assertIn("specRef", str(cm.exception))

    def test_C6_undeclared_contracts_pass_through(self):
        """未声明 = 未约束。既有模板不因此失效。"""
        ref = self.rt.register_graph_template("loose", {
            "nodes": {
                "a": {"kind": "plain", "handler": "noop", "endpoints": {"io": {}, "out": {}}},
                "b": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "a.out", "to": "b.io"}],
        })
        self.assertTrue(ref)

    def test_C7_strict_mode_requires_contracts_everywhere(self):
        """模板可以要求严格：所有边都必须声明契约。"""
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("strict", {
                "strict_contracts": True,
                "nodes": {
                    "a": {"kind": "plain", "handler": "noop",
                          "endpoints": {"io": {}, "out": {}}},
                    "b": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
                },
                "edges": [{"id": "e1", "from": "a.out", "to": "b.io"}],
            })
        self.assertIn("strict_contracts", str(cm.exception))

    def test_C8_unknown_node_or_endpoint_is_caught(self):
        """连线到不存在的节点/端点 —— 画布最容易犯的错。"""
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("typo", {
                "nodes": {"a": {"kind": "plain", "handler": "noop",
                                "endpoints": {"io": {}, "out": {}}}},
                "edges": [{"id": "e1", "from": "a.out", "to": "ghost.io"}],
            })
        self.assertIn("ghost", str(cm.exception))
        self.assertIn("可用节点", str(cm.exception))

        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("typo2", {
                "nodes": {
                    "a": {"kind": "plain", "handler": "noop", "endpoints": {"io": {}, "out": {}}},
                    "b": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
                },
                "edges": [{"id": "e1", "from": "a.out", "to": "b.nowhere"}],
            })
        self.assertIn("nowhere", str(cm.exception))
        self.assertIn("可用端点", str(cm.exception))


# ---------------------------------------------------------------------------
# 运行期
# ---------------------------------------------------------------------------


class TestRuntimeValidation(ContractTestCase):

    def _run(self, payload, *, servo=None, planner_handler="noop"):
        self.rt.register_transform("bridge", role="EDGE_SERVO",
                                   body={"map": {"planRef": "specRef"}})
        tpl = self.rt.register_graph_template(
            "live", self._tpl(servo=servo or "bridge",
                              planner_handler=planner_handler))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "planner", "io"), payload)
        self.rt.drain(job)
        return job

    def test_R1_valid_payload_flows_through(self):
        self.rt.register_handler("passthrough", lambda p, c: {"out": p})
        job = self._run({"planRef": "plan@1"}, planner_handler="passthrough")
        self.assertEqual(self.rt.node_persistent_state(job, "coder")["last"],
                         {"specRef": "plan@1"})

    def test_R2_source_contract_violation_is_caught_before_servo(self):
        """源端不合契约 —— 在 Servo 之前就拒绝。"""
        self.rt.register_handler("bad-out", lambda p, c: {"out": {"wrong": 1}})
        with self.assertRaises(InvariantError) as cm:
            self._run({}, planner_handler="bad-out")
        self.assertIn("源端", str(cm.exception))
        self.assertIn("planRef", str(cm.exception))

    def test_R3_target_contract_is_checked_after_servo(self):
        """Servo 之后再校验一次目标契约。

        构造一条**符号推演能过、实际 payload 给不出**的边：源契约里
        planRef 是可选的，Servo 把它映射成 specRef。连接期看字段集是
        齐的；运行期真的没给 planRef，Servo 之后就缺 specRef。

        这正是两道校验各自的职责 —— 连接期看**结构**，运行期看**取值**。
        """
        self.rt.register_contract("PlanLoose", 1, {
            "type": "object",
            "properties": {"planRef": {"type": "string"}, "tasks": {"type": "array"}},
            "required": [],                       # planRef 可选
        })
        self.rt.register_transform("bridge2", role="EDGE_SERVO",
                                   body={"map": {"planRef": "specRef"}})
        self.rt.register_handler("pass2", lambda p, c: {"out": p})
        tpl = self.rt.register_graph_template("loose-bridge", {
            "nodes": {
                "planner": {"kind": "plain", "handler": "pass2", "endpoints": {
                    "io": {}, "out": {"emit": {"PUSH": {"contract": "PlanLoose@1"}}},
                }},
                "coder": {"kind": "plain", "handler": "record", "endpoints": {
                    "io": {"receive": {"PUSH": {"contract": "CodeTask@3"}}},
                }},
            },
            "edges": [{"id": "loose-edge", "from": "planner.out",
                       "to": "coder.io", "servo": "bridge2"}],
        })                                        # 连接期通过

        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "planner", "io"), {"tasks": []})   # 没给 planRef
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("Servo 之后", str(cm.exception))
        self.assertIn("specRef", str(cm.exception))

    def test_R4_validator_never_silently_fills_fields(self):
        """★ 只接受或拒绝，不暗中补字段。"""
        self.rt.register_handler("pass4", lambda p, c: {"out": p})
        job = self._run({"planRef": "plan@1", "tasks": []},
                        planner_handler="pass4")
        got = self.rt.node_persistent_state(job, "coder")["last"]
        self.assertNotIn("includeTests", got)      # 契约里有，但没人给，就不该出现


class TestContractIdentity(ContractTestCase):

    def test_R5_contracts_are_immutable_and_version_pinned(self):
        with self.assertRaises(InvariantError):
            self.rt.register_contract("PlanResult", 2, {"type": "object"})
        with self.assertRaises(InvariantError) as cm:
            self.rt._contract("PlanResult")        # 裸 id
        self.assertIn("精确到版本", str(cm.exception))
        with self.assertRaises(InvariantError):
            self.rt._contract("PlanResult@9")      # 不存在的版本


class TestAgentOutputContract(ContractTestCase):

    def _agent_env(self, *, with_edge=False, emit_contract=True):
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        out_ep = {"emit": {"PUSH": {"contract": "PlanResult@2"}}} if emit_contract else {}
        nodes = {
            "worker": {"kind": "agent", "spec": "w",
                       "endpoints": {"io": {}, "out": out_ep}},
        }
        edges = []
        if with_edge:
            nodes["sink"] = {"kind": "plain", "handler": "record",
                             "endpoints": {"io": {}}}
            edges = [{"id": "e1", "from": "worker.out", "to": "sink.io"}]
        tpl = self.rt.register_graph_template(
            f"a-{with_edge}-{emit_contract}-{len(self.rt._templates)}",
            {"nodes": nodes, "edges": edges})
        return self.rt.instantiate(tpl, owner="service:job")

    def test_OC1_output_contract_schema_is_derived_from_emit_endpoints(self):
        """★ OutputContract.schema 不是空壳：从 emit 端点契约推导 port 枚举与 payload 约束。"""
        from nodeflow_v4 import ExecutionResult
        job = self._agent_env(with_edge=True)
        self.rt.send((job, "worker", "io"), {"task": "t"})
        eid, req = self.rt.begin_execution(job, "worker")
        schema = req.output_contract.schema
        self.assertEqual(schema["properties"]["port"]["enum"], ["out"])
        self.assertIn("oneOf", schema["properties"]["payload"])
        variant = schema["properties"]["payload"]["oneOf"][0]
        self.assertEqual(variant["properties"]["port"], {"const": "out"})
        self.assertIn("planRef", variant["properties"]["payload"]["required"])
        self.rt.apply_execution(
            eid, ExecutionResult(execution_id=eid,
                                 emissions=(("out", {"planRef": "p@1"}),)))

    def test_OC2_emit_contract_is_enforced_even_without_an_edge(self):
        """声明了 emit 契约的端口，即使没有出边也要在 apply 拒绝违约 payload。"""
        from nodeflow_v4 import ExecutionResult
        job = self._agent_env(with_edge=False)
        backend = self.rt._backend
        backend.on("w", lambda req: ExecutionResult(
            execution_id=req.execution_id, emissions=(("out", {"wrong": 1}),)))
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)                       # 不再穿透 drain
        recs = self.rt.node_executions(job, "worker")
        self.assertEqual([r.status for r in recs], ["FAILED"])
        self.assertTrue(all(m.state == "FAILED"
                            for m in self.rt._messages.values()
                            if m.target[0] == job))

    def test_OC3_reply_is_only_a_callback_channel_not_a_free_port(self):
        """裸 "reply" 端口不可自由选择：无 callback 时按未声明端口拒绝。"""
        from nodeflow_v4 import ExecutionResult
        job = self._agent_env(with_edge=False, emit_contract=False)
        backend = self.rt._backend
        backend.on("w", lambda req: ExecutionResult(
            execution_id=req.execution_id, emissions=(("reply", {"x": 1}),)))
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)
        self.assertEqual([r.status for r in self.rt.node_executions(job, "worker")],
                         ["FAILED"])

    def test_OC4_reply_with_callback_is_delivered_through_the_channel(self):
        """携带 callback 的输入，其 "reply" 回程正常投递 —— 不变量 M3 不回归。"""
        from nodeflow_v4 import ExecutionResult
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.rt.register_topic("svc", request_contract={"type": "object"})
        tpl = self.rt.register_graph_template("oc-svc", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
            "subscriptions": [{"topic": "svc", "endpoint": "worker.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:job")
        backend = self.rt._backend
        calls: list[bool] = []

        def worker(req):
            if not calls:
                calls.append(True)
                return ExecutionResult(
                    execution_id=req.execution_id,
                    emissions=(("reply", {"echo": req.context.messages[0]}),))
            # REPLY 到达调用方端点后就是普通输入；这里空输出即可消费
            return ExecutionResult(execution_id=req.execution_id)

        backend.on("w", worker)
        self.rt.publish("svc", {"q": 1}, callback=(job, "worker", "io"))
        self.rt.drain(job)
        replies = [m for m in self.rt._messages.values() if m.mkind == "REPLY"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0].state, "CONSUMED")
        self.assertEqual(replies[0].payload, {"echo": {"q": 1}})


if __name__ == "__main__":
    unittest.main(verbosity=2)
