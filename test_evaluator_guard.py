"""evaluator 守门 —— 第一不变量在策略节点上的落点

策略节点的 evaluator 一旦由模型驱动，它的返回值会直接变成**实例化子容器**、
**路由决策**、**版本锚点**。这是全系统最危险的一处输入。

信任分层：
  受信 handler（我们自己写的 Python）  → 可返回 emit / items / annotate
  **模型驱动的 evaluator**            → **只能返回 emit**
      items   会实例化子容器 —— 那是构造，不是选择
      annotate 会写版本锚点 —— 那是构造，不是选择

运行：python -m unittest test_evaluator_guard -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import (
    ExecutionResult,
    InvariantError,
    MockExecutionBackend,
    Runtime,
)


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class GuardTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})

    def _graph(self, *, decision=None, policy=None, model_eval=False,
               child_template=None):
        """gate(strategy) -> sink，evaluator 返回 decision。"""
        self.rt.register_handler("gate", lambda payloads, ctx: decision)
        self.rt.register_policy("p", policy or {"readiness": "ANY", "output": {}})
        gate = {"kind": "strategy", "policy": "p",
                "endpoints": {"io": {}, "out": {}, "alt": {}}}
        if model_eval:
            self.rt.compile_agent_spec("judge", model="m", cards=[("rules", "base")])
            gate["evaluator"] = {"kind": "model", "spec": "judge"}
        else:
            gate["handler"] = "gate"
        spec = {
            "nodes": {
                "gate": gate,
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "gate.out", "to": "sink.io"}],
        }
        if child_template:
            spec["slots"] = {"workers": {"template": child_template,
                                         "instantiation": "PER_CALL",
                                         "entry": "w.io"}}
        tpl = self.rt.register_graph_template("guard-flow", spec)
        return self.rt.instantiate(tpl, owner="service:job")

    def _child(self):
        return self.rt.register_graph_template("child", {
            "nodes": {"w": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })


# ---------------------------------------------------------------------------
# 受信 handler：三种键都允许，但仍要合规
# ---------------------------------------------------------------------------


class TestTrustedEvaluator(GuardTestCase):

    def test_V1_valid_decision_passes(self):
        job = self._graph(decision={"emit": {"out": {"ok": True}}})
        self.rt.send((job, "gate", "io"), {})
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"],
                         {"ok": True})

    def test_V2_unknown_top_level_key_is_rejected(self):
        """evaluator 不能发明字段。"""
        job = self._graph(decision={"emit": {"out": {}}, "spawn_shell": True})
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("spawn_shell", str(cm.exception))

    def test_V3_undeclared_port_is_rejected(self):
        """★第一不变量：只能选已声明的端口。"""
        job = self._graph(decision={"emit": {"nowhere": {}}})
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("nowhere", str(cm.exception))
        self.assertIn("可用", str(cm.exception))       # 错误信息要能指路

    def test_V4_items_without_fanout_policy_is_rejected(self):
        """policy 没声明 FANOUT_TO_SLOT，就不许返回 items。"""
        job = self._graph(decision={"items": [{"i": 1}]})
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("FANOUT_TO_SLOT", str(cm.exception))

    def test_V5_fanout_count_is_capped(self):
        """★ 防止一次判断炸出上千个容器实例。"""
        child = self._child()
        job = self._graph(
            decision={"items": [{"i": i} for i in range(50)]},
            policy={"readiness": "ANY",
                    "output": {"mode": "FANOUT_TO_SLOT", "slot": "workers",
                               "max_items": 8}},
            child_template=child,
        )
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("上限 8", str(cm.exception))

    def test_V5b_default_cap_applies_when_policy_is_silent(self):
        """policy 没写上限时用兜底值，不能无限。"""
        child = self._child()
        self.rt.default_max_fanout = 5
        job = self._graph(
            decision={"items": [{"i": i} for i in range(20)]},
            policy={"readiness": "ANY",
                    "output": {"mode": "FANOUT_TO_SLOT", "slot": "workers"}},
            child_template=child,
        )
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError):
            self.rt.drain(job)

    def test_V6_annotate_refs_must_be_exact_versions(self):
        """★V4：锚点只能引用精确版本，不能是 'latest' 或裸 id。"""
        job = self._graph(decision={"emit": {"out": {}},
                                    "annotate": {"object_refs": {"plan": "plan"}}})
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("精确版本引用", str(cm.exception))

    def test_V7_annotate_unknown_field_is_rejected(self):
        job = self._graph(decision={"emit": {"out": {}},
                                    "annotate": {"object_refs": {}, "exec": "rm -rf"}})
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        self.assertIn("exec", str(cm.exception))

    def test_V8_non_mapping_decision_is_rejected(self):
        job = self._graph(decision=["not", "a", "mapping"])
        self.rt.send((job, "gate", "io"), {})
        with self.assertRaises(InvariantError):
            self.rt.drain(job)


# ---------------------------------------------------------------------------
# 模型驱动：只能选端口
# ---------------------------------------------------------------------------


class TestModelEvaluator(GuardTestCase):

    def test_M1_model_can_choose_a_declared_port(self):
        """模型驱动的 evaluator 走三段式，选择已声明端口 → 正常路由。"""
        job = self._graph(model_eval=True)
        self.backend.on("judge", lambda req: _ok(
            req, emissions=(("out", {"verdict": "pass"}),)))
        self.rt.send((job, "gate", "io"), {})
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"],
                         {"verdict": "pass"})
        applied = [r for r in self.rt.node_executions(job, "gate")
                   if r.status == "APPLIED"]
        self.assertEqual(len(applied), 1)          # 判断本身也是一次可审计的执行

    def test_M2_model_cannot_emit_an_undeclared_port(self):
        """★第一不变量：端口枚举由 OutputContract 限死。"""
        job = self._graph(model_eval=True)
        self.backend.on("judge", lambda req: _ok(
            req, emissions=(("shell", {"cmd": "rm -rf /"}),)))
        self.rt.send((job, "gate", "io"), {})
        self.rt.drain(job)                     # 不再穿透 drain

        recs = [r for r in self.rt.node_executions(job, "gate")]
        self.assertEqual([r.status for r in recs], ["FAILED"])
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))
        gate_msgs = [m for m in self.rt._messages.values()
                     if m.target[0] == job and m.target[1] == "gate"]
        self.assertTrue(all(m.state == "FAILED" for m in gate_msgs))

    def test_M3_allowed_ports_come_from_declared_endpoints(self):
        """模型看到的可选项 == 节点已声明的端点，一个不多。"""
        job = self._graph(model_eval=True)
        self.backend.on("judge", lambda req: _ok(
            req, emissions=(("out", {}),)))
        self.rt.send((job, "gate", "io"), {})
        self.rt.drain(job)
        req = self.backend.last_request_for("judge")
        self.assertEqual(set(req.output_contract.allowed_emit_ports),
                         {"io", "out", "alt"})

    def test_M4_model_evaluator_runs_outside_the_lock(self):
        """模型判断是长执行，必须走 claim/execute/apply，不能占着锁。"""
        job = self._graph(model_eval=True)
        holder = {}

        def judge(req):
            # 执行期间锁必须是可获取的 —— 否则并行全废
            holder["acquired"] = self.rt._lock.acquire(blocking=False)
            if holder["acquired"]:
                self.rt._lock.release()
            return _ok(req, emissions=(("out", {}),))

        self.backend.on("judge", judge)
        self.rt.send((job, "gate", "io"), {})
        self.rt.drain(job)
        self.assertTrue(holder["acquired"], "模型 evaluator 执行时仍持有全局锁")


class TestModelCannotConstruct(GuardTestCase):
    """★★ 信任分层：模型只能选，不能构造。"""

    def _guard(self, decision):
        node = {"endpoints": {"io": {}, "out": {}}}
        policy = {"output": {"mode": "FANOUT_TO_SLOT", "slot": "w",
                             "max_items": 10}}
        return self.rt._guard_decision(node, policy, decision, trusted=False)

    def test_M5_model_cannot_return_items(self):
        """items 会实例化子容器 —— 那是构造。"""
        with self.assertRaises(InvariantError) as cm:
            self._guard({"items": [{"i": 1}]})
        self.assertIn("items", str(cm.exception))
        self.assertIn("不能构造", str(cm.exception))

    def test_M6_model_cannot_return_annotate(self):
        """annotate 会写版本锚点 —— 那是构造。"""
        with self.assertRaises(InvariantError) as cm:
            self._guard({"annotate": {"object_refs": {"plan": "plan@1"}}})
        self.assertIn("annotate", str(cm.exception))

    def test_M7_trusted_handler_may_do_both(self):
        """同样的 decision，受信 handler 允许 —— 差别只在信任层级。"""
        node = {"endpoints": {"io": {}, "out": {}}}
        policy = {"output": {"mode": "FANOUT_TO_SLOT", "slot": "w",
                             "max_items": 10}}
        ok = self.rt._guard_decision(
            node, policy,
            {"items": [{"i": 1}], "annotate": {"object_refs": {"plan": "plan@1"}}},
            trusted=True,
        )
        self.assertIn("items", ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
