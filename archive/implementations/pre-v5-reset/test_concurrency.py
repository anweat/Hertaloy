"""真并发 —— 证伪或坐实"冲突域是节点级"这条设计

E5 在单线程里模拟了"A claim → B 跑完 → A apply"。本文件用**真线程**跑，
看会不会冒出别的竞态。

关键性质：
  N1  agent 执行确实并行（不是被锁串行掉）
  N2  同一条消息不会被两个线程消费
  N3  不同节点可以真正并发提交（冲突域节点级，非容器级）
  N4  版本号在并发写入下仍单调唯一（★V1）
  N5  提交序号不丢不重
  N6  并行容器实例互不串状态
  N7  执行记录不出现幽灵状态

运行：python -m unittest test_concurrency -v
"""

from __future__ import annotations

import threading
import time
import unittest

from nodeflow_v4 import ExecutionResult, MockExecutionBackend, Runtime, Usage


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class SlowBackend(MockExecutionBackend):
    """每次执行睡一会儿，强制制造重叠窗口。"""

    def __init__(self, delay: float = 0.08) -> None:
        super().__init__()
        self.delay = delay
        self.concurrent_peak = 0
        self._active = 0
        self._lock = threading.Lock()

    def run(self, request):
        with self._lock:
            self._active += 1
            self.concurrent_peak = max(self.concurrent_peak, self._active)
        try:
            time.sleep(self.delay)
            return super().run(request)
        finally:
            with self._lock:
                self._active -= 1


