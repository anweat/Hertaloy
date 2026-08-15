# -*- coding: utf-8 -*-
"""边界契约测试 —— 以愿景为基准限定自由度与边界。

第一组（必须钉，均有实证违背）：
    B1/B6  定义层不可变：注册后修改调用方 dict，模板/契约/策略/卡片不变
    B5b    fan-out 原子：任一分支运行期校验失败 → 零消息产生
    B3     内核前缀保护：backend 不得提交 run//annotation/ 前缀或内核 kind
    B2     终态气密：CLOSED 后在途 apply 被拒，不留不一致状态
    M3b    REPLY 关联显式化：落端点后是普通消息，无协议级 replyToMessageId

第二组（防自由度蔓延）：
    close 实验 1  用户排空后关闭是干净的（无需内核 DRAIN）
    close 实验 2  在途作废可观测（FAILED 留痕）
    Lb    _layout 不参与语义（画布边界占位）
    Pb    pause 全路径（取消在途、消息保留、resume 可续）
    Ch    character 是装配面命名组合（编译结果与卡片集直接编译同构）
    Qb    用户 artifact kind 自由（内核不拒绝 plan/spec/自定义）

运行：python -m unittest test_boundaries -v
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


class BoundaryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})


# ===========================================================================
# B1/B6 —— 定义层不可变
# ===========================================================================


class TestDefinitionImmutability(BoundaryTestCase):

    def test_B1_template_nodes_are_snapshot_at_registration(self):
        """注册后修改调用方的 spec dict，模板不得跟着变。"""
        spec = {"nodes": {"a": {"kind": "plain", "handler": "record",
                                "endpoints": {"io": {}}}},
                "edges": []}
        ref = self.rt.register_graph_template("tpl-b1", spec)
        spec["nodes"]["b"] = {"kind": "plain", "handler": "record",
                              "endpoints": {"io": {}}}
        self.assertEqual(sorted(self.rt._templates[ref]["nodes"]), ["a"])

    def test_B6_edge_list_is_snapshot_at_registration(self):
        """边列表同样不可变。"""
        spec = {"nodes": {"a": {"kind": "plain", "handler": "record",
                                "endpoints": {"io": {}}}},
                "edges": []}
        ref = self.rt.register_graph_template("tpl-b6", spec)
        spec["edges"].append({"id": "x", "from": "a.io", "to": "a.io"})
        self.assertEqual(self.rt._templates[ref]["edges"], [])

    def test_B1b_contract_is_snapshot_at_registration(self):
        """MessageContract 注册后修改调用方 schema 不得生效。"""
        schema = {"type": "object", "required": ["a"], "properties": {}}
        ref = self.rt.register_contract("C", 1, schema)
        schema["required"] = []          # 调用方想偷偷放宽
        self.assertEqual(self.rt._contracts[ref]["required"], ["a"])

    def test_B1c_policy_and_card_body_are_snapshot(self):
        """策略与卡片正文同样不可变（含嵌套 dict）。"""
        policy = {"readiness": "ANY", "output": {}}
        self.rt.register_policy("p", policy)
        policy["output"]["mode"] = "FANOUT_TO_SLOT"     # 调用方想偷偷改
        self.assertNotIn("mode", self.rt._policies["p"]["output"])

        body = {"text": "x", "nested": {"deep": 1}}
        self.rt.register_card(kind="rules", card_id="r", version=1, body=body)
        body["nested"]["deep"] = 999
        self.assertEqual(
            self.rt.card_body("rules", "r", 1)["nested"]["deep"], 1)


# ===========================================================================
# B5b —— fan-out 原子
# ===========================================================================


class TestFanoutAtomicity(BoundaryTestCase):

    def test_B5b_failing_branch_produces_zero_messages(self):
        """双出边，第二分支运行期校验失败：零消息产生，执行 FAILED 留痕。

        修复前：eA 分支消息已投递并被消费（部分 fan-out），执行却 FAILED。
        """
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.rt.register_contract("Loose", 1,
                                  {"type": "object", "required": [], "properties": {}})
        self.rt.register_contract("Tight", 1,
                                  {"type": "object", "required": [], "properties": {},
                                   "additionalProperties": False})
        spec = {
            "nodes": {
                "worker": {"kind": "agent", "spec": "w", "endpoints": {
                    "io": {}, "out": {"emit": {"PUSH": {"contract": "Loose@1"}}}}},
                "sinkA": {"kind": "plain", "handler": "record", "endpoints": {
                    "io": {"receive": {"PUSH": {"contract": "Loose@1"}}}}},
                "sinkB": {"kind": "plain", "handler": "record", "endpoints": {
                    "io": {"receive": {"PUSH": {"contract": "Tight@1"}}}}},
            },
            "edges": [
                {"id": "eA", "from": "worker.out", "to": "sinkA.io", "operation": "PUSH"},
                {"id": "eB", "from": "worker.out", "to": "sinkB.io", "operation": "PUSH"},
            ],
        }
        tpl = self.rt.register_graph_template("tpl-b5b", spec)
        job = self.rt.instantiate(tpl, owner="service:x")
        self.backend.on("w", lambda req: _ok(req, emissions=(("out", {"x": 1}),)))
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)                      # 不崩溃

        # 执行 FAILED 留痕，且没有任何下游消息产生
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertEqual(self.rt.node_persistent_state(job, "sinkA").get("last"), None)
        self.assertEqual(self.rt.node_persistent_state(job, "sinkB").get("last"), None)
        targets = [m.target for m in self.rt._messages.values()
                   if m.target[1] in ("sinkA", "sinkB")]
        self.assertEqual(targets, [])


# ===========================================================================
# B3 —— 内核前缀保护
# ===========================================================================


class TestKernelPrefixGuard(BoundaryTestCase):

    def _job(self):
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("tpl-b3", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:x")

    def test_B3_backend_cannot_forge_run_snapshots(self):
        """backend 提交 run/{gid} 前缀 → 拒绝，不写入版本历史。"""
        job = self._job()
        def evil(req):
            return _ok(req, emissions=(("out", {}),),
                       artifacts=(("run", f"run/{job}", {"forged": True}),))
        self.backend.on("w", evil)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)                      # 拒绝被捕获，不崩溃

        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        forged = [v.body for v in self.rt.store.history(f"run/{job}")
                  if v.body.get("forged")]
        self.assertEqual(forged, [])

    def test_B3b_backend_cannot_forge_annotations_or_kernel_kinds(self):
        """annotation/ 前缀与内核 kind（run/annotation/context_summary）同样拒绝。"""
        job = self._job()
        def evil(req):
            return _ok(req, emissions=(("out", {}),),
                       artifacts=(("annotation", f"annotation/{job}", {"fake": 1}),
                                  ("context_summary", "cs", {"s": 1})))
        self.backend.on("w", evil)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        self.assertEqual(
            [v.body for v in self.rt.store.history(f"annotation/{job}")
             if v.body.get("fake")], [])

    def test_Qb_user_kinds_remain_free(self):
        """反向钉住：用户 kind（plan/spec/自定义）不被内核拒绝。"""
        job = self._job()
        def writer(req):
            return _ok(req, emissions=(("out", {}),),
                       artifacts=(("plan", "plan", {"p": 1}),
                                  ("spec", "spec", {"s": 2}),
                                  ("my_custom_kind", "x", {"v": 3})))
        self.backend.on("w", writer)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)
        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["APPLIED"])
        self.assertEqual(self.rt.artifact_versions("plan"), [1])
        self.assertEqual(self.rt.artifact("plan", 1), {"p": 1})
        self.assertEqual(self.rt.artifact("x", 1), {"v": 3})


# ===========================================================================
# B2 —— 终态气密（CLOSED 后在途执行不得提交）
# ===========================================================================


class TestTerminalAirtightness(BoundaryTestCase):

    def _agent_env(self):
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("tpl-b2", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:x")

    def test_B2_apply_after_close_is_rejected(self):
        """API 级：close 后对在途执行 apply_execution 必须被拒。"""
        job = self._agent_env()
        self.backend.on("w", lambda req: _ok(req))
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        eid, _req = self.rt.begin_execution(job, "worker")
        self.rt.control(job, "close", actor="service:x")
        with self.assertRaises(InvariantError):
            self.rt.apply_execution(
                eid, ExecutionResult(execution_id=eid, emissions=(("out", {}),)))
        # 无任何新消息产生
        self.assertEqual([m for m in self.rt._messages.values()
                          if m.target[0] == job and m.target[1] != "worker"], [])

    def test_B2b_full_path_inflight_work_is_discarded_with_trace(self):
        """完整路径：close 时在途执行完成后提交被拒 → FAILED 留痕、零新消息。"""
        import threading
        job = self._agent_env()
        def handler(req):
            time.sleep(0.3)                     # 执行在途
            return _ok(req, emissions=(("out", {"done": 1}),))
        self.backend.on("w", handler)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        # 执行在途期间（50ms 后）关闭实例
        timer = threading.Timer(
            0.05, lambda: self.rt.control(job, "close", actor="service:x"))
        timer.start()
        self.rt.drain_concurrent(job, workers=1, timeout=10)    # 收敛，不崩溃
        timer.join()

        self.assertEqual(
            [r.status for r in self.rt.node_executions(job, "worker")], ["FAILED"])
        # 输入留 FAILED 终态（可观测的作废痕迹），无任何活消息/新消息
        leftover = [m for m in self.rt._messages.values() if m.target[0] == job]
        self.assertTrue(all(m.state == "FAILED" for m in leftover),
                        [m.state for m in leftover])
        self.assertTrue(leftover)


# ===========================================================================
# M3b —— REPLY 关联显式化
# ===========================================================================


class TestReplyCorrelationExplicit(BoundaryTestCase):

    def test_M3b_reply_is_a_plain_message_without_protocol_correlation(self):
        """REPLY 到达已声明端点后就是普通消息：无协议级 replyToMessageId。

        并发请求的关联由业务 payload 承担（不变量 M3 的推论）。
        """
        self.rt.register_topic("svc", request_contract={"type": "object"})
        self.rt.register_handler("srv", lambda p, c: {"reply": {"echo": p["req"]}})
        svc_tpl = self.rt.register_graph_template("svc", {
            "nodes": {"svc": {"kind": "plain", "handler": "srv",
                              "endpoints": {"io": {}}}},
            "edges": [],
        })
        svc = self.rt.instantiate(svc_tpl, owner="service:svc")
        self.rt.subscribe("svc", target=(svc, "svc", "io"))

        self.rt.compile_agent_spec("caller", model="m", cards=[("rules", "base")])
        caller_tpl = self.rt.register_graph_template("caller", {
            "nodes": {"caller": {"kind": "agent", "spec": "caller",
                                 "endpoints": {"io": {}}}},
            "edges": [],
        })
        caller = self.rt.instantiate(caller_tpl, owner="service:x")
        self.backend.on("caller", lambda req: _ok(req))

        self.rt.publish("svc", {"req": "Q1"}, sender=(caller, "caller", "io"),
                        callback=(caller, "caller", "io"))
        self.rt.publish("svc", {"req": "Q2"}, sender=(caller, "caller", "io"),
                        callback=(caller, "caller", "io"))
        self.rt.drain()

        replies = [m for m in self.rt._messages.values() if m.mkind == "REPLY"]
        self.assertEqual(len(replies), 2)
        for m in replies:
            self.assertNotIn("replyToMessageId", m.payload)
            self.assertIsNone(m.callback)       # REPLY 不携带新的回调
        # 调用方收到的就是普通消息内容（无协议字段）
        for req in self.backend.seen:
            if req.agent_spec["spec_id"] == "caller":
                self.assertIn("echo", req.context.messages[0])


# ===========================================================================
# close 实验 —— 用户定义的关闭行为
# ===========================================================================


class TestUserDefinedClose(BoundaryTestCase):

    def test_close_experiment1_drained_then_closed_is_clean(self):
        """实验 1：用户编排排空（策略汇聚）后关闭 → 干净终态，无需内核 DRAIN。"""
        self.rt.register_policy("joinall", {
            "readiness": "ALL_REQUIRED", "required_inputs": ["a", "b"]})
        self.rt.register_handler("collect", lambda payloads, ctx: {
            "emit": {"out": {"merged": True}}})
        tpl = self.rt.register_graph_template("close-join", {
            "nodes": {
                "join": {"kind": "strategy", "policy": "joinall",
                         "handler": "collect",
                         "endpoints": {"a": {}, "b": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "join.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.rt.send((job, "join", "a"), {"v": 1})
        self.rt.send((job, "join", "b"), {"v": 2})
        self.rt.drain(job)

        # 排空已完成：无 QUEUED / CLAIMED 残留
        states = [m.state for m in self.rt._messages.values()
                  if m.target[0] == job]
        self.assertTrue(states)
        self.assertNotIn("QUEUED", states)
        self.assertNotIn("CLAIMED", states)
        self.assertEqual(self.rt.node_persistent_state(job, "sink").get("last"),
                         {"merged": True})

        # 此刻关闭 → 干净终态，不留不一致状态
        self.rt.control(job, "close", actor="service:x")
        self.assertEqual(self.rt.graph_status(job), "CLOSED")
        self.assertEqual([m for m in self.rt._messages.values()
                          if m.target[0] == job and m.state != "CONSUMED"], [])


# ===========================================================================
# Lb —— _layout 不参与语义
# ===========================================================================


class TestLayoutOrthogonal(BoundaryTestCase):

    def test_Lb_layout_does_not_affect_semantics(self):
        """_layout 顶层键（画布坐标）不参与校验、不影响运行行为。"""
        def make(layout):
            return {
                "_layout": layout,
                "nodes": {"a": {"kind": "plain", "handler": "record",
                                "endpoints": {"io": {}}}},
                "edges": [],
            }
        # 怪值布局（字符串/列表）也不得导致注册失败
        ref1 = self.rt.register_graph_template("l1", make({"pos": [1, 2]}))
        ref2 = self.rt.register_graph_template("l2", make("just-a-string"))
        self.assertNotIn("_layout", self.rt._templates[ref1])   # 不进入语义层

        j1 = self.rt.instantiate(ref1, owner="service:x")
        j2 = self.rt.instantiate(ref2, owner="service:y")
        self.rt.send((j1, "a", "io"), {"x": 1})
        self.rt.send((j2, "a", "io"), {"x": 1})
        self.rt.drain(j1, j2)
        self.assertEqual(self.rt.node_persistent_state(j1, "a")["last"], {"x": 1})
        self.assertEqual(self.rt.node_persistent_state(j2, "a")["last"], {"x": 1})


# ===========================================================================
# Pb —— pause 全路径
# ===========================================================================


class TestPauseLifecycle(BoundaryTestCase):

    def test_Pb_pause_cancels_inflight_keeps_messages_resume_continues(self):
        """pause：取消在途执行（CANCELLED 留痕）、输入退回 QUEUED、
        resume 后重新认领并完成。"""
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("tpl-pb", {
            "nodes": {"worker": {"kind": "agent", "spec": "w",
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:x")
        self.backend.on("w", lambda req: _ok(req, emissions=(("out", {"done": 1}),)))

        self.rt.send((job, "worker", "io"), {"task": "t1"})
        eid, _req = self.rt.begin_execution(job, "worker")
        self.rt.control(job, "pause", actor="service:x")

        self.assertEqual(self.rt.graph_status(job), "PAUSED")
        recs = {r.execution_id: r.status for r in self.rt.node_executions(job, "worker")}
        self.assertEqual(recs[eid], "CANCELLED")        # 在途被取消，留痕
        msgs = [m for m in self.rt._messages.values() if m.target[0] == job]
        self.assertTrue(all(m.state == "QUEUED" for m in msgs))   # 工作保留

        self.rt.control(job, "resume", actor="service:x")
        self.assertEqual(self.rt.graph_status(job), "OPEN")
        self.rt.drain(job)
        statuses = [r.status for r in self.rt.node_executions(job, "worker")]
        self.assertIn("APPLIED", statuses)              # 重新认领并完成


# ===========================================================================
# Ch —— character 是装配面命名组合
# ===========================================================================


class TestCharacterIsAssemblyObject(BoundaryTestCase):

    def test_Ch_character_expands_to_the_same_spec_as_direct_cards(self):
        """character 编译 ≡ 其声明卡片集直接编译：证明它只是命名组合。

        不是新内核类型 —— 编译产物与手写卡片组合完全同构。
        """
        self.rt.register_card(kind="rules", card_id="py-strict", version=3,
                              body={"text": "strict"})
        self.rt.register_card(kind="skill", card_id="repo-survey", version=1,
                              body={"summary": "survey", "text": "..."})

        cid = self.rt.register_character(
            "coder", cards=[("rules", "py-strict", 3), ("skill", "repo-survey", 1)],
            tools=["repo_tool"])
        expanded_cards, expanded_tools = self.rt.expand_character(cid)

        # ★ 同构：展开结果与手写卡片组合逐项一致
        manual_cards = [("rules", "py-strict", 3), ("skill", "repo-survey", 1)]
        self.assertEqual(expanded_cards, manual_cards)
        self.assertEqual(expanded_tools, [{"name": "repo_tool"}])

        direct = self.rt.compile_agent_spec(
            "direct", model="m", cards=manual_cards, tools=["repo_tool"])
        via_char = self.rt.compile_agent_spec(
            "via-char", model="m", cards=expanded_cards, tools=expanded_tools)

        self.assertEqual(direct["card_refs"], via_char["card_refs"])
        self.assertEqual(direct["tools"], via_char["tools"])
        self.assertEqual(direct["prefix_hash"] if "prefix_hash" in direct else None,
                         via_char.get("prefix_hash"))
        # character 自身不是运行对象：没有任何运行期语义
        self.assertFalse(hasattr(self.rt, "instantiate_character"))

    def test_Chb_character_rejects_unknown_card_kinds(self):
        """character 的卡片引用必须通过卡片校验（无内核专属字段）。"""
        with self.assertRaises(InvariantError):
            self.rt.register_character("bad", cards=[("gadget", "x", 1)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
