# -*- coding: utf-8 -*-
"""闭环契约修复回归 —— 对应 5 项修复：

    ① CALL 边在连接期被拒绝（不再静默降级为 PUSH）
    ② 同节点乐观并发冲突 → 释放退回可重试，不再崩溃卡死
    ③ 提交被拒（非法端口）→ FAILED 终态 + on_error 进图，不再卡死
    ④ WARM_POOL 重叠调用 → 忙时隔离优先（临时实例），不复用状态
    ⑤ publish 跳过 CLOSED 订阅者（不制造死信）

运行：python -m unittest test_closed_loop -v
"""

from __future__ import annotations

import time
import unittest

from nodeflow_v4 import (
    ExecutionRequest,
    ExecutionResult,
    InvariantError,
    MockExecutionBackend,
    Runtime,
)


def _ok(req: ExecutionRequest, **kw) -> ExecutionResult:
    return ExecutionResult(execution_id=req.execution_id, **kw)


class ClosedLoopFixTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})


# ---------------------------------------------------------------------------
# ① CALL 边连接期拒绝
# ---------------------------------------------------------------------------


class TestCallEdgeRejected(ClosedLoopFixTestCase):

    def test_T1_call_edge_is_rejected_at_registration(self):
        """operation="CALL" 的边必须在注册期被拒绝，而不是运行时静默当 PUSH 发。"""
        self.rt.register_contract("Task", 1, {"type": "object", "required": []})
        spec = {
            "nodes": {
                "a": {"kind": "agent", "spec": "w", "endpoints": {
                    "io": {}, "out": {"emit": {"CALL": {"contract": "Task@1"}}}}},
                "b": {"kind": "plain", "handler": "record", "endpoints": {
                    "io": {"receive": {"CALL": {"contract": "Task@1"}}}}},
            },
            "edges": [{"id": "e1", "from": "a.out", "to": "b.io", "operation": "CALL"}],
        }
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        with self.assertRaises(InvariantError) as cm:
            self.rt.register_graph_template("bad-call", spec)
        self.assertIn("PUSH", str(cm.exception))
        self.assertIn("M3", str(cm.exception))

    def test_T1b_any_non_push_operation_is_rejected(self):
        """REPLY / 任意未知 operation 同样拒绝 —— 边只实现 PUSH。"""
        spec = {
            "nodes": {"a": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [{"id": "e1", "from": "a.io", "to": "a.io", "operation": "REPLY"}],
        }
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("bad-reply", spec)


# ---------------------------------------------------------------------------
# ② 同节点乐观并发冲突 → 释放退回重试
# ---------------------------------------------------------------------------


class TestSameNodeConcurrency(ClosedLoopFixTestCase):

    def test_T2_same_node_claims_converge_without_crash(self):
        """两条消息真实重叠到同一 agent 节点时，drain_concurrent 收敛：

        后提交者被释放（输入退回 QUEUED）并被重新认领，最终两条都 APPLIED。
        修复前：InvariantError 穿透，执行永久 RUNNING、消息永久 CLAIMED。
        """
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("t2", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:x")

        slow_first = {"flag": True}
        def handler(req):
            if slow_first["flag"]:
                slow_first["flag"] = False
                time.sleep(0.4)          # 让第二个 claim 在第一个执行中发生
            return _ok(req, emissions=(("out", {"done": req.context.messages[0]}),))
        self.backend.on("w", handler)

        self.rt.send((job, "worker", "io"), {"task": "A"})
        self.rt.send((job, "worker", "io"), {"task": "B"})
        self.rt.drain_concurrent(job, workers=2, timeout=10)     # 不再 raise

        all_recs = self.rt.node_executions(job, "worker")
        self.assertEqual(len(all_recs), 3, all_recs)   # A(冲突失败) + B + A(重试成功)
        statuses = sorted(r.status for r in all_recs)
        self.assertEqual(statuses, ["APPLIED", "APPLIED", "FAILED"], all_recs)
        states = [m.state for m in self.rt._messages.values()
                  if m.target[0] == job]
        self.assertEqual(states, ["CONSUMED", "CONSUMED"])
        self.assertEqual(self.rt.node_persistent_state(job, "worker"), {})


# ---------------------------------------------------------------------------
# ③ 提交被拒 → FAILED 终态 + on_error 进图
# ---------------------------------------------------------------------------


class TestApplyRejected(ClosedLoopFixTestCase):

    def test_T3_undeclared_port_goes_to_failed_terminal_and_on_error(self):
        """非法端口：drain 不崩溃；执行 FAILED；消息终态 FAILED；
        若声明 on_error，错误沿边进入图。"""
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("t3", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "w", "on_error": "err",
                           "endpoints": {"io": {}, "out": {}, "err": {}}},
                "errsink": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "worker.err", "to": "errsink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.backend.on("w", lambda req: _ok(req, emissions=(("nowhere", {"x": 1}),)))

        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)                                  # 不 raise

        recs = [r for r in self.rt.node_executions(job, "worker")]
        self.assertEqual([r.status for r in recs], ["FAILED"])
        msgs = [m for m in self.rt._messages.values()
                if m.target[0] == job and m.target[1] == "worker"]
        self.assertTrue(all(m.state == "FAILED" for m in msgs),
                        [m.state for m in msgs])
        # 错误沿 on_error 边进入图，errsink 收到结构化错误
        err = self.rt.node_persistent_state(job, "errsink").get("last")
        self.assertIsNotNone(err)
        self.assertEqual(err["error"], "APPLY_REJECTED")
        self.assertEqual(err["node"], "worker")

    def test_T3b_no_on_error_keeps_failed_terminal_without_crash(self):
        """未声明 on_error：消息停在 FAILED 终态，drain 照常返回。"""
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("t3b", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.backend.on("w", lambda req: _ok(req, emissions=(("nowhere", 1),)))

        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertTrue(all(
            m.state == "FAILED" for m in self.rt._messages.values()
            if m.target[0] == job))


# ---------------------------------------------------------------------------
# ④ WARM_POOL 重叠调用隔离
# ---------------------------------------------------------------------------


class TestWarmPoolOverlap(ClosedLoopFixTestCase):

    def _env(self):
        def work(payload, ctx):
            ctx["state"].setdefault("seen", []).append(payload)
            return {"reply": {"reviewed": payload}}
        self.rt.register_handler("work", work)
        review_tpl = self.rt.register_graph_template("review", {
            "nodes": {"work": {"kind": "plain", "handler": "work",
                               "endpoints": {"io": {}}}},
            "edges": [],
        })
        tpl = self.rt.register_graph_template("caller", {
            "nodes": {
                "caller": {"kind": "subflow", "slot": "reviewers",
                           "return_port": "out", "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "caller.out", "to": "sink.io"}],
            "slots": {"reviewers": {"template": review_tpl,
                                    "instantiation": "WARM_POOL(2)",
                                    "entry": "work.io"}},
        })
        return self.rt.instantiate(tpl, owner="service:x")

    def test_T4_overlapping_calls_never_mix_state(self):
        """5 次调用同时排队、池容量 2：每个实例只见到自己那一轮。

        修复前：kid1 的 seen 混入 [0, 2, 4] —— 上一调用遗留消息在
        状态清空后才被处理。修复后：忙的池实例不复用，临时隔离实例承接。
        """
        job = self._env()
        for i in range(5):
            self.rt.send((job, "caller", "io"), {"round": i})
        self.rt.drain()

        # 池 bucket 保持 2 个；忙时隔离实例不记入池（临时扩容）
        self.assertEqual(len(self.rt.children_of(job, "reviewers")), 2)
        # 真正承接了调用的实例 = 所有收到过 work 消息的实例
        kids = sorted({m.target[0] for m in self.rt._messages.values()
                       if m.target[1] == "work"})
        self.assertTrue(len(kids) >= 2, kids)
        seen_lists = [self.rt.node_persistent_state(k, "work").get("seen", [])
                      for k in kids]
        # 隔离：每个实例的 seen 恰好一轮（修复前 kid1 会混入 [0, 2, 4]）
        for seen in seen_lists:
            self.assertEqual(len(seen), 1, seen)
        rounds = sorted(s["round"] for s in sum(seen_lists, []))
        self.assertEqual(rounds, list(range(5)))
        # 调用方收到全部 5 个回复
        self.assertEqual(
            self.rt.node_persistent_state(job, "sink").get("last", {}).get("reviewed"),
            {"round": 4})

    def test_T4b_serial_calls_still_reuse_the_pool(self):
        """串行调用（上一调用已排空）仍只复用 2 个池实例 —— D2 契约不回归。"""
        job = self._env()
        for i in range(5):
            self.rt.send((job, "caller", "io"), {"round": i})
            self.rt.drain()
        self.assertEqual(len(self.rt.children_of(job, "reviewers")), 2)

    def test_T4c_overflow_orphans_are_registered_and_collectable(self):
        """忙时扩容的孤儿实例：登记可见、空闲后可被 collect_orphans 回收。"""
        job = self._env()
        for i in range(5):
            self.rt.send((job, "caller", "io"), {"round": i})
        self.rt.drain()

        orphans = self.rt.overflow_children(job, "reviewers")
        self.assertEqual(len(orphans), 3, orphans)
        self.assertTrue(all(self.rt.graph_status(k) == "OPEN" for k in orphans))

        collected = self.rt.collect_orphans(job, slot_id="reviewers",
                                            actor="service:x")
        self.assertEqual(sorted(collected), sorted(orphans))
        self.assertEqual(self.rt.overflow_children(job, "reviewers"), [])
        self.assertTrue(all(self.rt.graph_status(k) == "CLOSED"
                            for k in collected))
        # 池 bucket 不变：孤儿不属于池
        self.assertEqual(len(self.rt.children_of(job, "reviewers")), 2)


# ---------------------------------------------------------------------------
# ⑤ publish 跳过 CLOSED 订阅者
# ---------------------------------------------------------------------------


class TestPublishSkipsClosed(ClosedLoopFixTestCase):

    def test_T5_closed_subscriber_is_skipped_open_receives(self):
        """CLOSED 订阅者被跳过（不制造死信），OPEN 订阅者正常收到。"""
        self.rt.register_topic("progress", request_contract={"type": "object"})
        tpl = self.rt.register_graph_template("t5", {
            "nodes": {"metrics": {"kind": "plain", "handler": "record",
                                  "endpoints": {"io": {}}}},
            "edges": [],
        })
        closed_job = self.rt.instantiate(tpl, owner="service:x")
        open_job = self.rt.instantiate(tpl, owner="service:y")
        self.rt.subscribe("progress", target=(closed_job, "metrics", "io"))
        self.rt.subscribe("progress", target=(open_job, "metrics", "io"))

        self.rt.control(closed_job, "close", actor="service:x")
        self.rt.publish("progress", {"pct": 50})
        self.rt.drain()

        # 只有 OPEN 实例收到；CLOSED 实例无任何消息
        self.assertEqual(
            self.rt.node_persistent_state(open_job, "metrics").get("last"),
            {"pct": 50})
        self.assertEqual(
            self.rt.node_persistent_state(closed_job, "metrics").get("last"), None)
        closed_msgs = [m for m in self.rt._messages.values()
                       if m.target[0] == closed_job]
        self.assertEqual(closed_msgs, [])
        self.assertEqual(self.rt.queue("progress").depth, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
