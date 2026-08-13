"""Nodeflow V4 —— 行为验收集（骨架，当前全部 RED）

每条测试对应 FOUNDATION_V4.md 第 2 节剧本的某一帧，docstring 里标注帧号。
它们定义"必须能表达什么"，不定义"如何实现"。

裁判规则：新增任何持久对象前，先问它对应哪一帧；指不回帧的不得加入。

运行：
    python -m unittest test_foundation_v4 -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import (
    AuthorizationError,
    ExecutionRequest,
    ExecutionResult,
    InvariantError,
    MockExecutionBackend,
    Runtime,
    Usage,
)


def _ok(req: ExecutionRequest, **kw) -> ExecutionResult:
    """最小成功返回，供 mock backend 复用。"""
    return ExecutionResult(execution_id=req.execution_id, **kw)


class FoundationTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)


# ===========================================================================
# A 组 —— 装配面与卡片式资产（帧 1, 2, 7, B3）
# ===========================================================================


class TestAssetCards(FoundationTestCase):

    def test_A1_agent_spec_pins_exact_card_versions(self):
        """帧 1：AgentSpec 由卡片组装，编译时 pin 精确版本。

        证明：spec 里存的是 (kind, id, version) 三元组，不是"最新"。
        """
        self.rt.register_card(kind="rules", card_id="py-strict", version=3, body={})
        self.rt.register_card(kind="skill", card_id="repo-survey", version=1, body={})
        self.rt.register_card(kind="mcp", card_id="git", version=2, body={})

        spec = self.rt.compile_agent_spec(
            "planner",
            model="test-model",
            cards=[("rules", "py-strict", 3), ("skill", "repo-survey", 1), ("mcp", "git", 2)],
        )

        self.assertIn("py-strict@3", str(spec))
        self.assertNotIn("py-strict@4", str(spec))

    def test_A2_active_execution_does_not_see_card_update(self):
        """帧 2：执行进行中，可见卡片集合固定。

        不变量：**活跃期不漂移。** 注意这比"永久 pin"弱 —— 见 A2b。
        """
        self.rt.register_card(kind="rules", card_id="py-strict", version=3, body={"v": 3})
        # 跟随最新（不显式 pin）—— 这才是需要"活跃期不漂移"保护的情况
        self.rt.compile_agent_spec("planner", model="m", cards=[("rules", "py-strict")])
        tpl = self.rt.register_graph_template("plan-flow", _plan_flow_spec())
        job = self.rt.instantiate(tpl, owner="human:alice")

        seen: list[int] = []

        def planner(req):
            # 执行进行中，外部（tool / skill 服务）更新卡片
            if ("rules", "py-strict") in self.rt._cards and 4 not in self.rt._cards[("rules", "py-strict")]:
                self.rt.register_card(kind="rules", card_id="py-strict", version=4, body={"v": 4})
            seen.append(req.agent_spec["cards"]["rules/py-strict"])
            return _ok(req)

        self.backend.on("planner", planner)
        self.rt.send((job, "start", "io"), {"goal": "add export"})
        self.rt.drain(job)

        self.assertEqual(seen, [3])

    def test_A2b_dormant_instance_picks_up_new_card_version(self):
        """帧 2 续：实例回到 idle 后，下一次执行看到新版本。

        写经 tool / skill / mcp 服务完成；生效时机是**休眠时**。
        """
        self.rt.register_card(kind="rules", card_id="py-strict", version=3, body={"v": 3})
        self.rt.compile_agent_spec("planner", model="m", cards=[("rules", "py-strict")])
        tpl = self.rt.register_graph_template("plan-flow", _plan_flow_spec())
        job = self.rt.instantiate(tpl, owner="human:alice")

        seen: list[int] = []
        self.backend.on(
            "planner",
            lambda req: (seen.append(req.agent_spec["cards"]["rules/py-strict"]), _ok(req))[1],
        )

        self.rt.send((job, "start", "io"), {"goal": "round 1"})
        self.rt.drain(job)

        # 实例已休眠，此时 tool 更新卡片
        self.rt.register_card(kind="rules", card_id="py-strict", version=4, body={"v": 4})

        self.rt.send((job, "start", "io"), {"goal": "round 2"})
        self.rt.drain(job)

        self.assertEqual(seen, [3, 4])

    def test_A3_card_is_loaded_as_readonly_reference(self):
        """帧 B3：同一张卡被两个无关 spec 引用。

        读 = 只读引用（不复制正文、不可就地改），与现有 harness 一致。
        """
        self.rt.register_card(kind="skill", card_id="citation-format", version=1, body={"t": "x"})

        spec_a = self.rt.compile_agent_spec(
            "coder", model="m", cards=[("skill", "citation-format", 1)]
        )
        spec_b = self.rt.compile_agent_spec(
            "researcher", model="m", cards=[("skill", "citation-format", 1)]
        )

        # 两个 spec 独立，但指向同一卡片身份
        self.assertNotEqual(spec_a["spec_id"], spec_b["spec_id"])
        self.assertEqual(spec_a["card_refs"], spec_b["card_refs"])

        # 只读：拿到的正文无法就地改写
        body = self.rt.card_body("skill", "citation-format", 1)
        with self.assertRaises(TypeError):
            body["t"] = "mutated"

    def test_A4_runtime_discovered_card_appends_to_one_instance_tail_only(self):
        """帧 7：发现服务返回的 skill 卡只追加到 coder#2 的 tail，#1/#3 不受影响。"""
        env = _three_coder_env(self.rt, self.backend)

        self.rt.publish(
            "skill.discovery",
            {"need": "openapi-gen"},
            sender=(env["coder2"], "agent", "io"),
            callback=(env["coder2"], "agent", "io"),
        )
        self.rt.drain(env["coder2"], env["discovery"])

        self.assertIn("skill/openapi-gen@1", self.rt.context_of(env["coder2"], "agent").tail)
        self.assertNotIn("skill/openapi-gen@1", self.rt.context_of(env["coder1"], "agent").tail)
        self.assertNotIn("skill/openapi-gen@1", self.rt.context_of(env["coder3"], "agent").tail)

    def test_A5_discovered_card_does_not_write_back_to_template(self):
        """帧 7 推论：运行期发现不回写模板，新实例不继承。"""
        env = _three_coder_env(self.rt, self.backend)
        self.rt.publish(
            "skill.discovery",
            {"need": "openapi-gen"},
            sender=(env["coder2"], "agent", "io"),
            callback=(env["coder2"], "agent", "io"),
        )
        self.rt.drain(env["coder2"], env["discovery"])

        fresh = self.rt.instantiate(env["coder_template"], owner="system:core")
        self.assertEqual(self.rt.context_of(fresh, "agent").tail, ())


