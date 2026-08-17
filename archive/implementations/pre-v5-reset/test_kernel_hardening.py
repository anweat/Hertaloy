"""内核加固对抗测试 —— P0 缺陷修复的回归证据（2026-08 审查轮）

每条测试对应 CRITICAL_REVIEW 中一个已复现的 P0：
  S 状态机守卫：CLOSED 是终态，不可 pause/resume 复活
  M 模型 evaluator 的提交气密（close 后不得提交/路由）
  P 持久化线程安全（× drain_concurrent）
  C claim 是持久提交（无手动 flush 也经得起"进程死亡"）
  U unsubscribe 持久化（重启后无幽灵订阅）
  H handler / backend 异常进入失败路径，不滞留、不裸抛
  T send / subscribe 目标在入口校验，不拖到调度时才 KeyError
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest

from nodeflow_adapters import DriverError, SubprocessBackend
from nodeflow_persistence import SqlitePersistence
from nodeflow_v4 import (
    ExecutionRequest,
    ExecutionResult,
    InvocationContext,
    InvariantError,
    MockExecutionBackend,
    OutputContract,
    Runtime,
    WorkspaceScope,
)


def _ok(req, **kw) -> ExecutionResult:
    return ExecutionResult(execution_id=req.execution_id, **kw)


class KernelToolBackend(MockExecutionBackend):
    """模拟支持内核工具桥的 driver：run 里按计划回调编排面 handler。"""

    def __init__(self, rt: Runtime):
        super().__init__()
        self.kernel_tool_handler = rt._dispatch_kernel_tool
        self.plans: dict[str, list[tuple[str, dict]]] = {}
        self.plan_usage: dict[str, int] = {}
        self.results: list[ExecutionResult] = []

    def run(self, request: ExecutionRequest) -> ExecutionResult:
        self.seen.append(request)
        spec_id = request.agent_spec.get("spec_id")
        calls = self.plans.get(spec_id, [])
        # 每个 spec 的计划只执行一次：回调消息会触发同一节点再次执行，
        # 不能反复 publish/spawn 造成循环。
        used = self.plan_usage.get(spec_id, 0)
        results = []
        if used == 0:
            for name, args in calls:
                results.append({
                    "name": name,
                    "args": args,
                    "result": self.kernel_tool_handler(request.execution_id,
                                                       name, args),
                })
            self.plan_usage[spec_id] = 1
        emissions = (("out", {"ok": True}),) if results else ()
        result = ExecutionResult(
            execution_id=request.execution_id,
            emissions=emissions,
            diagnostics={"kernel_results": results},
        )
        self.results.append(result)
        return result


class HardeningTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)


def _plain_env(rt: Runtime, handler_name: str = "noop"):
    """最小 plain 图：n(io) 单节点。"""
    rt.register_handler(handler_name, lambda p, c: {})
    tpl = rt.register_graph_template(
        "plain-tpl",
        {"nodes": {"n": {"kind": "plain", "handler": handler_name,
                         "endpoints": {"io": {}}}},
         "edges": []},
    )
    return rt.instantiate(tpl, owner="service:x")


def _agent_env(rt: Runtime, backend: MockExecutionBackend, *, on_error=None,
               max_attempts=None):
    """agent worker(io, out[, err]) -> sink(io)。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    node = {"kind": "agent", "spec": "w", "endpoints": {"io": {}, "out": {}}}
    if on_error:
        node["on_error"] = on_error
        node["endpoints"]["err"] = {}
    if max_attempts is not None:
        node["limits"] = {"max_attempts": max_attempts}
    spec = {
        "nodes": {
            "worker": node,
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
    }
    if on_error:
        spec["edges"].append({"id": "e-err", "from": "worker.err", "to": "sink.io"})
    tpl = rt.register_graph_template("agent-tpl", spec)
    return rt.instantiate(tpl, owner="service:x")


def _model_strategy_env(rt: Runtime, backend: MockExecutionBackend):
    """gate(strategy, model evaluator) -> sink。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("judge", model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    rt.register_policy("p", {"readiness": "ANY", "output": {}})
    tpl = rt.register_graph_template("model-strategy-tpl", {
        "nodes": {
            "gate": {"kind": "strategy", "policy": "p",
                     "evaluator": {"kind": "model", "spec": "judge"},
                     "endpoints": {"io": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "gate.out", "to": "sink.io"}],
    })
    return rt.instantiate(tpl, owner="service:x")


# ---------------------------------------------------------------------------
# S —— CLOSED 是终态
# ---------------------------------------------------------------------------


class TestStateMachineGuards(HardeningTestCase):
    def test_S1_close_cannot_be_revived_by_pause_resume(self):
        job = _plain_env(self.rt)
        self.rt.control(job, "close", actor="service:x")
        self.assertEqual(self.rt.graph_status(job), "CLOSED")

        for action in ("pause", "resume"):
            with self.assertRaises(InvariantError) as cm:
                self.rt.control(job, action, actor="service:x")
            self.assertIn("CLOSED", str(cm.exception))
            self.assertEqual(self.rt.graph_status(job), "CLOSED")

        with self.assertRaises(InvariantError):
            self.rt.send((job, "n", "io"), {"x": 1})

    def test_S2_pause_resume_only_from_legal_states(self):
        job = _plain_env(self.rt)
        self.rt.control(job, "pause", actor="service:x")
        self.assertEqual(self.rt.graph_status(job), "PAUSED")
        with self.assertRaises(InvariantError):
            self.rt.control(job, "pause", actor="service:x")

        self.rt.control(job, "resume", actor="service:x")
        self.assertEqual(self.rt.graph_status(job), "OPEN")
        with self.assertRaises(InvariantError):
            self.rt.control(job, "resume", actor="service:x")

    def test_S3_repeated_close_is_idempotent_without_extra_fact(self):
        job = _plain_env(self.rt)
        before = len(self.rt.artifact_versions(f"run/{job}"))
        self.rt.control(job, "close", actor="service:x")
        self.rt.control(job, "close", actor="service:x")   # 幂等，不再留事实
        self.assertEqual(len(self.rt.artifact_versions(f"run/{job}")), before + 1)
        self.assertEqual(self.rt.graph_status(job), "CLOSED")


# ---------------------------------------------------------------------------
# M —— 模型 evaluator 的提交气密
# ---------------------------------------------------------------------------


class TestModelStrategyAirtightness(HardeningTestCase):
    def test_M1_close_during_model_judgement_discards_commit_without_dead_letter(self):
        job = _model_strategy_env(self.rt, self.backend)

        def slow_judge(req):
            time.sleep(0.4)
            return _ok(req, emissions=(("out", {"decided": 1}),))

        self.backend.on("judge", slow_judge)
        self.rt.send((job, "gate", "io"), {"task": 1})

        timer = threading.Timer(
            0.1, lambda: self.rt.control(job, "close", actor="service:x"))
        timer.start()
        self.rt.drain_concurrent(job, workers=1, timeout=10)
        timer.join()

        self.assertEqual(self.rt.graph_status(job), "CLOSED")
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "gate")], ["FAILED"])
        # 输入 FAILED；没有往 CLOSED 实例里制造 sink 死信
        gate_msgs = [m for m in self.rt._messages.values()
                     if m.target[0] == job and m.target[1] == "gate"]
        self.assertTrue(all(m.state == "FAILED" for m in gate_msgs))
        self.assertEqual(
            [m for m in self.rt._messages.values()
             if m.target[0] == job and m.target[1] == "sink"], [])
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))


# ---------------------------------------------------------------------------
# P —— 持久化 × 并发调度
# ---------------------------------------------------------------------------


class TestPersistenceConcurrency(HardeningTestCase):
    def test_P1_drain_concurrent_with_attached_persistence(self):
        rt = self.rt
        p = SqlitePersistence(":memory:")
        p.attach(rt)
        rt.register_card(kind="rules", card_id="base", version=1, body={})
        rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        tpl = rt.register_graph_template("t-p", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "w",
                           "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
        })
        job = rt.instantiate(tpl, owner="service:x")

        def slow(req):
            threading.Event().wait(0.03)
            return _ok(req, emissions=(("out", {"i": req.context.messages[0]["i"]}),))

        self.backend.on("w", slow)
        for i in range(4):
            rt.send((job, "worker", "io"), {"i": i})

        rt.drain_concurrent(job, workers=3, timeout=20)   # 不再 ProgrammingError
        # 关键断言：并发 worker 线程里多次 flush 全部成功落库
        self.assertGreaterEqual(p.counts()["messages"], 4)
        self.assertGreaterEqual(p.counts()["instances"], 1)


# ---------------------------------------------------------------------------
# C —— claim 是持久提交
# ---------------------------------------------------------------------------


class TestClaimDurability(unittest.TestCase):
    def test_C1_claim_survives_restart_without_manual_flush(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.db")

            rt = Runtime()
            backend = MockExecutionBackend()
            rt.set_backend(backend)
            p = SqlitePersistence(path)
            p.attach(rt)

            rt.register_card(kind="rules", card_id="base", version=1, body={})
            rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
            rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
            tpl = rt.register_graph_template("t-c", {
                "nodes": {
                    "worker": {"kind": "agent", "spec": "w",
                               "endpoints": {"io": {}, "out": {}}},
                    "sink": {"kind": "plain", "handler": "record",
                             "endpoints": {"io": {}}},
                },
                "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
            })
            job = rt.instantiate(tpl, owner="service:x")
            backend.on("w", lambda req: _ok(req, emissions=(("out", {"done": 1}),)))
            rt.send((job, "worker", "io"), {"task": "t"})
            eid, _req = rt.begin_execution(job, "worker")   # claim，不手动 flush
            self.assertIn(eid, p.stale_executions())
            p.close()

            # —— 进程在这里死掉 ——
            rt2 = Runtime()
            rt2.register_card(kind="rules", card_id="base", version=1, body={})
            rt2.compile_agent_spec("w", model="m", cards=[("rules", "base")])
            rt2.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
            rt2.register_graph_template("t-c", {
                "nodes": {
                    "worker": {"kind": "agent", "spec": "w",
                               "endpoints": {"io": {}, "out": {}}},
                    "sink": {"kind": "plain", "handler": "record",
                             "endpoints": {"io": {}}},
                },
                "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
            })
            p2 = SqlitePersistence(path)
            p2.restore(rt2)
            p2.attach(rt2)

            recs = {r.execution_id: r.status for r in rt2.node_executions(job, "worker")}
            self.assertEqual(recs.get(eid), "RUNNING")
            claimed = [m for m in rt2._messages.values() if m.mid in
                       rt2._records[eid].claimed]
            self.assertTrue(all(m.state == "CLAIMED" for m in claimed))

            self.assertEqual(rt2.reclaim_stale_executions(), [eid])
            backend2 = MockExecutionBackend()
            rt2.set_backend(backend2)
            backend2.on("w", lambda req: _ok(req, emissions=(("out", {"done": 1}),)))
            rt2.drain(job)
            applied = [r for r in rt2.node_executions(job, "worker")
                       if r.status == "APPLIED"]
            self.assertEqual(len(applied), 1)
            self.assertEqual(rt2.node_persistent_state(job, "sink")["last"],
                             {"done": 1})
            p2.close()


# ---------------------------------------------------------------------------
# U —— unsubscribe 持久化
# ---------------------------------------------------------------------------


class TestUnsubscribeDurability(unittest.TestCase):
    def test_U1_unsubscribed_topic_stays_unsubscribed_after_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.db")
            rt = Runtime()
            p = SqlitePersistence(path)
            p.attach(rt)
            rt.register_handler("noop", lambda p, c: {})
            rt.register_topic("t", request_contract={"type": "object"})
            tpl = rt.register_graph_template("t-u", {
                "nodes": {"n": {"kind": "plain", "handler": "noop",
                                "endpoints": {"io": {}}}},
                "edges": [],
            })
            gid = rt.instantiate(tpl, owner="service:x")
            sid = rt.subscribe("t", target=(gid, "n", "io"))
            rt.unsubscribe(sid)
            self.assertEqual(p.counts()["subscriptions"], 0)
            p.close()

            rt2 = Runtime()
            rt2.register_handler("noop", lambda p, c: {})
            rt2.register_topic("t", request_contract={"type": "object"})
            p2 = SqlitePersistence(path)
            p2.restore(rt2)
            self.assertEqual(rt2._subs.get("t"), [])
            self.assertEqual(p2.counts()["subscriptions"], 0)
            p2.close()


# ---------------------------------------------------------------------------
# H —— handler / backend 异常进入失败路径
# ---------------------------------------------------------------------------


class TestFailurePaths(HardeningTestCase):
    def test_H1_plain_handler_exception_marks_input_failed_and_records(self):
        rt = self.rt
        rt.register_handler("boom", lambda p, c: (_ for _ in ()).throw(RuntimeError("boom")))
        rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        tpl = rt.register_graph_template("t-h1", {
            "nodes": {
                "n": {"kind": "plain", "handler": "boom",
                      "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "n.out", "to": "sink.io"}],
        })
        job = rt.instantiate(tpl, owner="service:x")
        rt.send((job, "n", "io"), {"x": 1})
        rt.drain(job)                    # 不裸抛
        self.assertEqual(rt.graph_status(job), "OPEN")
        self.assertTrue(all(m.state == "FAILED" for m in rt._messages.values()))
        self.assertNotIn("last", rt.node_persistent_state(job, "sink"))
        snap = rt.store.history(f"run/{job}")[-1]
        self.assertIn("failure", snap.body)
        self.assertIn("HANDLER_FAILED", snap.body["failure"]["error"])

    def test_H2_strategy_handler_exception_marks_batch_failed(self):
        rt = self.rt
        rt.register_handler("boom", lambda payloads, ctx: (_ for _ in ()).throw(ValueError("bad")))
        rt.register_policy("p", {"readiness": "ANY"})
        tpl = rt.register_graph_template("t-h2", {
            "nodes": {"s": {"kind": "strategy", "policy": "p", "handler": "boom",
                            "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = rt.instantiate(tpl, owner="service:x")
        rt.send((job, "s", "io"), {"x": 1})
        rt.drain(job)
        self.assertTrue(all(m.state == "FAILED" for m in rt._messages.values()))
        snap = rt.store.history(f"run/{job}")[-1]
        self.assertIn("HANDLER_FAILED", snap.body["failure"]["error"])

    def test_H3_backend_exception_goes_through_attempts_and_on_error(self):
        job = _agent_env(self.rt, self.backend, on_error="err", max_attempts=1)

        def crash(req):
            raise RuntimeError("network down")

        self.backend.on("w", crash)
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)               # 不裸抛
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertTrue(all(m.state == "FAILED"
                            for m in self.rt._messages.values()
                            if m.target[1] == "worker"))
        # on_error 沿边进入图，sink 收到结构化错误
        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"]["error"],
                         "FAILED")


# ---------------------------------------------------------------------------
# T —— 目标在入口校验
# ---------------------------------------------------------------------------


class TestTargetValidation(HardeningTestCase):
    def test_T1_send_rejects_ghost_node_endpoint_and_instance(self):
        job = _plain_env(self.rt)
        with self.assertRaises(InvariantError) as cm:
            self.rt.send((job, "ghost", "io"), {})
        self.assertIn("可用节点", str(cm.exception))

        with self.assertRaises(InvariantError) as cm:
            self.rt.send((job, "n", "ghost"), {})
        self.assertIn("可用端点", str(cm.exception))

        with self.assertRaises(InvariantError):
            self.rt.send(("gi-99999", "n", "io"), {})

    def test_T2_subscribe_rejects_ghost_target_and_closed_instance(self):
        rt = self.rt
        rt.register_topic("t", request_contract={"type": "object"})
        job = _plain_env(rt)
        with self.assertRaises(InvariantError) as cm:
            rt.subscribe("t", target=(job, "ghost", "io"))
        self.assertIn("可用节点", str(cm.exception))

        with self.assertRaises(InvariantError) as cm:
            rt.subscribe("t", target=(job, "n", "ghost"))
        self.assertIn("可用端点", str(cm.exception))

        rt.control(job, "close", actor="service:x")
        with self.assertRaises(InvariantError) as cm:
            rt.subscribe("t", target=(job, "n", "io"))
        self.assertIn("CLOSED", str(cm.exception))


# ---------------------------------------------------------------------------
# K —— 内核工具桥（P0-6）
# ---------------------------------------------------------------------------


class TestKernelToolBridge(unittest.TestCase):
    def test_K1_runtime_dispatch_read_publish_spawn_and_compile_time_decl(self):
        rt = Runtime()
        backend = KernelToolBackend(rt)
        rt.set_backend(backend)

        rt.register_card(kind="rules", card_id="base", version=1, body={})
        rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        rt.register_handler("svc", lambda p, c: (
            c["state"].update({"last": p}) or {"reply": {"got": p}}))
        rt.register_handler("kid", lambda p, c: c["state"].update({"seen": p}) or {})

        rt.register_topic("disc", request_contract={"type": "object"},
                          reply_contract={"type": "object"})
        svc_tpl = rt.register_graph_template("svc", {
            "nodes": {"svc": {"kind": "plain", "handler": "svc",
                              "endpoints": {"io": {}}}},
            "edges": [],
        })
        svc = rt.instantiate(svc_tpl, owner="system:core")
        rt.subscribe("disc", target=(svc, "svc", "io"))

        kid_tpl = rt.register_graph_template("kid", {
            "nodes": {"work": {"kind": "plain", "handler": "kid",
                               "endpoints": {"io": {}}}},
            "edges": [],
        })
        tpl = rt.register_graph_template("bridge", {
            "nodes": {
                "w": {
                    "kind": "agent", "spec": "w",
                    "publish_topics": {"disc": "io"},
                    "spawn_slots": ["kids"],
                    "endpoints": {"io": {}, "out": {}},
                },
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "w.out", "to": "sink.io"}],
            "slots": {"kids": {"template": kid_tpl, "instantiation": "PER_CALL",
                               "entry": "work.io"}},
        })
        job = rt.instantiate(tpl, owner="service:x")
        plan_ov = rt.store.put("plan", "plan", {"n": 1})

        backend.plans["w"] = [
            ("read_artifact", {"ref": plan_ov.ref}),
            ("publish", {"topic": "disc", "payload": {"q": 1}}),
            ("spawn", {"slot": "kids", "payload": {"job": 1}}),
        ]
        rt.send((job, "w", "io"), {"task": 1})
        rt.drain()          # publish/spawn 的消息落在别的实例，需全量排空

        first = backend.seen[0]
        declared = {t["name"] for t in first.agent_spec["kernel_tools"]}
        self.assertEqual(declared, {"read_artifact", "publish", "spawn"})

        results = {r["name"]: r["result"]
                   for r in backend.results[0].diagnostics["kernel_results"]}
        self.assertEqual(results["read_artifact"]["body"], {"n": 1})
        publish_ids = results["publish"]["message_ids"]
        self.assertEqual(len(publish_ids), 1)
        child = results["spawn"]["child"]
        self.assertIn(child, rt.children_of(job, "kids"))

        # publish → 服务消费并回投；spawn → 子实例 entry 消费；out → sink
        self.assertEqual(rt.node_persistent_state(svc, "svc")["last"], {"q": 1})
        self.assertEqual(rt.node_persistent_state(child, "work")["seen"], {"job": 1})
        self.assertEqual(rt.node_persistent_state(job, "sink")["last"], {"ok": True})

    def test_K2_undeclared_kernel_tool_is_rejected(self):
        rt = Runtime()
        backend = KernelToolBackend(rt)
        rt.set_backend(backend)
        rt.register_card(kind="rules", card_id="base", version=1, body={})
        rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = rt.register_graph_template("no-bridge", {
            "nodes": {"w": {"kind": "agent", "spec": "w",
                            "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = rt.instantiate(tpl, owner="service:x")
        rt.send((job, "w", "io"), {"t": 1})
        eid, req = rt.begin_execution(job, "w")
        self.assertEqual({t["name"] for t in req.agent_spec["kernel_tools"]},
                         {"read_artifact"})
        with self.assertRaises(InvariantError) as cm:
            rt._dispatch_kernel_tool(eid, "publish",
                                     {"topic": "x", "payload": {}})
        self.assertIn("未声明", str(cm.exception))

    def test_K3_subprocess_wire_protocol_roundtrip_and_error(self):
        here = os.path.dirname(os.path.abspath(__file__))
        fake_driver = os.path.join(here, "drivers", "fake_driver.mjs")
        be = SubprocessBackend(["node", fake_driver])

        def handler(eid, name, args):
            if name == "boom":
                raise InvariantError("kernel tool failed")
            return {"eid": eid, "name": name, "echo": args}

        be.kernel_tool_handler = handler
        req = ExecutionRequest(
            execution_id="kt-1",
            agent_spec={
                "spec_id": "probe",
                "model": "probe",
                "systemPrompt": "SYS",
                "tools": [],
                "kernel_tools": [
                    {"name": "read_artifact", "description": "r",
                     "parameters": {"type": "object"}},
                    {"name": "boom", "description": "b",
                     "parameters": {"type": "object"}},
                ],
                "fake": {"kernelToolCalls": [
                    {"name": "read_artifact", "arguments": {"ref": "plan@1"}},
                    {"name": "boom", "arguments": {"x": 1}},
                ]},
            },
            context=InvocationContext(),
            output_contract=OutputContract(allowed_emit_ports=("out",)),
            workspace=WorkspaceScope(root=here),
        )
        with self.assertRaises(DriverError) as cm:
            be.run(req)
        self.assertIn("kernel tool failed", str(cm.exception))

        # 错误路径之后 backend 仍可用：再来一个只有成功调用的请求
        req2 = ExecutionRequest(
            execution_id="kt-2",
            agent_spec={
                "spec_id": "probe", "model": "probe", "systemPrompt": "SYS",
                "tools": [], "kernel_tools": [],
                "fake": {"kernelToolCalls": [
                    {"name": "read_artifact", "arguments": {"ref": "plan@1"}},
                ]},
            },
            context=InvocationContext(),
            output_contract=OutputContract(allowed_emit_ports=("out",)),
            workspace=WorkspaceScope(root=here),
        )
        res = be.run(req2)
        self.assertEqual(res.termination, "DONE")
        self.assertEqual(res.diagnostics["kernel_results"][0]["result"]["name"],
                         "read_artifact")
        be.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
