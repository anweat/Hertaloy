"""Phase 3 —— 预置策略模板测试

预置只是注册 policy + handler 的配置组合，不是内核类型；所有行为仍由
既有的 strategy / approval 语义承担。运行：
    python -m unittest test_presets -v
"""

from __future__ import annotations

import unittest

from nodeflow_presets import (
    STRATEGY_PRESETS,
    approval_node_preset,
    register_fanout_preset,
    register_fixed_rounds_preset,
    register_review_preset,
    register_threshold_loop_preset,
)
from nodeflow_v4 import Runtime


class PresetTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}))


class TestFanoutPreset(PresetTestCase):

    def test_P1_fanout_preset_spawns_parallel_children(self):
        child = self.rt.register_graph_template("child", {
            "nodes": {"w": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })
        register_fanout_preset(self.rt, policy_id="fan", handler_id="split",
                               slot="kids", max_items=10)
        tpl = self.rt.register_graph_template("parent", {
            "nodes": {"split": {"kind": "strategy", "policy": "fan",
                                "handler": "split", "endpoints": {"io": {}}}},
            "edges": [],
            "slots": {"kids": {"template": child,
                               "instantiation": "PER_CALL",
                               "entry": "w.io"}},
        })
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"items": [{"i": 1}, {"i": 2}, {"i": 3}]})
        self.rt.drain()

        kids = self.rt.children_of(job, "kids")
        self.assertEqual(len(kids), 3)
        for i, kid in enumerate(kids, start=1):
            self.assertEqual(self.rt.node_persistent_state(kid, "w")["last"],
                             {"i": i})


class TestReviewPreset(PresetTestCase):

    def test_P2_review_preset_joins_required_inputs(self):
        register_review_preset(self.rt, policy_id="review", handler_id="rv",
                               required_inputs=["a", "b"])
        tpl = self.rt.register_graph_template("review", {
            "nodes": {
                "rv": {"kind": "strategy", "policy": "review", "handler": "rv",
                       "endpoints": {"a": {}, "b": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "rv.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "rv", "a"), {"x": 1})
        self.rt.drain(job)
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))
        self.rt.send((job, "rv", "b"), {"y": 2})
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"],
                         {"merged": {"a": {"x": 1}, "b": {"y": 2}}})


class TestLoopPresets(PresetTestCase):

    def _loop_env(self, preset, worker_add=1):
        def worker(payload, ctx):
            ctx["state"]["runs"] = ctx["state"].get("runs", 0) + 1
            out = dict(payload)
            out["score"] = out.get("score", 0) + worker_add
            return {"out": out}

        self.rt.register_handler("worker", worker)
        tpl = self.rt.register_graph_template("loop", {
            "nodes": {
                "start": {"kind": "start", "emit": "out",
                          "endpoints": {"io": {}, "out": {}}},
                "worker": {"kind": "plain", "handler": "worker",
                           "endpoints": {"io": {}, "out": {}}},
                "gate": {"kind": "strategy", "policy": preset["policy"],
                         "handler": preset["handler"],
                         "endpoints": {"io": {}, "again": {}, "done": {}}},
                "end": {"kind": "end", "endpoints": {"io": {}}},
            },
            "edges": [
                {"id": "e1", "from": "start.out", "to": "worker.io"},
                {"id": "e2", "from": "worker.out", "to": "gate.io"},
                {"id": "e-again", "from": "gate.again", "to": "worker.io"},
                {"id": "e-done", "from": "gate.done", "to": "end.io"},
            ],
        })
        return self.rt.instantiate(tpl, owner="service:job")

    def test_P3_fixed_rounds_preset_loops_exactly_n_times(self):
        preset = register_fixed_rounds_preset(
            self.rt, policy_id="fixed", handler_id="fixed-h", rounds=3)
        job = self._loop_env(preset)
        self.rt.send((job, "start", "io"), {"score": 0})
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "worker")["runs"], 3)
        anns = self.rt.search_annotations(gid=job, tags={"fixed-rounds"})
        self.assertEqual([a.body["fields"]["epoch"] for a in anns], [1, 2, 3])

    def test_P4_threshold_loop_preset_exits_when_reached(self):
        preset = register_threshold_loop_preset(
            self.rt, policy_id="thr", handler_id="thr-h",
            field="score", threshold=3, mode="max")
        job = self._loop_env(preset)
        self.rt.send((job, "start", "io"), {"score": 0})
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "worker")["runs"], 4)
        anns = self.rt.search_annotations(gid=job, tags={"threshold-loop"})
        self.assertEqual(anns[-1].body["fields"]["score"], 4)


class TestHumanGatePreset(PresetTestCase):

    def test_P5_approval_node_preset_blocks_until_authorized(self):
        node = approval_node_preset(authorized_actors=["human:alice"])
        self.assertEqual(node["kind"], "approval")
        self.assertEqual(node["approve_port"], "out")

        tpl = self.rt.register_graph_template("gate-flow", {
            "nodes": {
                "start": {"kind": "start", "emit": "out",
                          "endpoints": {"io": {}, "out": {}}},
                "gate": approval_node_preset(authorized_actors=["human:alice"]),
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "gate.io"},
                      {"id": "e2", "from": "gate.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:job",
                                  controllers=("human:alice",))
        self.rt.send((job, "start", "io"), {"goal": "x"})
        self.rt.drain(job)
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))

        self.rt.approve(job, "gate", actor="human:alice", decision="allow")
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"],
                         {"goal": "x"})


class TestPresetRegistry(PresetTestCase):

    def test_P6_registry_lists_all_presets_as_plain_functions(self):
        self.assertEqual(set(STRATEGY_PRESETS),
                         {"fanout", "review", "fixed_rounds", "threshold_loop"})
        self.assertTrue(all(callable(fn) for fn in STRATEGY_PRESETS.values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