# ===========================================================================
# B 组 —— 边编排（帧 3, 5, 11, 13）
# ===========================================================================


class TestEdgeOrchestration(FoundationTestCase):

    def test_B1_edge_delivers_payload_through_servo(self):
        """帧 3：边是编排主干；Servo 只改 payload。"""
        self.rt.register_transform(
            "norm", role="EDGE_SERVO", body={"map": {"goal": "task"}, "set": {"ok": True}}
        )
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        tpl = self.rt.register_graph_template("edge-flow", {
            "nodes": {
                "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "sink.io", "servo": "norm"}],
        })
        job = self.rt.instantiate(tpl, owner="system:core")
        self.rt.send((job, "start", "io"), {"goal": "add export"})
        self.rt.drain(job)

        got = self.rt.node_persistent_state(job, "sink")["last"]
        self.assertEqual(got, {"task": "add export", "ok": True})

    def test_B2_servo_cannot_alter_route_or_contract(self):
        """帧 3 不变量：Servo 只能改 payload，触碰路由/契约必须被拒。"""
        self.rt.register_transform(
            "evil", role="EDGE_SERVO", body={"set_target": {"to": "other.io"}}
        )
        self.rt.register_handler("record", lambda p, c: {})
        tpl = self.rt.register_graph_template("evil-flow", {
            "nodes": {
                "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "sink.io", "servo": "evil"}],
        })
        job = self.rt.instantiate(tpl, owner="system:core")
        self.rt.send((job, "start", "io"), {"x": 1})
        with self.assertRaises(InvariantError):
            self.rt.drain(job)

    def test_B2b_non_servo_role_cannot_bind_to_an_edge(self):
        """单一 Transform 类型 + role 矩阵：只有 EDGE_SERVO 能绑边。"""
        self.rt.register_transform("proj", role="VARIABLE_PROJECTION", body={"set": {"a": 1}})
        self.rt.register_handler("record", lambda p, c: {})
        tpl = self.rt.register_graph_template("role-flow", {
            "nodes": {
                "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "sink.io", "servo": "proj"}],
        })
        job = self.rt.instantiate(tpl, owner="system:core")
        self.rt.send((job, "start", "io"), {"x": 1})
        with self.assertRaises(InvariantError):
            self.rt.drain(job)

    def test_B3_strategy_fanout_creates_parallel_container_instances(self):
        """帧 5：Strategy 按 plan 展开 3 个并行 coder 容器实例。"""
        job, env = _fanout_env(self.rt, self.backend, instantiation="PER_CALL")
        self.rt.send((job, "start", "io"), {"tasks": [{"t": 1}, {"t": 2}, {"t": 3}]})
        self.rt.drain()

        kids = self.rt.children_of(job, "workers")
        self.assertEqual(len(kids), 3)
        self.assertEqual(len(set(kids)), 3)

    def test_B4_parallel_instances_do_not_share_mutable_state(self):
        """帧 5 推论：三个 coder 实例的上下文与状态互相隔离。"""
        job, env = _fanout_env(self.rt, self.backend, instantiation="PER_CALL")
        self.rt.send((job, "start", "io"), {"tasks": [{"t": 1}, {"t": 2}, {"t": 3}]})
        self.rt.drain()

        kids = self.rt.children_of(job, "workers")
        for i, kid in enumerate(kids, start=1):
            self.rt.append_context_tail(kid, "agent", f"skill/only-{i}@1")
        for i, kid in enumerate(kids, start=1):
            tail = self.rt.context_of(kid, "agent").tail
            self.assertEqual(tail, (f"skill/only-{i}@1",))

    def test_B5_all_required_joins_three_branches_atomically(self):
        """帧 11：三路汇聚 —— 缺一路不触发，齐了只触发一次。"""
        job = _join_env(self.rt)

        self.rt.send((job, "join", "a"), {"v": "a"})
        self.rt.drain(job)
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))

        self.rt.send((job, "join", "b"), {"v": "b"})
        self.rt.drain(job)
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))

        self.rt.send((job, "join", "c"), {"v": "c"})
        self.rt.drain(job)
        self.assertEqual(
            self.rt.node_persistent_state(job, "sink")["last"], {"merged": ["a", "b", "c"]}
        )

    def test_B6_loop_edge_reuses_the_same_node_instance(self):
        """帧 13：循环边回到 worker 不创建新 NodeInstance。"""
        job = _loop_env(self.rt, rounds=3)
        self.rt.send((job, "start", "io"), {"x": 0})
        self.rt.drain(job)

        # 累积在同一个节点实例上 —— 循环不重复实例化
        self.assertEqual(self.rt.node_persistent_state(job, "worker")["runs"], 3)
        self.assertEqual(self.rt.node_persistent_state(job, "loop")["epoch"], 3)


# ===========================================================================
# C 组 —— 队列是独立索引空间（帧 6, 10, B1）  ★ 不变量 M1/M2/M3
# ===========================================================================


