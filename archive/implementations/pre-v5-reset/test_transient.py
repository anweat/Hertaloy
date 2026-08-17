"""Phase 4 —— transient 上下文生产路径

transient 语义：下一次 claim 进入请求、之后自动清空；持久化时保留，
保证 PAUSED 期间追加的临时资料跨重启不丢。

运行：python -m unittest test_transient -v
"""

from __future__ import annotations

import os
import tempfile
import unittest

from nodeflow_persistence import SqlitePersistence
from nodeflow_v4 import ExecutionResult, MockExecutionBackend, Runtime


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class TransientTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.backend.on("w", lambda req: _ok(req))

    def _job(self):
        tpl = self.rt.register_graph_template("t", {
            "nodes": {"w": {"kind": "agent", "spec": "w",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:job")


class TestTransientLifecycle(TransientTestCase):

    def test_T1_transient_enters_next_request_then_clears(self):
        job = self._job()
        self.rt.append_context_transient(job, "w", {"hint": "this round"})
        self.rt.send((job, "w", "io"), {"task": 1})
        self.rt.drain(job)
        first = self.backend.last_request_for("w")
        self.assertEqual(first.context.transient, ({"hint": "this round"},))

        self.rt.send((job, "w", "io"), {"task": 2})
        self.rt.drain(job)
        second = self.backend.last_request_for("w")
        self.assertEqual(second.context.transient, (), "transient 没被清空")

    def test_T2_transient_is_per_node_instance(self):
        """同实例不同节点、不同实例互不串扰。"""
        self.rt.compile_agent_spec("w2", model="m", cards=[("rules", "base")])
        self.backend.on("w2", lambda req: _ok(req))
        tpl = self.rt.register_graph_template("t2", {
            "nodes": {
                "w": {"kind": "agent", "spec": "w", "endpoints": {"io": {}}},
                "w2": {"kind": "agent", "spec": "w2", "endpoints": {"io": {}}},
            },
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.append_context_transient(job, "w", "only-w")
        self.rt.send((job, "w2", "io"), {"task": 1})
        self.rt.drain(job)
        self.assertEqual(self.backend.last_request_for("w2").context.transient, ())


class TestTransientPersistence(TransientTestCase):

    def test_T3_transient_survives_restart(self):
        fd, db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(db)
        try:
            rt, backend, tpl, p = self.rt, self.backend, None, None
            tpl = rt.register_graph_template("t", {
                "nodes": {"w": {"kind": "agent", "spec": "w",
                                "endpoints": {"io": {}}}},
                "edges": [],
            })
            p = SqlitePersistence(db)
            p.attach(rt)
            job = rt.instantiate(tpl, owner="service:job")
            rt.append_context_transient(job, "w", {"hint": "kept"})
            p.flush(rt)
            del rt

            rt2 = Runtime()
            backend2 = MockExecutionBackend()
            rt2.set_backend(backend2)
            rt2.register_card(kind="rules", card_id="base", version=1, body={})
            rt2.compile_agent_spec("w", model="m", cards=[("rules", "base")])
            backend2.on("w", lambda req: _ok(req))
            rt2.register_graph_template("t", {
                "nodes": {"w": {"kind": "agent", "spec": "w",
                                "endpoints": {"io": {}}}},
                "edges": [],
            })
            p2 = SqlitePersistence(db)
            p2.restore(rt2)
            p2.attach(rt2)

            rt2.send((job, "w", "io"), {"task": 1})
            rt2.drain(job)
            self.assertEqual(backend2.last_request_for("w").context.transient,
                             ({"hint": "kept"},))
        finally:
            try:
                p.close()
            except Exception:
                pass
            try:
                p2.close()
            except Exception:
                pass
            if os.path.exists(db):
                os.unlink(db)


if __name__ == "__main__":
    unittest.main(verbosity=2)
