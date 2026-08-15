"""Phase 3 —— Annotation 经验检索投影

Annotation 仍是普通 ObjectVersion；检索是纯查询投影，不引入新运行子系统。
查询语义：tags 是**要求子集**，object_refs 是**要求子集**，fields 精确匹配。

运行：python -m unittest test_annotation_search -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import Runtime


class AnnotationSearchTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}))

    def _annotating_flow(self):
        def gate(payloads, ctx):
            epoch = ctx["state"].get("epoch", 0) + 1
            ctx["state"]["epoch"] = epoch
            return {
                "annotate": {
                    "object_refs": {"plan": "plan@2", "spec": f"spec@{epoch}"},
                    "fields": {
                        "epoch": epoch,
                        "tags": ["rework", "coding"] if epoch == 1 else ["done"],
                    },
                },
                "emit": {"out": payloads["io"]},
            }

        self.rt.register_handler("gate", gate)
        self.rt.register_policy("p", {"readiness": "ANY"})
        tpl = self.rt.register_graph_template("flow", {
            "nodes": {
                "start": {"kind": "start", "emit": "out",
                          "endpoints": {"io": {}, "out": {}}},
                "gate": {"kind": "strategy", "policy": "p", "handler": "gate",
                         "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "gate.io"},
                      {"id": "e2", "from": "gate.out", "to": "sink.io"}],
        })
        return self.rt.instantiate(tpl, owner="service:job")

    def test_A1_search_by_tags_object_refs_and_fields(self):
        job = self._annotating_flow()
        self.rt.send((job, "start", "io"), {"n": 1})
        self.rt.send((job, "start", "io"), {"n": 2})
        self.rt.drain(job)

        self.assertEqual(len(self.rt.search_annotations(gid=job)), 2)

        rework = self.rt.search_annotations(tags={"rework"})
        self.assertEqual(len(rework), 1)
        self.assertEqual(rework[0].body["fields"]["epoch"], 1)

        done = self.rt.search_annotations(fields={"epoch": 2})
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0].body["fields"]["tags"], ["done"])

        by_plan = self.rt.search_annotations(object_refs={"plan": "plan@2"})
        self.assertEqual(len(by_plan), 2)

        both = self.rt.search_annotations(
            object_refs={"plan": "plan@2", "spec": "spec@1"})
        self.assertEqual(len(both), 1)

        none = self.rt.search_annotations(tags={"ghost"})
        self.assertEqual(none, [])

    def test_A2_search_is_scoped_per_instance(self):
        job_a = self._annotating_flow()
        self.rt.send((job_a, "start", "io"), {"n": 1})
        self.rt.drain(job_a)

        # 同模板另一实例：不带 gid 检索跨实例，带 gid 只查自己
        job_b = self.rt.instantiate(
            self.rt._instances[job_a].template_ref, owner="service:job-b")
        self.rt.send((job_b, "start", "io"), {"n": 9})
        self.rt.drain(job_b)

        self.assertEqual(len(self.rt.search_annotations()), 2)
        self.assertEqual(len(self.rt.search_annotations(gid=job_a)), 1)
        self.assertEqual(len(self.rt.search_annotations(gid=job_b)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