class TestQueueIsIndependentIndex(FoundationTestCase):

    def test_C1_same_graph_unconnected_nodes_communicate_via_queue(self):
        """帧 10：同一图内 coder 与 metrics 不连边，通过队列上报进度。

        ★ 这条证明消息不是"跨图专用" —— 判据是静态直连 vs 订阅投递。
        """
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        self.rt.register_handler("noop", lambda p, c: {})
        tpl = self.rt.register_graph_template("with-metrics", _graph_with_unconnected_metrics())
        job = self.rt.instantiate(tpl, owner="system:core")
        self.rt.register_topic("progress", request_contract={"type": "object"})
        self.rt.subscribe("progress", target=(job, "metrics", "io"))

        self.rt.publish("progress", {"pct": 40}, sender=(job, "coder", "io"))
        self.rt.drain(job)

        self.assertEqual(
            self.rt.node_persistent_state(job, "metrics")["last"], {"pct": 40}
        )

    def test_C2_queue_address_is_orthogonal_to_graph_hierarchy(self):
        """帧 6：主题地址不含 graph/container 层级，两个无关实例可订阅同一主题。"""
        self.rt.register_topic("progress", request_contract={"type": "object"})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        self.rt.register_handler("noop", lambda p, c: {})
        tpl = self.rt.register_graph_template("with-metrics", _graph_with_unconnected_metrics())

        a = self.rt.instantiate(tpl, owner="service:job-a")
        b = self.rt.instantiate(tpl, owner="service:job-b")
        self.rt.subscribe("progress", target=(a, "metrics", "io"))
        self.rt.subscribe("progress", target=(b, "metrics", "io"))

        subs = self.rt.queue("progress").subscriber_endpoints
        self.assertIn((a, "metrics", "io"), subs)
        self.assertIn((b, "metrics", "io"), subs)

    def test_C3_callback_lands_on_declared_endpoint_then_edges_take_over(self):
        """帧 6 + 不变量 M3：回复落到已声明端点，之后由边路由。

        可观测性来源：**本轮链路的 RunSnapshot（一个 ObjectVersion）**，
        不是给 envelope 加 edgeId 协议字段。
        """
        env = _three_coder_env(self.rt, self.backend)
        self.rt.publish(
            "skill.discovery",
            {"need": "openapi-gen"},
            sender=(env["coder2"], "agent", "io"),
            callback=(env["coder2"], "agent", "io"),
        )
        self.rt.drain(env["coder2"], env["discovery"])

        self.assertGreater(self.rt.commit_seq(env["coder2"]), 0)
        oid = f"run/{env['coder2']}"
        snapshot = self.rt.artifact(oid, self.rt.artifact_versions(oid)[-1])
        # 全量 JSON 里能看出：消息只到端点为止，之后是边接管
        self.assertIn("edges_traversed", snapshot)
        self.assertEqual(snapshot["endpoint"], "io")

    def test_C4_message_cannot_select_an_edge(self):
        """不变量 M1：消息不参与图内路由决策。

        试图让消息指定下游边应被拒绝。
        """
        self.rt.register_topic("progress", request_contract={"type": "object"})
        with self.assertRaises(InvariantError):
            self.rt.publish("progress", {"pct": 1, "edgeId": "e1"})

    def test_C5_publish_fans_out_with_isolated_payload_copies(self):
        """帧 6：PUBLISH 语义 —— 多订阅者各收一份独立副本。"""
        self.rt.register_topic("progress", request_contract={"type": "object"})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        self.rt.register_handler("noop", lambda p, c: {})
        tpl = self.rt.register_graph_template("with-metrics", _graph_with_unconnected_metrics())
        a = self.rt.instantiate(tpl, owner="service:job-a")
        b = self.rt.instantiate(tpl, owner="service:job-b")
        self.rt.subscribe("progress", target=(a, "metrics", "io"))
        self.rt.subscribe("progress", target=(b, "metrics", "io"))

        self.rt.publish("progress", {"pct": 40})
        self.rt.drain(a, b)

        ra = self.rt.node_persistent_state(a, "metrics")["last"]
        rb = self.rt.node_persistent_state(b, "metrics")["last"]
        self.assertEqual(ra, rb)
        self.assertIsNot(ra, rb)   # 独立副本，互不污染

    def test_C6_two_unrelated_jobs_share_one_service_instance(self):
        """帧 B1：编码 Job 与调研 Job 向同一个发现服务发请求。

        两者之间没有任何静态关系 —— 这是队列存在的第一位理由。
        """
        env = _three_coder_env(self.rt, self.backend)
        research_tpl = self.rt.register_graph_template("research-flow", _coder_template())
        research = self.rt.instantiate(research_tpl, owner="service:job-b")

        for caller in (env["coder1"], research):
            self.rt.publish(
                "skill.discovery",
                {"need": "openapi-gen"},
                sender=(caller, "agent", "io"),
                callback=(caller, "agent", "io"),
            )
        self.rt.drain(env["coder1"], research, env["discovery"])

        self.assertIn("skill/openapi-gen@1", self.rt.context_of(env["coder1"], "agent").tail)
        self.assertIn("skill/openapi-gen@1", self.rt.context_of(research, "agent").tail)

    def test_C7_subscription_change_does_not_alter_graph_topology(self):
        """不变量 M2：增删订阅不产生图内边。"""
        self.rt.register_topic("progress", request_contract={"type": "object"})
        self.rt.register_handler("record", lambda p, c: {})
        self.rt.register_handler("noop", lambda p, c: {})
        tpl = self.rt.register_graph_template("with-metrics", _graph_with_unconnected_metrics())
        job = self.rt.instantiate(tpl, owner="system:core")

        before = list(self.rt._templates[tpl]["edges"])
        sid = self.rt.subscribe("progress", target=(job, "metrics", "io"))
        self.rt.unsubscribe(sid)
        self.assertEqual(self.rt._templates[tpl]["edges"], before)

    def test_C8_run_snapshot_is_retained_but_not_transmitted(self):
        """可观测性设计：全量 JSON 保留为 ObjectVersion，传递时不带。"""
        env = _three_coder_env(self.rt, self.backend)
        self.rt.publish(
            "skill.discovery",
            {"need": "openapi-gen"},
            sender=(env["coder2"], "agent", "io"),
            callback=(env["coder2"], "agent", "io"),
        )
        self.rt.drain(env["coder2"], env["discovery"])

        oid = f"run/{env['coder2']}"
        self.assertTrue(self.rt.artifact_versions(oid))          # 保留
        req = self.backend.last_request_for("coder")
        for m in req.context.messages:                            # 传递时不带
            self.assertNotIn("edges_traversed", m or {})

    def test_C9_servo_can_inject_custom_fields_into_snapshot(self):
        """自定义注入配 Servo，不需要给 envelope 加协议字段。"""
        self.rt.register_transform("tag", role="EDGE_SERVO", body={"set": {"trace_tag": "abc"}})
        self.rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
        tpl = self.rt.register_graph_template(
            "servo-flow",
            {
                "nodes": {
                    "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
                    "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
                },
                "edges": [{"id": "e1", "from": "start.out", "to": "sink.io", "servo": "tag"}],
            },
        )
        job = self.rt.instantiate(tpl, owner="system:core")
        self.rt.send((job, "start", "io"), {"x": 1})
        self.rt.drain(job)

        self.assertEqual(self.rt.node_persistent_state(job, "sink")["last"]["trace_tag"], "abc")
        oid = f"run/{job}"
        snaps = [self.rt.artifact(oid, v) for v in self.rt.artifact_versions(oid)]
        self.assertTrue(any("trace_tag" in (s.get("payload") or {}) for s in snaps))


# ===========================================================================
# D 组 —— 子流程的两种复用形态（帧 6, 9, B2）  ★ 新增重点
# ===========================================================================


