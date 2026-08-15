"""V4 Strategy 选择/输出策略轴 —— 从 V2 移植并适配 V4 决策格式

覆盖：
  selection  TOP_ONE(DISCARD/RETAIN) / ONE_PER_INPUT / CROSS_ALL
  output     WAIT_ALL / CROSS(left,right,target)
默认 FIRST 与 FANOUT_TO_SLOT 由 test_foundation_v4 的 B/C 组覆盖。

运行：python -m unittest test_strategy_policies -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import InvariantError, Runtime


class StrategyPolicyTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].setdefault("seen", []).append(p))

    def _strategy(self, *, policy, handler, inputs=("in",), ports=("out",),
                  edges=True):
        self.rt.register_policy("p", policy)
        self.rt.register_handler("h", handler)
        nodes = {
            "s": {"kind": "strategy", "policy": "p", "handler": "h",
                  "endpoints": {ep: {} for ep in (*inputs, *ports)}},
        }
        edge_list = []
        if edges:
            nodes["sink"] = {"kind": "plain", "handler": "record",
                             "endpoints": {"io": {}}}
            for port in ports:
                edge_list.append({"id": f"e-{port}", "from": f"s.{port}",
                                  "to": "sink.io"})
        tpl = self.rt.register_graph_template(
            f"t{len(self.rt._templates)}", {"nodes": nodes, "edges": edge_list})
        return self.rt.instantiate(tpl, owner="service:job")

    def seen(self, job):
        return self.rt.node_persistent_state(job, "sink").get("seen", [])


class TestSelection(StrategyPolicyTestCase):

    def test_S1_top_one_discard_consumes_unselected(self):
        """TOP_ONE + DISCARD：只把最高项交给 handler，落选同批消费不滞留。"""
        job = self._strategy(
            policy={"readiness": "ANY", "selection": "TOP_ONE",
                    "rankField": "rank", "unselected": "DISCARD"},
            handler=lambda payloads, ctx: {"emit": {"out": payloads["in"]}},
        )
        self.rt.send((job, "s", "in"), {"id": "low", "rank": 1})
        self.rt.send((job, "s", "in"), {"id": "high", "rank": 9})
        self.rt.drain(job)

        self.assertEqual(self.seen(job), [{"id": "high", "rank": 9}])
        states = {m.payload.get("id"): m.state for m in self.rt._messages.values()}
        self.assertEqual(states, {"low": "CONSUMED", "high": "CONSUMED"})

    def test_S2_top_one_retain_keeps_losers_queued(self):
        """TOP_ONE + RETAIN（默认）：落选留在 QUEUED，下一轮继续参与。"""
        job = self._strategy(
            policy={"readiness": "ANY", "selection": "TOP_ONE", "rankField": "rank"},
            handler=lambda payloads, ctx: {"emit": {"out": payloads["in"]}},
        )
        self.rt.send((job, "s", "in"), {"id": "low", "rank": 1})
        self.rt.send((job, "s", "in"), {"id": "high", "rank": 9})
        self.rt.step(job)                     # 策略只提交一轮：high 入选
        states = {m.payload.get("id"): m.state
                  for m in self.rt._messages.values()
                  if m.target[1] == "s"}       # 只看策略输入，别把下游同 payload 算进来
        self.assertEqual(states["high"], "CONSUMED")
        self.assertEqual(states["low"], "QUEUED",
                         "RETAIN 的落选者不应被本轮消费")

        self.rt.drain(job)                    # 落选仍在队列，下一轮排空
        self.assertEqual(self.seen(job), [
            {"id": "high", "rank": 9}, {"id": "low", "rank": 1}])

    def test_S3_one_per_input_joins_atomically(self):
        """ONE_PER_INPUT：每个必需端点原子取一条，handler 得到单值 JOIN。"""
        job = self._strategy(
            inputs=("left", "right"),
            policy={"readiness": "ALL_REQUIRED",
                    "required_inputs": ["left", "right"],
                    "selection": "ONE_PER_INPUT"},
            handler=lambda payloads, ctx: {"emit": {
                "out": {"left": payloads["left"], "right": payloads["right"]}}},
        )
        self.rt.send((job, "s", "left"), {"a": 1})
        self.rt.drain(job)
        self.assertEqual(self.seen(job), [])
        self.rt.send((job, "s", "right"), {"b": 2})
        self.rt.drain(job)
        self.assertEqual(self.seen(job), [{"left": {"a": 1}, "right": {"b": 2}}])

    def test_S4_cross_all_gives_full_lists_and_cross_pairs(self):
        """CROSS_ALL：每个端点拿全量列表，ctx.crossPairs 给出本批笛卡尔积。"""
        job = self._strategy(
            inputs=("left", "right"),
            policy={"readiness": "ALL_REQUIRED",
                    "required_inputs": ["left", "right"],
                    "selection": "CROSS_ALL"},
            handler=lambda payloads, ctx: {"emit": {"out": [
                {"left": l["v"], "right": r["v"]}
                for l, r in ctx["crossPairs"]
            ]}},
        )
        for v in ("L1", "L2"):
            self.rt.send((job, "s", "left"), {"v": v})
        for v in ("R1", "R2"):
            self.rt.send((job, "s", "right"), {"v": v})
        self.rt.drain(job)

        self.assertEqual(self.seen(job), [
            {"left": "L1", "right": "R1"}, {"left": "L1", "right": "R2"},
            {"left": "L2", "right": "R1"}, {"left": "L2", "right": "R2"},
        ])


class TestOutput(StrategyPolicyTestCase):

    def test_S5_wait_all_stages_then_emits_together(self):
        """WAIT_ALL：各轮结果暂存节点状态，凑齐 required_outputs 后一起发。"""
        def handler(payloads, ctx):
            round_no = ctx["state"].get("round", 0) + 1
            ctx["state"]["round"] = round_no
            port = "a" if round_no == 1 else "b"
            return {"emit": {port: payloads["in"]}}

        job = self._strategy(
            ports=("a", "b"),
            policy={"readiness": "ANY",
                    "output": {"mode": "WAIT_ALL",
                               "required_outputs": ["a", "b"]}},
            handler=handler,
        )
        self.rt.send((job, "s", "in"), {"round": 1})
        self.rt.drain(job)
        self.assertEqual(self.seen(job), [], "第一轮就路由了 —— WAIT_ALL 没生效")

        self.rt.send((job, "s", "in"), {"round": 2})
        self.rt.drain(job)
        self.assertEqual(self.seen(job), [{"round": 1}, {"round": 2}])

    def test_S6_cross_output_expands_two_candidate_sets(self):
        """CROSS(left,right,target)：left/right 是候选集不是路由端口。"""
        job = self._strategy(
            policy={"readiness": "ANY",
                    "output": {"mode": "CROSS", "left": "left", "right": "right",
                               "target": "out"}},
            handler=lambda payloads, ctx: {"emit": {
                "left": [{"n": 1}, {"n": 2}],
                "right": [{"c": "a"}, {"c": "b"}],
            }},
        )
        self.rt.send((job, "s", "in"), {"go": True})
        self.rt.drain(job)

        self.assertEqual(self.seen(job), [
            {"left": {"n": 1}, "right": {"c": "a"}},
            {"left": {"n": 1}, "right": {"c": "b"}},
            {"left": {"n": 2}, "right": {"c": "a"}},
            {"left": {"n": 2}, "right": {"c": "b"}},
        ])


class TestPolicyValidation(StrategyPolicyTestCase):

    def test_S7_illegal_policy_shapes_are_rejected_at_registration(self):
        cases = [
            {"selection": "TELEPATHY"},
            {"selection": "CROSS_ALL", "required_inputs": ["a"]},
            {"selection": "TOP_ONE", "unselected": "MAYBE"},
            {"output": {"mode": "WAIT_ALL"}},
            {"output": {"mode": "CROSS", "left": "l", "right": "r"}},
        ]
        for policy in cases:
            with self.subTest(policy=policy):
                pid = f"bad{len(self.rt._policies)}"
                self.rt.register_policy(pid, dict(policy))
                with self.assertRaises(InvariantError):
                    self.rt.register_graph_template("bad-tpl", {
                        "nodes": {"s": {"kind": "strategy", "policy": pid,
                                        "handler": "h",
                                        "endpoints": {"io": {}, "out": {}}}},
                        "edges": [],
                    })


if __name__ == "__main__":
    unittest.main(verbosity=2)
