# -*- coding: utf-8 -*-
"""健壮性测试 —— 正式开发前的加固批次（P0）

    R2/R3  未知目标友好报错（send/instantiate → InvariantError，不抛裸 KeyError）
    R4     SubprocessBackend 并发结果按 execution_id 路由（慢响应不串位）
    R5     approve deny 路径
    R6     BUDGET/CANCELLED 终止语义（不重试 / 输入保留）
    R7     INVALID_OUTPUT 执行面内耗尽（恰好 N 次，不无限重试）
    R8     持久化 restore 后完整续跑（PAUSED/tail/children/seq + resume 完成）
    R9     ALL_REQUIRED 批量汇聚（每端点多条 → 多轮原子 JOIN）
    R10    取值校验：enum/const/pattern（契约的值的维度）
    R11    PAUSED 订阅者接收并保留消息，resume 后消费
    R12    approve 无待审项 → 友好报错

运行：python -m unittest test_robustness -v
"""

from __future__ import annotations

import os
import threading
import time
import unittest

from nodeflow_v4 import (
    ExecutionRequest,
    ExecutionResult,
    InvariantError,
    InvocationContext,
    MockExecutionBackend,
    OutputContract,
    Runtime,
    Usage,
)
from nodeflow_adapters import SubprocessBackend
from nodeflow_persistence import SqlitePersistence

HERE = os.path.dirname(os.path.abspath(__file__))


def _ok(req: ExecutionRequest, **kw) -> ExecutionResult:
    return ExecutionResult(execution_id=req.execution_id, **kw)


class RobustnessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})


# ---------------------------------------------------------------------------
# R1 —— 外部 API 与调度并发安全
# ---------------------------------------------------------------------------