class TestSubflowReuse(FoundationTestCase):

    def test_D1_call_style_per_call_instances_are_isolated(self):
        """帧 9：同一个 review 模板被调 3 次，得到 3 个隔离实例。"""
        job = _subflow_env(self.rt, instantiation="PER_CALL")
        for i in range(3):
            self.rt.send((job, "caller", "io"), {"round": i})
            self.rt.drain()

        kids = self.rt.children_of(job, "reviewers")
        self.assertEqual(len(set(kids)), 3)
        # 每个子实例只见过自己那一轮
        for i, kid in enumerate(kids):
            self.assertEqual(self.rt.node_persistent_state(kid, "work")["seen"], [{"round": i}])

    def test_D2_warm_pool_reuses_resources_but_not_state(self):
        """帧 B2：WARM_POOL(2) 承接 5 次调用，实例数不超过 2。

        ★ 判据是暗示性：每次承接调用前 persistentState 必须清空。
          需要跨轮保留的东西走产物层，不藏在节点状态里。
        """
        job = _subflow_env(self.rt, instantiation="WARM_POOL(2)")
        for i in range(5):
            self.rt.send((job, "caller", "io"), {"round": i})
            self.rt.drain()

        kids = self.rt.children_of(job, "reviewers")
        self.assertEqual(len(kids), 2)                    # 资源被复用
        for kid in kids:
            seen = self.rt.node_persistent_state(kid, "work")["seen"]
            self.assertEqual(len(seen), 1)                # 状态每次清空，无残留

    def test_D3_service_style_is_long_lived_instance_plus_subscription(self):
        """帧 6：服务式复用不引入新对象。

        ★ 断言发现服务就是"长期 OPEN 的 GraphInstance + Subscription"，
        不存在 ServiceInstance / ServiceRun 之类的第三种身份。
        """
        env = _three_coder_env(self.rt, self.backend)
        self.assertEqual(self.rt.graph_status(env["discovery"]), "OPEN")
        subs = self.rt.queue("skill.discovery").subscriber_endpoints
        self.assertIn((env["discovery"], "in", "io"), subs)

    def test_D4_service_instance_survives_caller_close(self):
        """帧 6 推论：调用方关闭后，服务实例仍 OPEN，可继续服务他人。"""
        env = _three_coder_env(self.rt, self.backend)
        self.rt.control(env["coder2"], "close", actor="system:core")
        self.assertEqual(self.rt.graph_status(env["discovery"]), "OPEN")

    def test_D5_reference_node_has_no_static_edge_to_service(self):
        """帧 6：调用方与服务之间不存在静态边 —— 只能靠队列。

        对比 D1：调用式复用有 slot（静态声明），服务式复用连 slot 都没有。
        """
        env = _three_coder_env(self.rt, self.backend)
        coder_spec = self.rt._templates[env["coder_template"]]
        self.assertEqual(coder_spec.get("edges", []), [])
        self.assertNotIn("slots", coder_spec)
        # 唯一的连接是订阅，且它挂在服务侧，不在调用侧
        self.assertEqual(
            self.rt.queue("skill.discovery").subscriber_endpoints,
            ((env["discovery"], "in", "io"),),
        )

    def test_D6_call_style_child_close_does_not_orphan_parent(self):
        """帧 9：子实例关闭后，不制造永远等待的子调用，父输入恢复 QUEUED。"""
        job = _subflow_env(self.rt, instantiation="SINGLETON")
        self.rt.send((job, "caller", "io"), {"round": 0})
        self.rt.drain()

        child = self.rt.children_of(job, "reviewers")[0]
        self.rt.control(child, "close", actor="system:core")

        self.rt.send((job, "caller", "io"), {"round": 1})
        with self.assertRaises(InvariantError):
            self.rt.drain()


# ===========================================================================
# E 组 —— 执行面（帧 3, 8, 14）
# ===========================================================================


class TestExecutionPlane(FoundationTestCase):

    def test_E1_execution_request_carries_compiled_context(self):
        """帧 3：ExecutionRequest 精确携带 head/messages/tail/transient。

        编排面存在的理由就是这一条。
        """
        job = _agent_env(self.rt, self.backend, head=("doc/spec@1",))
        self.rt.append_context_tail(job, "worker", "skill/extra@1")
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)

        req = self.backend.last_request_for("worker")
        self.assertEqual(req.context.head, ("doc/spec@1",))
        self.assertEqual(req.context.messages, ({"task": "t1"},))
        self.assertEqual(req.context.tail, ("skill/extra@1",))
        self.assertEqual(req.origin, (job, "worker"))

    def test_E2_agent_can_only_emit_declared_ports(self):
        """★ 第一不变量：Agent 只能选，不能构造。

        emit 一个未声明的 port 必须被拒绝，且不产生任何下游消息。
        """
        job = _agent_env(self.rt, self.backend)
        self.backend.on("worker", lambda req: _ok(req, emissions=(("nowhere", {"x": 1}),)))
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)          # 拒绝被捕获并释放，不再穿透 drain

        recs = [r for r in self.rt.node_executions(job, "worker")]
        self.assertEqual([r.status for r in recs], ["FAILED"])
        msgs = [m for m in self.rt._messages.values() if m.target[0] == job]
        self.assertTrue(all(m.state == "FAILED" for m in msgs),
                        [m.state for m in msgs])
        # 下游 sink 未被触发
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))

    def test_E3_invalid_output_retries_inside_execution_plane(self):
        """帧 3：输出不合 schema 是常态，重试循环属执行面，不上升为协议错误。"""
        job = _agent_env(self.rt, self.backend)
        attempts: list[int] = []

        def flaky(req):
            attempts.append(1)
            if len(attempts) < 3:
                return _ok(req, termination="INVALID_OUTPUT")
            return _ok(req, emissions=(("out", {"ok": True}),))

        self.backend.on("worker", flaky)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        self.rt.drain(job)

        self.assertEqual(len(attempts), 3)
        applied = [r for r in self.rt.node_executions(job, "worker") if r.status == "APPLIED"]
        self.assertEqual(len(applied), 1)          # 三次尝试，一次提交

    def test_E4_cancel_aborts_inflight_execution_and_preserves_commits(self):
        """帧 14：取消在途执行，先前提交保留，输入退回不丢工作。"""
        job = _agent_env(self.rt, self.backend)
        self.rt.send((job, "worker", "io"), {"task": "round-1"})
        self.rt.drain(job)
        snapshots_after_first = len(self.rt.artifact_versions(f"run/{job}"))

        self.rt.send((job, "worker", "io"), {"task": "round-2"})
        eid, _req = self.rt.begin_execution(job, "worker")
        self.rt.cancel_execution(eid)

        rec = {r.execution_id: r for r in self.rt.node_executions(job, "worker")}[eid]
        self.assertEqual(rec.status, "CANCELLED")
        # 先前那一轮的提交事实原样保留
        self.assertEqual(len(self.rt.artifact_versions(f"run/{job}")), snapshots_after_first)

    def test_E5_conflict_domain_is_node_scoped_not_container_scoped(self):
        """★ 并行的前提：A 在途时 B 提交，A 的 apply 不因容器序号推进而作废。"""
        job = _two_agent_env(self.rt, self.backend)

        self.rt.send((job, "a", "io"), {"task": "a1"})
        eid_a, _req_a = self.rt.begin_execution(job, "a")     # A claim，尚未 apply

        self.rt.send((job, "b", "io"), {"task": "b1"})        # B 全程跑完并提交
        self.rt.drain(job)

        # A 现在提交 —— 节点级 base 未变，应当成功
        self.rt.apply_execution(
            eid_a, ExecutionResult(execution_id=eid_a, emissions=(("out", {"done": "a"}),))
        )
        statuses = {r.execution_id: r.status for r in self.rt.node_executions(job, "a")}
        self.assertEqual(statuses[eid_a], "APPLIED")

    def test_E6_claim_survives_crash_and_is_reclaimable(self):
        """帧 14：ExecutionRecord 是崩溃接管的唯一依据。"""
        job = _agent_env(self.rt, self.backend)
        self.rt.send((job, "worker", "io"), {"task": "t1"})
        eid, _req = self.rt.begin_execution(job, "worker")

        # —— 进程在这里崩溃 ——
        self.assertIn(eid, self.rt.reclaim_stale_executions())

        # 输入退回 QUEUED，可被重新认领并跑完
        self.rt.drain(job)
        applied = [r for r in self.rt.node_executions(job, "worker") if r.status == "APPLIED"]
        self.assertEqual(len(applied), 1)

    # 注：文件 / git / 编辑范围已判定为运行时 tool 行为（FOUNDATION §5.5），
    #     内核不建模，此处不设测试。

    def test_E8_session_handle_is_opaque_to_orchestration(self):
        """编排面只存不解释 session_handle，下一轮原样回传。"""
        job = _agent_env(self.rt, self.backend)
        token = object()
        seen: list[object] = []

        def worker(req):
            seen.append(req.resume_handle)
            return _ok(req, session_handle=token)

        self.backend.on("worker", worker)
        self.rt.send((job, "worker", "io"), {"task": "r1"})
        self.rt.drain(job)
        self.rt.send((job, "worker", "io"), {"task": "r2"})
        self.rt.drain(job)

        self.assertEqual(seen, [None, token])      # 第二轮原样拿回，未被解析


