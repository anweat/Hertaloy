"""sqlite 持久化 —— 崩溃接管从内存断言变成真能力

对应 FOUNDATION_V4.md 帧 14 与测试 E6。E6 在内存里证明了"RUNNING 记录可被
重新认领"；本文件证明**进程死掉之后**它依然成立。

运行：python -m unittest test_persistence -v
"""

from __future__ import annotations

import os
import tempfile
import unittest

from nodeflow_persistence import SqlitePersistence
from nodeflow_v4 import ExecutionResult, MockExecutionBackend, Runtime


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


def register_definitions(rt: Runtime, backend: MockExecutionBackend) -> str:
    """定义层不落盘 —— 重启后由装配面重新注册。handler 本就是函数，存不了。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("worker", model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    backend.on("worker", lambda req: _ok(
        req, emissions=(("out", {"done": True}),),
        artifacts=(("plan", "plan", {"n": 1}),),
    ))
    return rt.register_graph_template("persist-flow", {
        "nodes": {
            "worker": {"kind": "agent", "spec": "worker",
                       "endpoints": {"io": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "record",
                     "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
    })


class PersistenceTestCase(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(self.db)          # 让 sqlite 自己建
        self._open: list[SqlitePersistence] = []

    def tearDown(self):
        for p in self._open:
            p.close()
        if os.path.exists(self.db):
            os.unlink(self.db)

    def fresh_runtime(self):
        rt = Runtime()
        backend = MockExecutionBackend()
        rt.set_backend(backend)
        tpl = register_definitions(rt, backend)
        p = SqlitePersistence(self.db)
        self._open.append(p)
        return rt, backend, tpl, p


class TestDurability(PersistenceTestCase):

    def test_S1_committed_state_survives_process_death(self):
        """跑一轮 → 进程死 → 重启 → 状态原样回来。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        job = rt.instantiate(tpl, owner="service:job", params={"context_head": ["d@1"]})
        rt.send((job, "worker", "io"), {"task": "t"})
        rt.drain(job)

        seq_before = rt.commit_seq(job)
        plan_before = rt.artifact_versions("plan")
        snaps_before = len(rt.store.history(f"run/{job}"))
        self.assertGreater(seq_before, 0)

        # —— 进程死掉 ——
        del rt

        rt2, _be2, _tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)

        self.assertEqual(rt2.graph_status(job), "OPEN")
        self.assertEqual(rt2.commit_seq(job), seq_before)
        self.assertEqual(rt2.artifact_versions("plan"), plan_before)
        self.assertEqual(len(rt2.store.history(f"run/{job}")), snaps_before)
        self.assertEqual(rt2.context_of(job, "worker").head, ("d@1",))
        self.assertEqual(rt2.node_persistent_state(job, "sink")["last"],
                         {"done": True})

    def test_S2_provenance_and_lineage_survive(self):
        """★V1/V2：版本、provenance、lineage 跨重启保持。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        job = rt.instantiate(tpl, owner="service:job")
        rt.send((job, "worker", "io"), {"task": "t"})
        rt.drain(job)

        ov_before = rt.store.head("plan")
        del rt

        rt2, _be2, _tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)
        ov = rt2.store.head("plan")

        self.assertEqual(ov.version, ov_before.version)
        self.assertEqual(ov.content_hash, ov_before.content_hash)
        self.assertEqual(ov.provenance.graph_instance_id, job)
        self.assertEqual(ov.provenance.node_id, "worker")
        self.assertIsNotNone(ov.provenance.execution_id)

    def test_S3_idempotency_holds_after_restore(self):
        """★V3：恢复后内容寻址仍然生效，不产生重复版本。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        rt.store.put("spec", "spec", {"a": 1})
        p.flush(rt)
        del rt

        rt2, _be2, _tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)
        again = rt2.store.put("spec", "spec", {"a": 1})     # 同内容
        self.assertEqual(again.version, 1)                  # 不是 2
        self.assertEqual(rt2.artifact_versions("spec"), [1])

    def test_S4_new_ids_do_not_collide_after_restore(self):
        """恢复后新分配的 id 必须越过已用最大值。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        job = rt.instantiate(tpl, owner="service:job")
        rt.send((job, "worker", "io"), {"task": "t"})
        rt.drain(job)
        used = set(rt._messages) | set(rt._instances) | set(rt._records)
        del rt

        rt2, _be2, tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)
        p2.attach(rt2)
        new_job = rt2.instantiate(tpl2, owner="service:job")
        self.assertNotIn(new_job, used)
        mid = rt2.send((new_job, "worker", "io"), {"task": "t2"})
        self.assertNotIn(mid, used)


class TestCrashRecovery(PersistenceTestCase):

    def test_S5_inflight_execution_is_reclaimable_after_restart(self):
        """★★ 帧 14 —— E6 的真实版本。

        claim 之后进程死掉；重启后 RUNNING 记录仍在，输入退回可认领，
        续跑能把这一轮跑完。
        """
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        job = rt.instantiate(tpl, owner="service:job")
        rt.send((job, "worker", "io"), {"task": "t"})

        eid, _req = rt.begin_execution(job, "worker")   # claim 了，还没 apply
        p.flush(rt)                                    # claim 也是状态，要落盘
        self.assertIn(eid, p.stale_executions())

        # —— 进程在这里死掉 ——
        del rt

        rt2, _be2, _tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)
        p2.attach(rt2)

        recs = {r.execution_id: r.status
                for r in rt2.node_executions(job, "worker")}
        self.assertEqual(recs[eid], "RUNNING")          # 记录活下来了

        self.assertIn(eid, rt2.reclaim_stale_executions())
        rt2.drain(job)                                  # 重新认领并跑完

        applied = [r for r in rt2.node_executions(job, "worker")
                   if r.status == "APPLIED"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(rt2.node_persistent_state(job, "sink")["last"],
                         {"done": True})

    def test_S6_message_delivery_state_survives(self):
        """未消费的消息跨重启保留，不丢活也不重做。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        job = rt.instantiate(tpl, owner="service:job")
        rt.send((job, "worker", "io"), {"task": "a"})
        rt.drain(job)
        rt.send((job, "worker", "io"), {"task": "b"})    # 排着，没跑
        p.flush(rt)

        states_before = sorted(m.state for m in rt._messages.values())
        del rt

        rt2, _be2, _tpl2, p2 = self.fresh_runtime()
        p2.restore(rt2)
        self.assertEqual(sorted(m.state for m in rt2._messages.values()),
                         states_before)
        self.assertEqual(sum(1 for m in rt2._messages.values()
                             if m.state == "QUEUED"), 1)

        p2.attach(rt2)
        rt2.drain(job)                                   # 剩下那条被跑掉
        self.assertEqual(sum(1 for m in rt2._messages.values()
                             if m.state == "QUEUED"), 0)


class TestScope(PersistenceTestCase):

    def test_S7_definitions_are_not_persisted_by_design(self):
        """定义层不落盘 —— 装配面重新注册。这是设计，不是缺陷。"""
        rt, _be, tpl, p = self.fresh_runtime()
        p.attach(rt)
        rt.instantiate(tpl, owner="service:job")
        counts = p.counts()
        self.assertEqual(counts["instances"], 1)
        # 库里没有任何模板 / 卡片 / handler 表
        tables = {r[0] for r in p.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(
            tables,
            {"objects", "instances", "records", "messages", "subscriptions"},
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
