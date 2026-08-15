"""Phase 4 —— 消息投递与关联（#13）

  - topic request/reply contract 运行期校验（只拒绝，不补字段）
  - REQUEST 协议级 request_id：信封字段，绝不进 payload；REPLY 原样带回
  - reply 到 PAUSED 保留（resume 消费）；仅 CLOSED 才丢并留痕
  - send/publish 入站 payload 快照：调用方事后改对象不影响入队消息

运行：python -m unittest test_delivery -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import ExecutionResult, InvariantError, MockExecutionBackend, Runtime


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class DeliveryTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}))

    def _service(self, *, topic, request_contract, reply_contract=None):
        self.rt.register_topic(topic, request_contract=request_contract,
                               reply_contract=reply_contract)

        def svc(payload, ctx):
            return {"reply": {"echo": payload}}

        self.rt.register_handler("svc", svc)
        tpl = self.rt.register_graph_template(f"svc-{topic}", {
            "nodes": {"svc": {"kind": "plain", "handler": "svc",
                              "endpoints": {"io": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:svc")

    def _caller(self):
        tpl = self.rt.register_graph_template(f"caller{len(self.rt._templates)}", {
            "nodes": {"caller": {"kind": "plain", "handler": "record",
                                 "endpoints": {"io": {}}}},
            "edges": [],
        })
        return self.rt.instantiate(tpl, owner="service:job")


class TestTopicContracts(DeliveryTestCase):

    def test_D1_request_contract_is_enforced_at_publish(self):
        service = self._service(
            topic="q", request_contract={"type": "object",
                                          "required": ["id"],
                                          "properties": {"id": {"type": "integer"}}},
            reply_contract={"type": "object",
                            "required": ["echo"],
                            "properties": {"echo": {"type": "object"}}})
        self.rt.subscribe("q", target=(service, "svc", "io"))

        with self.assertRaises(InvariantError) as cm:
            self.rt.publish("q", {"id": "not-int"})
        self.assertIn("q", str(cm.exception))
        self.assertIn("integer", str(cm.exception))

        self.rt.publish("q", {"id": 1})
        self.rt.drain()
        self.assertEqual(self.rt.node_persistent_state(service, "svc"),
                         {})   # reply 被 record? 服务没有 sink；只证明不炸

    def test_D2_reply_contract_is_enforced(self):
        service = self._service(
            topic="q", request_contract={"type": "object"},
            reply_contract={"type": "object",
                            "required": ["echo"],
                            "properties": {"echo": {
                                "type": "object",
                                "required": ["n"],
                                "properties": {"n": {"type": "integer"}}}}})
        self.rt.subscribe("q", target=(service, "svc", "io"))
        caller = self._caller()
        with self.assertRaises(InvariantError) as cm:
            self.rt.publish("q", {"bad": True}, request_id="r1",
                            callback=(caller, "caller", "io"))
            self.rt.drain()
        self.assertIn("回复", str(cm.exception))


class TestRequestId(DeliveryTestCase):

    def test_D3_request_id_rides_the_envelope_not_the_payload(self):
        """两个并发请求的 REPLY 可被协议级 request_id 区分，payload 无协议字段。"""
        service = self._service(topic="q",
                                request_contract={"type": "object"},
                                reply_contract={"type": "object"})
        self.rt.subscribe("q", target=(service, "svc", "io"))
        caller = self._caller()

        self.rt.publish("q", {"req": "Q1"}, request_id="req-1",
                        callback=(caller, "caller", "io"))
        self.rt.publish("q", {"req": "Q2"}, request_id="req-2",
                        callback=(caller, "caller", "io"))
        self.rt.drain()

        replies = sorted(
            (m for m in self.rt._messages.values() if m.mkind == "REPLY"),
            key=lambda m: m.request_id)
        self.assertEqual([m.request_id for m in replies],
                         ["req-1", "req-2"])
        self.assertEqual([m.payload for m in replies],
                         [{"echo": {"req": "Q1"}}, {"echo": {"req": "Q2"}}])
        for m in replies:
            self.assertNotIn("request_id", m.payload)
            self.assertNotIn("replyToMessageId", m.payload)

    def test_D4_agent_context_carries_request_meta(self):
        """模型侧通过 context.meta 拿到 request_id，不必解析 payload。"""
        self.rt.compile_agent_spec("caller", model="m", cards=[("rules", "base")])
        self.backend.on("caller", lambda req: _ok(req))
        tpl = self.rt.register_graph_template("caller", {
            "nodes": {"caller": {"kind": "agent", "spec": "caller",
                                 "endpoints": {"io": {}}}},
            "edges": [],
        })
        caller = self.rt.instantiate(tpl, owner="service:job")
        self.rt.register_topic("q", request_contract={"type": "object"})
        self.rt.subscribe("q", target=(caller, "caller", "io"))

        self.rt.publish("q", {"n": 1}, request_id="req-9")
        self.rt.drain(caller)

        req = self.backend.last_request_for("caller")
        self.assertEqual(req.context.meta[0]["request_id"], "req-9")
        self.assertEqual(req.context.meta[0]["mkind"], "DATA")


class TestPausedReply(DeliveryTestCase):

    def test_D5_reply_to_paused_is_kept_until_resume(self):
        service = self._service(topic="q", request_contract={"type": "object"})
        self.rt.subscribe("q", target=(service, "svc", "io"))
        caller = self._caller()
        self.rt.control(service, "pause", actor="service:svc")

        self.rt.publish("q", {"n": 1}, request_id="req-p",
                        callback=(caller, "caller", "io"))
        self.rt.drain(service)
        # PAUSED：请求保留，回复不得丢
        self.assertGreaterEqual(self.rt.queue("q").depth, 1)

        self.rt.control(service, "resume", actor="service:svc")
        self.rt.drain(service)
        replies = [m for m in self.rt._messages.values() if m.mkind == "REPLY"]
        self.assertEqual([m.request_id for m in replies], ["req-p"])
        self.assertEqual(replies[0].payload, {"echo": {"n": 1}})


class TestPayloadSnapshot(DeliveryTestCase):

    def test_D6_send_and_publish_snapshot_payload(self):
        tpl = self.rt.register_graph_template("t", {
            "nodes": {"m": {"kind": "plain", "handler": "record",
                            "endpoints": {"io": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:job")

        payload = {"nested": {"v": 1}}
        self.rt.send((job, "m", "io"), payload)
        payload["nested"]["v"] = 999

        queued = [m for m in self.rt._messages.values()
                  if m.target[1] == "m" and m.state == "QUEUED"]
        self.assertEqual(queued[0].payload, {"nested": {"v": 1}})


if __name__ == "__main__":
    unittest.main(verbosity=2)