# ===========================================================================
# F 组 —— Checkpoint 与上下文裁剪（帧 12, 13, 15）  ★ 命题核心
# ===========================================================================


class TestLoopAnchorAndContextTrimming(FoundationTestCase):

    def test_F1_loop_strategy_writes_annotation_with_object_refs(self):
        """帧 12：循环锚点 = Strategy 配置 + 一条轻量 Annotation。

        ★ 断言不存在独立的 Checkpoint 机制：没有 checkpoint node kind、
          没有 seal 协议、没有 CheckpointRecord。
        """
        job = _rework_env(self.rt, self.backend)
        self.rt.send((job, "coder", "io"), {"task": "add export"})
        self.rt.drain(job)

        anns = self.rt.annotations(job)
        self.assertEqual(len(anns), 2)                       # 两个 epoch 各一条
        self.assertEqual(anns[0].body["object_refs"]["plan"], "plan@2")
        self.assertEqual(anns[0].body["fields"]["epoch"], 1)
        # Annotation 就是 ObjectVersion，无独立类型，且带 provenance
        self.assertEqual(anns[0].kind, "annotation")
        self.assertEqual(anns[0].provenance.graph_instance_id, job)
        self.assertIn("plan@2", anns[0].provenance.derived_from)
        # 没有独立的 Checkpoint 机制
        self.assertFalse(hasattr(self.rt, "checkpoints"))

    def test_F1b_no_checkpoint_node_kind_exists(self):
        """§5.6：注册 kind='checkpoint' 的节点应被拒绝。"""
        with self.assertRaises(InvariantError):
            self.rt.register_graph_template("bad", {
                "nodes": {"cp": {"kind": "checkpoint", "endpoints": {"io": {}}}},
                "edges": [],
            })

    def test_F2_rework_epoch_context_excludes_previous_epoch_history(self):
        """★★ 帧 13 —— 整个系统存在的理由。

        epoch 2 的 coder 上下文必须只含 head + 失败用例切片，
        必须不含 epoch 1 的完整执行历史。
        """
        job = _rework_env(self.rt, self.backend)
        self.rt.send((job, "coder", "io"), {"task": "add export"})
        self.rt.drain(job)

        reqs = [r for r in self.backend.seen if r.agent_spec["spec_id"] == "coder"]
        self.assertEqual(len(reqs), 2)
        e1, e2 = reqs

        # head 跨 epoch 不变
        self.assertEqual(e1.context.head, e2.context.head)
        # epoch 2 只看到失败切片，不含 epoch 1 的原始任务
        self.assertEqual(e2.context.messages, ({"failed": ["t_07"], "files": ["export.py"]},))
        self.assertNotIn({"task": "add export"}, e2.context.messages)
        # 每轮上下文都是重建的单条，不累积
        self.assertEqual(len(e1.context.messages), 1)
        self.assertEqual(len(e2.context.messages), 1)
        # 节点状态里不藏上一轮的执行历史
        self.assertNotIn("transcript", self.rt.node_persistent_state(job, "coder"))

    def test_F3_compaction_is_surfaced_as_a_failure_signal(self):
        """帧 13 推论：usage.compactions 非零必须可观测并可告警。"""
        job = _agent_env(self.rt, self.backend)
        self.backend.on(
            "worker",
            lambda req: _ok(req, emissions=(("out", {}),), usage=Usage(compactions=2)),
        )
        self.rt.send((job, "worker", "io"), {"task": "huge"})
        self.rt.drain(job)

        self.assertEqual(self.rt.usage(job).compactions, 2)
        alerts = self.rt.context_alerts(job)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["node"], "worker")

    def test_F4_context_budget_is_enforced_before_invocation(self):
        """帧 13：超预算在调用前拒绝，而不是让 harness 去压缩。"""
        job = _agent_env(self.rt, self.backend, budget=5)
        self.rt.send((job, "worker", "io"), {"task": "x" * 500})
        with self.assertRaises(InvariantError):
            self.rt.drain(job)
        # 关键：backend 从未被调用过
        self.assertEqual([r for r in self.backend.seen if r.agent_spec["spec_id"] == "worker"], [])

    def test_F5_reinstantiate_from_annotation_refs(self):
        """帧 15：fork 不是专门机制。

        取 epoch 1 那条 Annotation 的 object_refs 当 params 调 instantiate()，
        就是一条独立分支。断言 Runtime 上不存在 fork_from_checkpoint。
        """
        self.assertFalse(hasattr(self.rt, "fork_from_checkpoint"))

        job = _rework_env(self.rt, self.backend)
        self.rt.send((job, "coder", "io"), {"task": "add export"})
        self.rt.drain(job)

        epoch1 = self.rt.annotations(job)[0]
        refs = list(epoch1.body["object_refs"].values())
        branch = self.rt.instantiate(
            self.rt._instances[job].template_ref,
            owner="human:alice",
            params={"context_head": refs},
        )
        self.assertNotEqual(branch, job)
        self.assertEqual(self.rt.context_of(branch, "coder").head, tuple(refs))
        # 新分支自己的提交序号从零开始，与原分支互不影响
        self.assertEqual(self.rt.commit_seq(branch), 0)