def _fanout_template(rt: Runtime, n: int) -> str:
    """一个 strategy 展开 n 个并行子容器，每个子容器跑一个 agent。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("worker", model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    rt.register_handler(
        "split", lambda payloads, ctx: {"items": [{"i": i} for i in range(n)]}
    )
    rt.register_policy("split-policy", {
        "readiness": "ANY",
        "output": {"mode": "FANOUT_TO_SLOT", "slot": "workers"},
    })

    child = rt.register_graph_template("child-flow", {
        "nodes": {
            "agent": {"kind": "agent", "spec": "worker",
                      "endpoints": {"io": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "record",
                     "endpoints": {"io": {}}},
        },
        "edges": [{"id": "c1", "from": "agent.out", "to": "sink.io"}],
    })
    return rt.register_graph_template("fanout-flow", {
        "nodes": {
            "split": {"kind": "strategy", "policy": "split-policy",
                      "handler": "split", "endpoints": {"io": {}}},
        },
        "edges": [],
        "slots": {"workers": {"template": child, "instantiation": "PER_CALL",
                              "entry": "agent.io"}},
    })


class TestConcurrency(unittest.TestCase):

    def setUp(self):
        self.rt = Runtime()
        self.backend = SlowBackend(delay=0.08)
        self.rt.set_backend(self.backend)

    # ---- N1 / N6 ----------------------------------------------------------

    def test_N1_agent_executions_actually_overlap(self):
        """★并行的意义：agent 执行必须在锁外，真正重叠。

        8 个子容器 × 80ms。串行 ≥ 0.64s；并行应显著更快，且峰值并发 > 1。
        """
        n = 8
        tpl = _fanout_template(self.rt, n)
        self.backend.on("worker", lambda req: _ok(
            req, emissions=(("out", {"done": req.context.messages[0]["i"]}),)))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})

        t0 = time.monotonic()
        self.rt.drain_concurrent(workers=4)
        elapsed = time.monotonic() - t0

        kids = self.rt.children_of(job, "workers")
        self.assertEqual(len(kids), n)
        self.assertGreater(self.backend.concurrent_peak, 1,
                           "agent 执行被锁串行掉了 —— 并行没有生效")
        self.assertLess(elapsed, n * self.backend.delay,
                        f"耗时 {elapsed:.2f}s 接近串行，并行无效")

    def test_N6_parallel_instances_do_not_share_state(self):
        """并行容器实例互不串状态。"""
        n = 6
        tpl = _fanout_template(self.rt, n)
        self.backend.on("worker", lambda req: _ok(
            req, emissions=(("out", {"i": req.context.messages[0]["i"]}),)))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})
        self.rt.drain_concurrent(workers=4)

        seen = [self.rt.node_persistent_state(k, "sink")["last"]["i"]
                for k in self.rt.children_of(job, "workers")]
        self.assertEqual(sorted(seen), list(range(n)))

    # ---- N2 / N5 ----------------------------------------------------------

    def test_N2_no_message_is_consumed_twice(self):
        """同一条消息不会被两个线程消费。"""
        n = 10
        tpl = _fanout_template(self.rt, n)
        seen: list[str] = []
        seen_lock = threading.Lock()

        def worker(req):
            with seen_lock:
                seen.append(req.execution_id)
            return _ok(req, emissions=(("out", {}),))

        self.backend.on("worker", worker)
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})
        self.rt.drain_concurrent(workers=6)

        self.assertEqual(len(seen), len(set(seen)), "同一执行被跑了两次")
        self.assertEqual(len(seen), n)
        states = [m.state for m in self.rt._messages.values()]
        self.assertNotIn("QUEUED", states, "有消息没被消费")
        self.assertNotIn("CLAIMED", states, "有消息卡在 CLAIMED")

    def test_N5_commit_sequence_is_dense_and_unique(self):
        """提交序号不丢不重：每个实例的 run 快照 seq 连续。"""
        n = 8
        tpl = _fanout_template(self.rt, n)
        self.backend.on("worker", lambda req: _ok(req, emissions=(("out", {}),)))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})
        self.rt.drain_concurrent(workers=5)

        for gid in [job, *self.rt.children_of(job, "workers")]:
            seqs = [ov.body["seq"] for ov in self.rt.store.history(f"run/{gid}")]
            self.assertEqual(len(seqs), len(set(seqs)), f"{gid} 序号重复")
            self.assertEqual(seqs, sorted(seqs), f"{gid} 序号乱序")

    # ---- N3：E5 的真线程版本 ----------------------------------------------

    def test_N3_two_nodes_commit_concurrently_without_conflict(self):
        """★★ E5 的真线程版本：冲突域是节点级，不是容器级。

        同一容器内两个 agent 节点并发执行并提交。若冲突域是容器级
        （容器 seq 做 base 检查），后提交者必然失败。
        """
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        for spec in ("a", "b"):
            self.rt.compile_agent_spec(spec, model="m", cards=[("rules", "base")])
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        tpl = self.rt.register_graph_template("two-agent", {
            "nodes": {
                "a": {"kind": "agent", "spec": "a", "endpoints": {"io": {}, "out": {}}},
                "b": {"kind": "agent", "spec": "b", "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
            },
            "edges": [
                {"id": "ea", "from": "a.out", "to": "sink.io"},
                {"id": "eb", "from": "b.out", "to": "sink.io"},
            ],
        })
        self.backend.on("a", lambda req: _ok(req, emissions=(("out", {"who": "a"}),)))
        self.backend.on("b", lambda req: _ok(req, emissions=(("out", {"who": "b"}),)))

        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "a", "io"), {"t": "a"})
        self.rt.send((job, "b", "io"), {"t": "b"})
        self.rt.drain_concurrent(workers=2)

        for node in ("a", "b"):
            statuses = [r.status for r in self.rt.node_executions(job, node)]
            self.assertIn("APPLIED", statuses, f"节点 {node} 没有成功提交")
            self.assertNotIn("FAILED", statuses,
                             f"节点 {node} 因容器级冲突被作废 —— 冲突域设计错了")
        self.assertGreater(self.backend.concurrent_peak, 1)

    # ---- N4 ---------------------------------------------------------------

    def test_N4_version_allocation_is_race_free(self):
        """★V1：并发写入下版本号仍单调唯一。"""
        store = self.rt.store
        errors: list[BaseException] = []

        def spam(base: int) -> None:
            try:
                for i in range(60):
                    store.put("hot", "probe", {"w": base, "i": i})
            except BaseException as exc:            # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=spam, args=(w,)) for w in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertFalse(errors)
        versions = [ov.version for ov in store.history("hot")]
        self.assertEqual(versions, list(range(1, 6 * 60 + 1)))
        self.assertEqual(len(set(ov.content_hash for ov in store.history("hot"))),
                         6 * 60, "内容寻址在并发下出现碰撞或丢失")

    # ---- N7 ---------------------------------------------------------------

    def test_N7_no_ghost_execution_records(self):
        """执行记录不出现幽灵：排空后不应还有 RUNNING。"""
        n = 8
        tpl = _fanout_template(self.rt, n)
        self.backend.on("worker", lambda req: _ok(
            req, emissions=(("out", {}),), usage=Usage(out_tokens=1)))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})
        self.rt.drain_concurrent(workers=4)

        running = [r for r in self.rt._records.values() if r.status == "RUNNING"]
        self.assertEqual(running, [], "排空后仍有 RUNNING 记录")
        applied = [r for r in self.rt._records.values() if r.status == "APPLIED"]
        self.assertEqual(len(applied), n)
        self.assertEqual(self.rt._inflight, 0, "在途计数没有归零")

    # ---- 单线程路径不受影响 ------------------------------------------------

    def test_N8_single_threaded_drain_still_works(self):
        """重构后 drain() 语义不变。"""
        n = 4
        tpl = _fanout_template(self.rt, n)
        self.backend.delay = 0.0
        self.backend.on("worker", lambda req: _ok(req, emissions=(("out", {}),)))
        job = self.rt.instantiate(tpl, owner="service:job")
        self.rt.send((job, "split", "io"), {"go": True})
        self.rt.drain()
        self.assertEqual(len(self.rt.children_of(job, "workers")), n)
        self.assertEqual(self.rt._inflight, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