class TestExternalApiConcurrency(RobustnessTestCase):

    def test_R1_concurrent_publish_and_drain_do_not_corrupt(self):
        """外部 API（publish/send/control）与 drain 并发：不崩溃、消息最终一致。"""
        self.rt.register_topic("t", request_contract={"type": "object"})
        tpl = self.rt.register_graph_template("conc", {
            "nodes": {"m": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.rt.subscribe("t", target=(job, "m", "io"))
        errors: list[tuple] = []
        stop = threading.Event()

        def publisher():
            for i in range(50):
                if stop.is_set():
                    break
                try:
                    self.rt.publish("t", {"i": i})
                except Exception as exc:        # noqa: BLE001
                    errors.append(("publish", type(exc).__name__))
                time.sleep(0.001)

        def drainer():
            while not stop.is_set():
                try:
                    self.rt.step(job, max_commits=5)
                except Exception as exc:        # noqa: BLE001
                    errors.append(("drain", type(exc).__name__))
                    break
                time.sleep(0.001)

        t1 = threading.Thread(target=publisher)
        t2 = threading.Thread(target=drainer)
        t1.start(); t2.start()
        t1.join(timeout=5)
        stop.set()
        t2.join(timeout=5)
        self.assertEqual(errors, [], errors[:3])
        self.rt.drain(job)                      # 收尾排空
        self.assertEqual(self.rt.queue("t").depth, 0)
        self.assertTrue(all(
            m.state == "CONSUMED" for m in self.rt._messages.values()
            if m.target[0] == job))


# ---------------------------------------------------------------------------
# R2/R3 —— 未知目标友好报错
# ---------------------------------------------------------------------------


class TestUnknownTargets(RobustnessTestCase):

    def test_R2_send_to_nonexistent_instance_raises_invariant_error(self):
        with self.assertRaises(InvariantError):
            self.rt.send(("gi-nope", "worker", "io"), {"x": 1})

    def test_R3_instantiate_unknown_template_raises_invariant_error(self):
        with self.assertRaises(InvariantError):
            self.rt.instantiate("no-such@1", owner="service:x")


# ---------------------------------------------------------------------------
# R4 —— SubprocessBackend 并发结果路由
# ---------------------------------------------------------------------------


class TestSubprocessBackendConcurrency(unittest.TestCase):

    def test_R4_results_are_routed_by_execution_id(self):
        """慢请求（hang）与快请求并发：快请求必须拿到自己的结果，
        慢请求在 cancel 后拿到 CANCELLED。修复前：readline 乱序串位、
        hang 的 run 卡死到进程关闭。"""
        backend = SubprocessBackend(["node", os.path.join(HERE, "drivers", "fake_driver.mjs")],
                                    cwd=HERE)
        def make(i, hang=False):
            fake = {"emit": [{"port": "out", "payload": {"n": i}}]}
            if hang:
                fake["hang"] = True
            return ExecutionRequest(
                execution_id=f"exec-{i}",
                agent_spec={"spec_id": f"s{i}", "fake": fake},
                context=InvocationContext(),
                output_contract=OutputContract(allowed_emit_ports=("out",)),
            )
        results: dict[int, tuple] = {}
        def worker(i):
            try:
                r = backend.run(make(i, hang=(i == 0)))
                results[i] = (r.execution_id, r.termination, tuple(r.emissions))
            except Exception as e:          # noqa: BLE001
                results[i] = ("ERR", type(e).__name__, str(e)[:60])

        t0 = threading.Thread(target=worker, args=(0,))
        t1 = threading.Thread(target=worker, args=(1,))
        t0.start()
        time.sleep(0.2)                      # exec-0 先入队并挂起
        t1.start()
        time.sleep(0.5)                      # exec-1 应已返回自己的结果
        self.assertEqual(results.get(1), ("exec-1", "DONE", (("out", {"n": 1}),)),
                         results)

        backend.cancel("exec-0")
        t0.join(timeout=5)
        t1.join(timeout=5)
        r0 = results.get(0)
        self.assertEqual(r0[:2], ("exec-0", "CANCELLED"), results)   # 自己的结果
        self.assertFalse(t0.is_alive())
        backend.close()


# ---------------------------------------------------------------------------
# R5 —— approve deny 路径
# ---------------------------------------------------------------------------


class TestApproveDeny(RobustnessTestCase):

    def test_R5_deny_routes_to_deny_port(self):
        """审批拒绝 → 走 deny_port，不触发下游正常处理。"""
        self.rt.compile_agent_spec("planner", model="m", cards=[("rules", "base")])
        self.backend.on("planner", lambda req: _ok(
            req, emissions=(("out", {"plan": ["a"]}),)))
        tpl = self.rt.register_graph_template("approval", {
            "nodes": {
                "planner": {"kind": "agent", "spec": "planner",
                            "endpoints": {"io": {}, "out": {}}},
                "gate": {"kind": "approval",
                         "authorized_actors": ["human:alice"],
                         "approve_port": "ok", "deny_port": "denied",
                         "endpoints": {"io": {}, "ok": {}, "denied": {}}},
                "good": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
                "bad": {"kind": "plain", "handler": "record",
                        "endpoints": {"io": {}}},
            },
            "edges": [
                {"id": "e1", "from": "planner.out", "to": "gate.io"},
                {"id": "e2", "from": "gate.ok", "to": "good.io"},
                {"id": "e3", "from": "gate.denied", "to": "bad.io"},
            ],
        })
        job = self.rt.instantiate(tpl, owner="service:x",
                                  controllers=("human:alice",))
        self.rt.send((job, "planner", "io"), {"goal": "x"})
        self.rt.drain(job)

        self.rt.approve(job, "gate", actor="human:alice", decision="deny")
        self.rt.drain(job)
        self.assertEqual(self.rt.node_persistent_state(job, "bad").get("last"),
                         {"plan": ["a"]})
        self.assertNotIn("last", self.rt.node_persistent_state(job, "good"))

    def test_R12_approve_without_pending_raises(self):
        with self.assertRaises(InvariantError):
            self.rt.approve("gi-x", "gate", actor="human:alice", decision="allow")


# ---------------------------------------------------------------------------
# R6/R7 —— 终止语义
# ---------------------------------------------------------------------------


class TestTerminationSemantics(RobustnessTestCase):

    def _env(self):
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("term", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:x")

    def test_R6_budget_is_intent_not_failure_no_retry(self):
        """BUDGET = 意图（预算耗尽），不可重试 → 消息 FAILED 终态。"""
        job = self._env()
        calls = []
        self.backend.on("w", lambda req: (
            calls.append(1),
            _ok(req, termination="BUDGET"))[1])
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(len(calls), 1)      # 不重试
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertTrue(all(
            m.state == "FAILED" for m in self.rt._messages.values()
            if m.target[0] == job))

    def test_R6b_cancelled_keeps_input_requeued(self):
        """CANCELLED = 意图，输入退回 QUEUED，可重新认领。"""
        job = self._env()
        calls = []
        def flaky(req):
            calls.append(1)
            if len(calls) == 1:
                return _ok(req, termination="CANCELLED")
            return _ok(req, emissions=(("out", {"done": 1}),))
        self.backend.on("w", flaky)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(len(calls), 2)      # 取消后消息回 QUEUED → 重新认领
        statuses = [r.status for r in self.rt.node_executions(job, "worker")]
        self.assertIn("CANCELLED", statuses)
        self.assertIn("APPLIED", statuses)

    def test_R7_invalid_output_exhausts_in_plane_not_forever(self):
        """INVALID_OUTPUT 在执行面内重试，耗尽后 FAILED 终态，不无限重试。"""
        job = self._env()
        calls = []
        self.backend.on("w", lambda req: (
            calls.append(1),
            _ok(req, termination="INVALID_OUTPUT"))[1])
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(len(calls), self.rt.max_output_retries)   # 恰好 3 次
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])


# ---------------------------------------------------------------------------
# R8 —— 持久化 restore 完整续跑
# ---------------------------------------------------------------------------


class TestRestoreContinuation(RobustnessTestCase):

    def test_R8_paused_state_survives_restart_and_resume_completes(self):
        """PAUSED 实例（含 tail/children/seq）restore 后原样恢复，
        resume 后继续排空完成。"""
        def work(payload, ctx):
            return {"reply": {"r": payload}}
        self.rt.register_handler("work", work)
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        review_tpl = self.rt.register_graph_template("review", {
            "nodes": {"work": {"kind": "plain", "handler": "work",
                               "endpoints": {"io": {}}}},
            "edges": [],
        })
        tpl = self.rt.register_graph_template("caller", {
            "nodes": {"caller": {"kind": "subflow", "slot": "reviewers",
                                 "return_port": "out",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
            "slots": {"reviewers": {"template": review_tpl,
                                    "instantiation": "PER_CALL",
                                    "entry": "work.io"}},
        })
        p = SqlitePersistence(":memory:")
        p.attach(self.rt)                    # 先挂载，再产生提交
        job = self.rt.instantiate(tpl, owner="service:x")
        self.rt.append_context_tail(job, "caller", "skill/x@1")
        self.rt.send((job, "caller", "io"), {"round": 0})
        self.rt.drain()
        self.rt.control(job, "pause", actor="service:x")

        # —— 进程死亡：新 runtime，重新注册定义层，restore ——
        rt2 = Runtime()
        rt2.register_card(kind="rules", card_id="base", version=1, body={})
        rt2.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        rt2.register_handler("work", work)
        rt2.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        rt2.register_graph_template("review", {
            "nodes": {"work": {"kind": "plain", "handler": "work",
                               "endpoints": {"io": {}}}},
            "edges": [],
        })
        rt2.register_graph_template("caller", {
            "nodes": {"caller": {"kind": "subflow", "slot": "reviewers",
                                 "return_port": "out",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
            "slots": {"reviewers": {"template": review_tpl,
                                    "instantiation": "PER_CALL",
                                    "entry": "work.io"}},
        })
        p.restore(rt2)
        self.assertEqual(rt2.graph_status(job), "PAUSED")
        self.assertEqual(rt2.context_of(job, "caller").tail, ("skill/x@1",))
        self.assertEqual(len(rt2.children_of(job, "reviewers")), 1)
        seq_before = rt2.commit_seq(job)

        # resume 后续跑
        rt2.control(job, "resume", actor="service:x")
        rt2.drain()
        self.assertEqual(rt2.graph_status(job), "OPEN")
        self.assertGreater(rt2.commit_seq(job), seq_before)
        p.close()


# ---------------------------------------------------------------------------
# R9 —— ALL_REQUIRED 批量汇聚
# ---------------------------------------------------------------------------


class TestBatchJoin(RobustnessTestCase):

    def test_R9_all_required_consumes_one_per_endpoint_per_round(self):
        """三端点各 2 条 → 两轮原子 JOIN，每轮每端点取一条。"""
        self.rt.register_policy("joinall", {
            "readiness": "ALL_REQUIRED", "required_inputs": ["a", "b", "c"]})
        self.rt.register_handler("collect", lambda payloads, ctx: {
            "emit": {"out": {"merged": [payloads[k]["v"] for k in sorted(payloads)]}}})
        tpl = self.rt.register_graph_template("join", {
            "nodes": {
                "join": {"kind": "strategy", "policy": "joinall",
                         "handler": "collect",
                         "endpoints": {"a": {}, "b": {}, "c": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "join.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        for ep in ("a", "b", "c"):
            self.rt.send((job, "join", ep), {"v": 1})
            self.rt.send((job, "join", ep), {"v": 2})
        self.rt.drain(job)

        merged = self.rt.node_persistent_state(job, "sink").get("last", {}).get("merged")
        self.assertEqual(merged, [2, 2, 2])          # 最后一轮消费的是 v=2
        # 全部消息消费完，无残留
        self.assertTrue(all(
            m.state == "CONSUMED" for m in self.rt._messages.values()
            if m.target[0] == job))


# ---------------------------------------------------------------------------
# R10 —— 取值校验（enum/const/pattern）
# ---------------------------------------------------------------------------


class TestValueValidation(RobustnessTestCase):

    def test_R10_enum_violation_rejects_commit_atomically(self):
        """运行期取值校验：enum 之外的输出值 → 提交被拒、零下游。"""
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.rt.register_contract("Color", 1, {
            "type": "object", "required": ["c"],
            "properties": {"c": {"enum": ["red", "green"]}}})
        tpl = self.rt.register_graph_template("color", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "w", "endpoints": {
                    "io": {}, "out": {"emit": {"PUSH": {"contract": "Color@1"}}}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {"receive": {"PUSH": {"contract": "Color@1"}}}}},
            },
            "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.backend.on("w", lambda req: _ok(
            req, emissions=(("out", {"c": "blue"}),)))
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertEqual(self.rt.node_persistent_state(job, "sink").get("last"), None)

    def test_R10b_const_and_pattern_are_enforced(self):
        """const 与 pattern 同样生效。"""
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.rt.register_contract("Shape", 1, {
            "type": "object", "required": ["kind", "name"],
            "properties": {
                "kind": {"const": "rect"},
                "name": {"pattern": "^[a-z_]+$"},
            }})
        tpl = self.rt.register_graph_template("shape", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "w", "endpoints": {
                    "io": {}, "out": {"emit": {"PUSH": {"contract": "Shape@1"}}}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {"receive": {"PUSH": {"contract": "Shape@1"}}}}},
            },
            "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        # const 不符
        self.backend.on("w", lambda req: _ok(
            req, emissions=(("out", {"kind": "circle", "name": "ok"}),)))
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        # pattern 不符
        self.backend.on("w", lambda req: _ok(
            req, emissions=(("out", {"kind": "rect", "name": "Bad Name"}),)))
        self.rt.send((job, "worker", "io"), {"task": "t2"})
        self.rt.drain(job)
        statuses = [r.status for r in self.rt.node_executions(job, "worker")]
        self.assertEqual(statuses, ["FAILED", "FAILED"])
        self.assertEqual(self.rt.node_persistent_state(job, "sink").get("last"), None)


# ---------------------------------------------------------------------------
# R13/R14 —— 终态气密补漏：REPLY 到 CLOSED 目标 / queue() 并发迭代
# ---------------------------------------------------------------------------


class TestReplyToClosed(RobustnessTestCase):

    def test_R13_reply_to_closed_parent_is_not_delivered_silently(self):
        """父实例 CLOSED 后子实例的 REPLY 不得滞留成死信（终态气密）。"""
        def work(payload, ctx):
            return {"reply": {"r": payload}}
        self.rt.register_handler("work", work)
        review_tpl = self.rt.register_graph_template("review", {
            "nodes": {"work": {"kind": "plain", "handler": "work",
                               "endpoints": {"io": {}}}},
            "edges": [],
        })
        tpl = self.rt.register_graph_template("caller", {
            "nodes": {"caller": {"kind": "subflow", "slot": "reviewers",
                                 "return_port": "out",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
            "slots": {"reviewers": {"template": review_tpl,
                                    "instantiation": "PER_CALL",
                                    "entry": "work.io"}},
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        # 子实例在途：caller 已转发但还没回复时父被关闭
        self.rt.send((job, "caller", "io"), {"round": 0})
        self.rt.step(job)                       # caller 转发（子收到任务）
        self.rt.control(job, "close", actor="service:x")
        self.rt.drain()                          # 子回复 → REPLY 目标已 CLOSED
        # REPLY 不得滞留 QUEUED（目标 CLOSED 实例永远不消费）
        stuck = [m for m in self.rt._messages.values()
                 if m.mkind == "REPLY" and m.state != "CONSUMED"]
        self.assertEqual(stuck, [])


class TestQueueViewConcurrent(RobustnessTestCase):

    def test_R14_queue_view_is_safe_under_concurrent_publish(self):
        """queue() 与 publish 并发：不得因迭代中修改而抛 RuntimeError。"""
        self.rt.register_topic("t", request_contract={"type": "object"})
        stop = threading.Event()
        errors: list[tuple] = []

        def publisher():
            for _ in range(200):
                if stop.is_set():
                    break
                try:
                    self.rt.publish("t", {"x": 1})
                except Exception as exc:        # noqa: BLE001
                    errors.append(("publish", type(exc).__name__))
                time.sleep(0.001)

        def viewer():
            while not stop.is_set():
                try:
                    self.rt.queue("t")
                except Exception as exc:        # noqa: BLE001
                    errors.append(("queue", type(exc).__name__))
                    break
                time.sleep(0.001)

        t1 = threading.Thread(target=publisher)
        t2 = threading.Thread(target=viewer)
        t1.start(); t2.start()
        t1.join(timeout=5)
        stop.set()
        t2.join(timeout=5)
        self.assertEqual(errors, [], errors[:3])


# ---------------------------------------------------------------------------
# R11 —— PAUSED 订阅者接收并保留消息
# ---------------------------------------------------------------------------


class TestPausedSubscriber(RobustnessTestCase):

    def test_R11_paused_receives_keeps_and_resume_consumes(self):
        """publish 到 PAUSED 订阅者：消息保留（不消费），resume 后排空。"""
        self.rt.register_topic("t", request_contract={"type": "object"})
        tpl = self.rt.register_graph_template("paused", {
            "nodes": {"m": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.rt.subscribe("t", target=(job, "m", "io"))
        self.rt.control(job, "pause", actor="service:x")

        self.rt.publish("t", {"pct": 50})            # PAUSED 仍接收（仅 CLOSED 被过滤）
        self.rt.drain()                               # 不消费
        self.assertEqual(self.rt.queue("t").depth, 1)

        self.rt.control(job, "resume", actor="service:x")
        self.rt.drain()
        self.assertEqual(self.rt.queue("t").depth, 0)
        self.assertEqual(self.rt.node_persistent_state(job, "m").get("last"),
                         {"pct": 50})


class TestDriverLifecycle(unittest.TestCase):
    """driver 进程的生死 —— backend 必须能从中恢复。"""

    def _req(self, i):
        return ExecutionRequest(
            execution_id=f"life-{i}",
            agent_spec={"spec_id": "p",
                        "fake": {"emit": [{"port": "out", "payload": {"n": i}}]}},
            context=InvocationContext(),
            output_contract=OutputContract(allowed_emit_ports=("out",)),
        )

    def test_R15_backend_recovers_after_driver_crash(self):
        """★ driver 崩溃后 backend 必须能重启续用，而不是永久失效。

        修复前：`_closed` 是单向标志，`_ensure()` 重启进程时不复位，
        且旧 reader 退出时置的标志会干扰新 reader —— 崩一次就废到重建对象。
        """
        be = SubprocessBackend(["node", os.path.join(HERE, "drivers", "fake_driver.mjs")],
                               cwd=HERE)
        try:
            self.assertEqual(be.run(self._req(1)).emissions, (("out", {"n": 1}),))

            be._proc.kill()                      # —— driver 崩溃 ——
            be._proc.wait(timeout=5)
            time.sleep(0.3)                      # 让旧 reader 收到 EOF 退出

            # 同一个 backend 对象必须能继续干活
            self.assertEqual(be.run(self._req(2)).emissions, (("out", {"n": 2}),))
            self.assertEqual(be.run(self._req(3)).emissions, (("out", {"n": 3}),))
        finally:
            be.close()

    def test_R16_stale_reader_cannot_close_a_live_generation(self):
        """旧世代的 reader 退出，不得把新世代标记为已关闭。"""
        be = SubprocessBackend(["node", os.path.join(HERE, "drivers", "fake_driver.mjs")],
                               cwd=HERE)
        try:
            be.run(self._req(1))
            old_reader = be._reader
            be._proc.kill()
            be._proc.wait(timeout=5)
            be.run(self._req(2))                 # 触发重启，起新 reader
            old_reader.join(timeout=3)           # 旧 reader 此时才彻底退出
            self.assertFalse(be._closed, "旧 reader 关掉了新世代")
            self.assertEqual(be.run(self._req(4)).emissions, (("out", {"n": 4}),))
        finally:
            be.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