# ===========================================================================
# G 组 —— 控制面与授权（帧 0, 4, 14）
# ===========================================================================


class TestControlPlane(FoundationTestCase):

    def test_G1_approval_node_blocks_until_authorized_actor_responds(self):
        """帧 4：人工审批节点，未授权主体的答复应被拒绝。"""
        job = _approval_env(self.rt, self.backend)
        self.rt.send((job, "planner", "io"), {"goal": "add export"})
        self.rt.drain(job)

        # 停在审批处，下游未被触发
        self.assertNotIn("last", self.rt.node_persistent_state(job, "sink"))

        with self.assertRaises(AuthorizationError):
            self.rt.approve(job, "gate", actor="agent:rogue", decision="allow")

        self.rt.approve(job, "gate", actor="human:alice", decision="allow")
        self.rt.drain(job)
        self.assertIn("last", self.rt.node_persistent_state(job, "sink"))

    def test_G2_approved_edit_produces_a_new_artifact_version(self):
        """帧 4：人改了 plan@1，产出 plan@2，而不是原地覆盖。"""
        job = _approval_env(self.rt, self.backend)
        self.rt.send((job, "planner", "io"), {"goal": "add export"})
        self.rt.drain(job)
        self.assertEqual(self.rt.artifact_versions("plan"), [1])

        self.rt.approve(
            job, "gate", actor="human:alice", decision="allow",
            payload={"plan": ["a", "b", "c"], "edited_by": "human:alice"},
        )
        self.rt.drain(job)

        self.assertEqual(self.rt.artifact_versions("plan"), [1, 2])
        self.assertEqual(self.rt.artifact("plan", 2)["edited_by"], "human:alice")

    def test_G3_control_is_an_authorized_message_not_a_bypass_api(self):
        """帧 14：pause/close 走授权路径并留下提交事实；payload 不能自封 actor。"""
        job = _agent_env(self.rt, self.backend)

        with self.assertRaises(AuthorizationError):
            self.rt.control(job, "close", actor="agent:rogue")
        self.assertEqual(self.rt.graph_status(job), "OPEN")

        before = len(self.rt.artifact_versions(f"run/{job}"))
        self.rt.control(job, "close", actor="service:job")
        self.assertEqual(self.rt.graph_status(job), "CLOSED")
        # 不是旁路：状态变更本身留下了一条提交事实
        after = self.rt.artifact_versions(f"run/{job}")
        self.assertEqual(len(after), before + 1)
        self.assertEqual(self.rt.artifact(f"run/{job}", after[-1])["control"], "close")

    def test_G4_closed_instance_rejects_new_work_and_new_children(self):
        """CLOSED 终态：拒绝新工作、拒绝新子实例。"""
        job = _subflow_env(self.rt, instantiation="PER_CALL")
        self.rt.send((job, "caller", "io"), {"round": 0})
        self.rt.drain()

        self.rt.control(job, "close", actor="service:job")

        with self.assertRaises(InvariantError):
            self.rt.send((job, "caller", "io"), {"round": 1})

        # 已 CLOSED 的实例不得再派生子实例
        inst = self.rt._instances[job]
        slot = self.rt._templates[inst.template_ref]["slots"]["reviewers"]
        with self.assertRaises(InvariantError):
            self.rt._spawn_child(inst, "reviewers", slot)


# ===========================================================================
# H 组 —— 版本管理单例（INTERFACES_V4.md §3，不变量 V1–V4）
# ===========================================================================


class TestObjectStore(FoundationTestCase):

    def test_H1_version_is_allocated_only_by_the_store(self):
        """V1：backend 只提交内容，版本号由 store 分配。

        ExecutionResult.artifacts 里没有版本位可填 —— 接口层面就杜绝了对不齐。
        """
        job = _agent_env(self.rt, self.backend)
        self.backend.on("worker", lambda req: _ok(
            req, emissions=(("out", {}),),
            artifacts=(("plan", "plan", {"n": 1}),),
        ))
        self.rt.send((job, "worker", "io"), {"t": 1})
        self.rt.drain(job)

        ov = self.rt.store.head("plan")
        self.assertEqual(ov.version, 1)
        self.assertEqual(ov.kind, "plan")
        # provenance 记住了是谁产出的
        self.assertEqual(ov.provenance.graph_instance_id, job)
        self.assertEqual(ov.provenance.node_id, "worker")
        self.assertIsNotNone(ov.provenance.execution_id)

    def test_H2_object_version_outlives_the_instance_that_made_it(self):
        """V2：ObjectVersion 独立于 GraphInstance —— 这是 F5 能成立的前提。"""
        job = _agent_env(self.rt, self.backend)
        self.backend.on("worker", lambda req: _ok(
            req, emissions=(("out", {}),), artifacts=(("plan", "plan", {"n": 1}),)))
        self.rt.send((job, "worker", "io"), {"t": 1})
        self.rt.drain(job)

        self.rt.control(job, "close", actor="service:job")
        self.assertEqual(self.rt.graph_status(job), "CLOSED")
        # 实例已终态，产物照常可读
        self.assertEqual(self.rt.store.get("plan", 1).body, {"n": 1})

    def test_H3_identical_content_is_idempotent(self):
        """V3：内容寻址 —— 同内容重复提交返回同一版本，不产生噪声版本。"""
        p = self.rt.store.put("spec", "spec", {"a": 1})
        q = self.rt.store.put("spec", "spec", {"a": 1})
        r = self.rt.store.put("spec", "spec", {"a": 2})

        self.assertEqual(p.version, q.version)
        self.assertEqual(p.content_hash, q.content_hash)
        self.assertEqual(r.version, 2)
        self.assertEqual(self.rt.artifact_versions("spec"), [1, 2])

    def test_H4_references_must_be_exact(self):
        """V4：运行引用只接受 object_id@version，没有 latest。"""
        self.rt.store.put("plan", "plan", {"a": 1})
        self.assertEqual(self.rt.store.resolve("plan@1").body, {"a": 1})
        with self.assertRaises(InvariantError):
            self.rt.store.resolve("plan")

    def test_H5_lineage_is_traceable_through_provenance(self):
        """trace 追踪：Annotation 的 object_refs 成为 derived_from，可回溯。"""
        job = _rework_env(self.rt, self.backend)
        self.rt.send((job, "coder", "io"), {"task": "add export"})
        self.rt.drain(job)

        ann = self.rt.annotations(job)[0]
        graph = self.rt.store.lineage(ann.ref)
        self.assertIn("plan@2", graph[ann.ref])
        self.assertIn("manifest@1", graph[ann.ref])

    def test_H6_run_snapshot_is_just_an_object_version(self):
        """RunSnapshot 统一成 kind='run' 的 ObjectVersion，自动获得 provenance。"""
        job = _agent_env(self.rt, self.backend)
        self.rt.send((job, "worker", "io"), {"t": 1})
        self.rt.drain(job)

        snaps = self.rt.store.history(f"run/{job}")
        self.assertTrue(snaps)
        self.assertTrue(all(s.kind == "run" for s in snaps))
        self.assertEqual(snaps[-1].provenance.graph_instance_id, job)


