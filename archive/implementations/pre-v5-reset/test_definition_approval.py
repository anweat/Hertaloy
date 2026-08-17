"""Phase 2 —— 定义层版本化 / 提案审批 / 控制面工具层

对应目标：
  - GraphTemplate 是 ObjectVersion：register=@1，publish=@2…，旧 ref 隔离
  - 提案只落版本不注册；审批 = 校验 + 发布 + approved 事实
  - proposer/actor 只信可信边界注入；payload 不能自封身份
  - ControlPlane.dispatch 一条链路跑通：提案→审批→实例化→跑通

运行：python -m unittest test_definition_approval -v
"""

from __future__ import annotations

import unittest

from nodeflow_control import ControlPlane, TOOLS
from nodeflow_v4 import (
    AuthorizationError, ExecutionResult, InvariantError,
    MockExecutionBackend, Runtime,
)


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class DefinitionApprovalTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}))
        self.rt.register_handler("h1", lambda p, c: {
            "out": {"handler": "v1", "payload": p}})
        self.rt.register_handler("h2", lambda p, c: {
            "out": {"handler": "v2", "payload": p}})

    def _spec(self, handler):
        return {
            "nodes": {
                "start": {"kind": "start", "emit": "out",
                          "endpoints": {"io": {}, "out": {}}},
                "plain": {"kind": "plain", "handler": handler,
                          "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "start.out", "to": "plain.io"},
                      {"id": "e2", "from": "plain.out", "to": "sink.io"}],
        }


class TestTemplateVersions(DefinitionApprovalTestCase):

    def test_T1_register_then_publish_keeps_old_refs_isolated(self):
        """v1 与 v2 都是精确 ref；旧实例用旧定义，新实例用新定义。"""
        v1 = self.rt.register_graph_template("flow", self._spec("h1"))
        self.assertEqual(v1, "flow@1")
        self.assertEqual(len(self.rt.graph_template_versions("flow")), 1)

        v2 = self.rt.publish_graph_template("flow", self._spec("h2"))
        self.assertEqual(v2, "flow@2")
        self.assertEqual([ov.body["template_ref"]
                          for ov in self.rt.graph_template_versions("flow")],
                         ["flow@1", "flow@2"])

        job1 = self.rt.instantiate(v1, owner="service:job")
        job2 = self.rt.instantiate(v2, owner="service:job")
        self.rt.send((job1, "start", "io"), {"n": 1})
        self.rt.send((job2, "start", "io"), {"n": 2})
        self.rt.drain(job1, job2)

        self.assertEqual(self.rt.node_persistent_state(job1, "sink")["last"],
                         {"handler": "v1", "payload": {"n": 1}})
        self.assertEqual(self.rt.node_persistent_state(job2, "sink")["last"],
                         {"handler": "v2", "payload": {"n": 2}})

    def test_T2_identical_republish_is_idempotent(self):
        """内容寻址：重复发布同内容不产生新版本（V3 在定义层同样成立）。"""
        v1 = self.rt.register_graph_template("flow", self._spec("h1"))
        again = self.rt.publish_graph_template("flow", self._spec("h1"))
        self.assertEqual(again, v1)
        self.assertEqual(len(self.rt.graph_template_versions("flow")), 1)


class TestProposalApproval(DefinitionApprovalTestCase):

    def test_T3_invalid_proposal_is_rejected_at_approval_not_at_propose(self):
        """提案本身只是记录；审批时做全引用校验并拒绝非法定义。"""
        ref = self.rt.propose_graph_template(
            "p-bad", template_id="bad-flow",
            spec={"nodes": {"x": {"kind": "plain", "handler": "ghost",
                                  "endpoints": {"io": {}}}},
                  "edges": []},
            proposer="agent:tool",
        )
        self.assertTrue(ref.endswith("@1"))
        with self.assertRaises(InvariantError):
            self.rt.approve_graph_template("p-bad", actor="human:alice")
        # 拒绝不留 approved 事实，提案仍在 pending，且模板未注册
        self.assertEqual(self.rt.graph_template_proposal("p-bad").body["status"],
                         "pending")
        self.assertNotIn("bad-flow@1", self.rt._templates)

    def test_T4_required_approvers_are_enforced(self):
        self.rt.propose_graph_template(
            "p-gated", template_id="gated-flow", spec=self._spec("h1"),
            proposer="agent:tool", required_approvers=["human:alice"],
        )
        with self.assertRaises(AuthorizationError):
            self.rt.approve_graph_template("p-gated", actor="agent:bob")

        ref = self.rt.approve_graph_template("p-gated", actor="human:alice")
        self.assertEqual(ref, "gated-flow@1")
        approved = self.rt.graph_template_proposal("p-gated")
        self.assertEqual(approved.body["status"], "approved")
        self.assertEqual(approved.body["approver"], "human:alice")
        self.assertEqual(approved.body["template_ref"], ref)

    def test_T5_pending_proposal_cannot_be_duplicated(self):
        self.rt.propose_graph_template(
            "p-dup", template_id="dup-flow", spec=self._spec("h1"),
            proposer="agent:tool")
        with self.assertRaises(InvariantError):
            self.rt.propose_graph_template(
                "p-dup", template_id="dup-flow", spec=self._spec("h2"),
                proposer="agent:tool")


class TestControlPlane(DefinitionApprovalTestCase):

    def test_T6_full_chain_through_dispatch(self):
        """提案→审批→实例化→send→drain→query 全部经单一 dispatch 入口。"""
        cp = ControlPlane(self.rt)

        # payload 里夹带的身份必须被忽略：proposer 只取注入的 actor
        proposal_ref = cp.dispatch("propose_graph_template", {
            "proposal_id": "p-cp",
            "template_id": "cp-flow",
            "spec": self._spec("h1"),
            "proposer": "human:mallory",       # 试图自封
        }, actor="agent:tool")
        proposal = self.rt.graph_template_proposal("p-cp")
        self.assertEqual(proposal.body["proposer"], "agent:tool")

        ref = cp.dispatch("approve_graph_template", {"proposal_id": "p-cp"},
                          actor="human:alice")
        gid = cp.dispatch("instantiate", {
            "template_ref": ref, "owner": "service:job",
            "controllers": ["human:alice"]}, actor="human:alice")
        cp.dispatch("send", {"target": [gid, "start", "io"],
                             "payload": {"n": 7}}, actor="system:core")
        cp.dispatch("drain", {"gids": [gid]}, actor="system:core")

        state = cp.dispatch("query_graph", {"gid": gid}, actor="system:core")
        self.assertEqual(state["status"], "OPEN")
        self.assertEqual(state["nodes"]["sink"]["last"],
                         {"handler": "v1", "payload": {"n": 7}})

        versions = cp.dispatch("query_template_versions",
                               {"template_id": "cp-flow"},
                               actor="system:core")
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions[0]["ref"], "cp-flow@1")

    def test_T7_control_dispatch_respects_instance_controllers(self):
        cp = ControlPlane(self.rt)
        gid = cp.dispatch("instantiate", {
            "template_ref": self.rt.register_graph_template(
                "ctl-flow", self._spec("h1")),
            "owner": "service:job",
            "controllers": ["human:alice"]}, actor="human:alice")
        with self.assertRaises(AuthorizationError):
            cp.dispatch("control", {"gid": gid, "action": "close"},
                        actor="agent:rogue")
        self.assertEqual(self.rt.graph_status(gid), "OPEN")
        cp.dispatch("control", {"gid": gid, "action": "close"},
                    actor="human:alice")
        self.assertEqual(self.rt.graph_status(gid), "CLOSED")

    def test_T8_tool_schemas_are_mcp_shaped(self):
        """每个工具都有可被 MCP Tool 直接使用的 inputSchema。"""
        self.assertIn("register_graph_template", TOOLS)
        for name, tool in TOOLS.items():
            self.assertIn("description", tool)
            self.assertIn("inputSchema", tool)
            self.assertEqual(tool["inputSchema"].get("type"), "object")


if __name__ == "__main__":
    unittest.main(verbosity=2)