# ===========================================================================
# 测试夹具（随实现推进逐步填充）
# ===========================================================================


def _plan_flow_spec() -> dict:
    """主流程模板：start -> planner(agent) -> end。"""
    return {
        "nodes": {
            "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
            "planner": {"kind": "agent", "spec": "planner", "endpoints": {"io": {}, "out": {}}},
            "end": {"kind": "end", "endpoints": {"io": {}}},
        },
        "edges": [
            {"id": "e1", "from": "start.out", "to": "planner.io"},
            {"id": "e2", "from": "planner.out", "to": "end.io"},
        ],
    }


def _graph_with_unconnected_metrics() -> dict:
    """coder 与 metrics 两个节点，它们之间**没有任何边**。"""
    return {
        "nodes": {
            "coder": {"kind": "plain", "handler": "noop", "endpoints": {"io": {}}},
            "metrics": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [],
    }


def _coder_template() -> dict:
    return {
        "nodes": {
            "agent": {"kind": "agent", "spec": "coder", "endpoints": {"io": {}, "out": {}}},
        },
        "edges": [],
    }


def _discovery_template() -> dict:
    """发现服务：一个长期 OPEN 的普通图 + 一条订阅声明。无新对象。"""
    return {
        "nodes": {
            "in": {"kind": "plain", "handler": "discover", "endpoints": {"io": {}}},
        },
        "edges": [],
        "subscriptions": [{"topic": "skill.discovery", "endpoint": "in.io"}],
    }


def _fanout_env(rt: Runtime, backend: MockExecutionBackend, *, instantiation="PER_CALL"):
    """帧 5：start -> split(strategy) -> 按 slot 展开 N 个 coder 子容器。"""
    rt.register_card(kind="rules", card_id="py-strict", version=3, body={})
    rt.compile_agent_spec("coder", model="m", cards=[("rules", "py-strict")])
    backend.on("coder", lambda req: _ok(req))

    coder_tpl = rt.register_graph_template("coder-flow", _coder_template())
    rt.register_policy("fanout", {
        "readiness": "ANY",
        "output": {"mode": "FANOUT_TO_SLOT", "slot": "workers"},
    })
    rt.register_handler("split_plan", lambda payloads, ctx: {
        "items": list(next(iter(payloads.values()))["tasks"])
    })

    tpl = rt.register_graph_template("fanout-flow", {
        "nodes": {
            "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
            "split": {"kind": "strategy", "policy": "fanout", "handler": "split_plan",
                      "endpoints": {"io": {}, "out": {}}},
        },
        "edges": [{"id": "e1", "from": "start.out", "to": "split.io"}],
        "slots": {
            "workers": {
                "template": coder_tpl,
                "instantiation": instantiation,
                "entry": "agent.io",
            }
        },
    })
    return rt.instantiate(tpl, owner="service:job"), {"coder_template": coder_tpl}


def _agent_env(rt: Runtime, backend: MockExecutionBackend, *, head=(), budget=None) -> str:
    """单 agent 节点 + sink，用于执行面三段式测试。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("worker", model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    worker = {"kind": "agent", "spec": "worker", "endpoints": {"io": {}, "out": {}}}
    if budget is not None:
        worker["limits"] = {"token_budget": budget}
    tpl = rt.register_graph_template("agent-flow", {
        "nodes": {
            "worker": worker,
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
    })
    backend.on("worker", lambda req: _ok(req, emissions=(("out", {"done": True}),)))
    return rt.instantiate(tpl, owner="service:job", params={"context_head": list(head)})


def _approval_env(rt: Runtime, backend: MockExecutionBackend) -> str:
    """帧 3–4：planner(agent) -> gate(approval) -> sink。人审后产出新版本。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("planner", model="m", cards=[("rules", "base")])

    def publish_plan(payload, ctx):
        ctx["publish"]("plan", payload)
        ctx["state"]["last"] = payload
        return {}

    rt.register_handler("publish_plan", publish_plan)
    tpl = rt.register_graph_template("approval-flow", {
        "nodes": {
            "planner": {"kind": "agent", "spec": "planner", "endpoints": {"io": {}, "out": {}}},
            "gate": {"kind": "approval", "authorized_actors": ["human:alice"],
                     "approve_port": "out", "endpoints": {"io": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "publish_plan", "endpoints": {"io": {}}},
        },
        "edges": [
            {"id": "e1", "from": "planner.out", "to": "gate.io"},
            {"id": "e2", "from": "gate.out", "to": "sink.io"},
        ],
    })

    def planner(req):
        # agent 只提交内容，版本号由 ObjectStore 分配（不变量 V1）
        return _ok(req, emissions=(("out", {"plan": ["a", "b"]}),),
                   artifacts=(("plan", "plan", {"plan": ["a", "b"]}),))

    backend.on("planner", planner)
    return rt.instantiate(tpl, owner="service:job", controllers=("human:alice",))


def _rework_env(rt: Runtime, backend: MockExecutionBackend) -> str:
    """帧 11–13：coder -> gate(strategy)。第一轮判失败并回环，第二轮通过。

    回环时 gate 只把**失败切片**放进下一轮 payload —— 上下文裁剪的落点。
    """
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    rt.compile_agent_spec("coder", model="m", cards=[("rules", "base")])

    def gate(payloads, ctx):
        epoch = ctx["state"].get("epoch", 0) + 1
        ctx["state"]["epoch"] = epoch
        ann = {
            "object_refs": {"plan": "plan@2", "manifest": f"manifest@{epoch}"},
            "fields": {"epoch": epoch},
        }
        if epoch == 1:
            # 判返工：只带失败用例 + 相关文件，丢掉本轮全部过程
            return {"annotate": ann,
                    "emit": {"again": {"failed": ["t_07"], "files": ["export.py"]}}}
        return {"annotate": ann, "emit": {"done": {"ok": True}}}

    rt.register_handler("gate", gate)
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    rt.register_policy("gate-policy", {"readiness": "ANY", "output": {}})

    tpl = rt.register_graph_template("rework-flow", {
        "nodes": {
            "coder": {"kind": "agent", "spec": "coder", "endpoints": {"io": {}, "out": {}}},
            "gate": {"kind": "strategy", "policy": "gate-policy", "handler": "gate",
                     "endpoints": {"io": {}, "again": {}, "done": {}}},
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [
            {"id": "e1", "from": "coder.out", "to": "gate.io"},
            {"id": "e2", "from": "gate.again", "to": "coder.io"},   # 循环边
            {"id": "e3", "from": "gate.done", "to": "sink.io"},
        ],
    })
    backend.on("coder", lambda req: _ok(req, emissions=(("out", {"built": True}),)))
    return rt.instantiate(tpl, owner="service:job", params={"context_head": ["repo/survey@1"]})


def _two_agent_env(rt: Runtime, backend: MockExecutionBackend) -> str:
    """两个互不相干的 agent 节点，用于验证冲突域是节点级而非容器级。"""
    rt.register_card(kind="rules", card_id="base", version=1, body={})
    for spec in ("a", "b"):
        rt.compile_agent_spec(spec, model="m", cards=[("rules", "base")])
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    tpl = rt.register_graph_template("two-agent-flow", {
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
    backend.on("a", lambda req: _ok(req, emissions=(("out", {"from": "a"}),)))
    backend.on("b", lambda req: _ok(req, emissions=(("out", {"from": "b"}),)))
    return rt.instantiate(tpl, owner="service:job")


def _subflow_env(rt: Runtime, *, instantiation: str) -> str:
    """帧 9：引用节点（subflow）按 instantiationPolicy 复用一个 review 模板。"""
    def work(payload, ctx):
        ctx["state"].setdefault("seen", []).append(payload)
        return {"reply": {"reviewed": payload}}

    rt.register_handler("work", work)
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})

    review_tpl = rt.register_graph_template("review-flow", {
        "nodes": {"work": {"kind": "plain", "handler": "work", "endpoints": {"io": {}}}},
        "edges": [],
    })
    tpl = rt.register_graph_template("caller-flow", {
        "nodes": {
            "caller": {"kind": "subflow", "slot": "reviewers",
                       "return_port": "out", "endpoints": {"io": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "caller.out", "to": "sink.io"}],
        "slots": {
            "reviewers": {
                "template": review_tpl,
                "instantiation": instantiation,
                "entry": "work.io",
            }
        },
    })
    return rt.instantiate(tpl, owner="service:job")


def _join_env(rt: Runtime) -> str:
    """帧 11：三路 ALL_REQUIRED 汇聚。"""
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})
    rt.register_policy("joinall", {
        "readiness": "ALL_REQUIRED",
        "required_inputs": ["a", "b", "c"],
    })
    rt.register_handler("collect", lambda payloads, ctx: {
        "emit": {"out": {"merged": [payloads[k]["v"] for k in sorted(payloads)]}}
    })
    tpl = rt.register_graph_template("join-flow", {
        "nodes": {
            "join": {"kind": "strategy", "policy": "joinall", "handler": "collect",
                     "endpoints": {"a": {}, "b": {}, "c": {}, "out": {}}},
            "sink": {"kind": "plain", "handler": "record", "endpoints": {"io": {}}},
        },
        "edges": [{"id": "e1", "from": "join.out", "to": "sink.io"}],
    })
    return rt.instantiate(tpl, owner="service:job")


def _loop_env(rt: Runtime, *, rounds: int) -> str:
    """帧 13：固定拓扑上的循环 —— 循环锚点是 strategy 配置，不是节点种类。"""
    def bump(payload, ctx):
        ctx["state"]["runs"] = ctx["state"].get("runs", 0) + 1
        return {"out": payload}

    def loop_ctl(payloads, ctx):
        epoch = ctx["state"].get("epoch", 0) + 1
        ctx["state"]["epoch"] = epoch
        body = next(iter(payloads.values()))
        port = "again" if epoch < rounds else "done"
        return {"emit": {port: body}}

    rt.register_handler("bump", bump)
    rt.register_handler("loop_ctl", loop_ctl)
    rt.register_policy("loopN", {"readiness": "ANY"})
    tpl = rt.register_graph_template("loop-flow", {
        "nodes": {
            "start": {"kind": "start", "emit": "out", "endpoints": {"io": {}, "out": {}}},
            "worker": {"kind": "plain", "handler": "bump", "endpoints": {"io": {}, "out": {}}},
            "loop": {"kind": "strategy", "policy": "loopN", "handler": "loop_ctl",
                     "endpoints": {"io": {}, "again": {}, "done": {}}},
            "end": {"kind": "end", "endpoints": {"io": {}}},
        },
        "edges": [
            {"id": "e1", "from": "start.out", "to": "worker.io"},
            {"id": "e2", "from": "worker.out", "to": "loop.io"},
            {"id": "e3", "from": "loop.again", "to": "worker.io"},
            {"id": "e4", "from": "loop.done", "to": "end.io"},
        ],
    })
    return rt.instantiate(tpl, owner="service:job")


def _three_coder_env(rt: Runtime, backend: MockExecutionBackend) -> dict:
    """帧 5–9 的环境：3 个并行 coder 实例 + 1 个长期 OPEN 的发现服务。"""
    rt.register_card(kind="rules", card_id="py-strict", version=3, body={})
    rt.register_card(kind="skill", card_id="openapi-gen", version=1, body={})
    rt.compile_agent_spec("coder", model="m", cards=[("rules", "py-strict")])

    rt.register_topic("skill.discovery", request_contract={"type": "object"},
                      reply_contract={"type": "object"})

    def discover(payload, ctx):
        return {"reply": {"card_ref": f"skill/{payload['need']}@1"}}

    rt.register_handler("discover", discover)
    rt.register_handler("noop", lambda p, c: {})
    rt.register_handler("record", lambda p, c: c["state"].update({"last": p}) or {})

    coder_tpl = rt.register_graph_template("coder-flow", _coder_template())
    disc_tpl = rt.register_graph_template("discovery-svc", _discovery_template())

    discovery = rt.instantiate(disc_tpl, owner="system:core")
    coders = [rt.instantiate(coder_tpl, owner="service:job") for _ in range(3)]

    def coder_agent(req):
        # 收到发现服务回投的卡片 → 追加到本实例 tail（不回写模板）
        gid, node = req.origin
        for m in req.context.messages:
            if isinstance(m, dict) and "card_ref" in m:
                rt.append_context_tail(gid, node, m["card_ref"])
        return _ok(req)

    backend.on("coder", coder_agent)

    return {
        "discovery": discovery,
        "coder1": coders[0],
        "coder2": coders[1],
        "coder3": coders[2],
        "coder_template": coder_tpl,
        "discovery_template": disc_tpl,
    }


if __name__ == "__main__":
    unittest.main(verbosity=2)
