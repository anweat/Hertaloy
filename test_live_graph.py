"""真实模型跑通一次图执行 —— 验适配层设计，不验模型顺从度

与 `test_foundation_v4.py`（mock backend，验编排语义）和 `test_probes.py`
（单次调用，验 backend 能力）的分工：本文件把两者接在一起，回答一个问题——

    **`ExecutionRequest / ExecutionResult` 这条接口，在真实模型下是否够用？**

断言原则同探针：落在**编排面的不变量**上（版本谁分配、上下文怎么编译、
提交是否发生、压缩有没有），不落在**模型是否照做**上。

需要 config/llm.local.json 或 NODEFLOW_LLM_* 环境变量。
运行：python -m unittest test_live_graph -v
"""

from __future__ import annotations

import os
import unittest

from nodeflow_adapters import SubprocessBackend
from nodeflow_v4 import Runtime

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "drivers", "openai_compat_driver.mjs")
LLM_CONFIG = os.environ.get(
    "NODEFLOW_LLM_CONFIG", os.path.join(HERE, "config", "llm.local.json")
)


def _configured() -> bool:
    if os.environ.get("NODEFLOW_LLM_API_KEY") and os.environ.get("NODEFLOW_LLM_BASE_URL"):
        return True
    return os.path.exists(LLM_CONFIG)


SYSTEM = (
    "你是流水线中的一个节点。完成任务后**必须**调用 emit 工具输出结果，"
    "port 只能用工具 schema 里列出的枚举值。不要输出多余解释。"
)


@unittest.skipUnless(os.path.exists(DRIVER) and _configured(), "未配置 LLM")
class TestLiveGraph(unittest.TestCase):

    def setUp(self):
        self.rt = Runtime()
        self.backend = SubprocessBackend([_node(), DRIVER], cwd=HERE)
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1,
                              body={"text": "保持简洁。"})
        self.rt.register_handler(
            "record", lambda p, c: c["state"].update({"last": p}) or {}
        )

    def tearDown(self):
        self.backend.close()

    # ---- 单节点：接口是否够用 -------------------------------------------

    def test_L1_single_agent_node_end_to_end(self):
        """帧 3：真实模型跑一个 agent 节点，编排面的不变量全部成立。"""
        self.rt.compile_agent_spec("worker", model="live",
                                   cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("live-flow", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "worker",
                           "systemPrompt": SYSTEM,
                           "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
        })
        job = self.rt.instantiate(tpl, owner="service:live",
                                  params={"context_head": ["doc/spec@1"]})

        self.rt.send((job, "worker", "io"),
                     {"task": '把 "hello" 变成大写，用 emit 输出，port=out'})
        self.rt.drain(job)

        # 1) 提交发生了，且执行记录走完三段
        self.assertGreater(self.rt.commit_seq(job), 0)
        recs = self.rt.node_executions(job, "worker")
        self.assertTrue(recs)
        self.assertIn(recs[-1].status, ("APPLIED", "FAILED"))

        # 2) 上下文是我们编译的那份（head 原样到达）
        req = self.backend.last_request_for("worker")
        self.assertEqual(req.context.head, ("doc/spec@1",))
        self.assertEqual(req.origin, (job, "worker"))

        # 3) ★A3：没有发生压缩
        self.assertEqual(self.rt.usage(job).compactions, 0)
        self.assertEqual(self.rt.context_alerts(job), [])

        # 4) RunSnapshot 是 kind="run" 的 ObjectVersion，带 provenance
        snaps = self.rt.store.history(f"run/{job}")
        self.assertTrue(snaps)
        self.assertTrue(all(s.kind == "run" for s in snaps))
        self.assertEqual(snaps[-1].provenance.graph_instance_id, job)

    def test_L2_emissions_land_only_on_declared_ports(self):
        """★第一不变量：真实模型的输出只会落在已声明端口上。

        两道防线：driver 拒绝未声明 port（理由回传模型重试），
        编排面 `apply_execution` 再校验一次。任一生效即可。
        """
        self.rt.compile_agent_spec("router", model="live",
                                   cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("router-flow", {
            "nodes": {
                "router": {"kind": "agent", "spec": "router",
                           "systemPrompt": SYSTEM,
                           "endpoints": {"io": {}, "ok": {}, "bad": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [
                {"id": "e1", "from": "router.ok", "to": "sink.io"},
                {"id": "e2", "from": "router.bad", "to": "sink.io"},
            ],
        })
        job = self.rt.instantiate(tpl, owner="service:live")
        self.rt.send((job, "router", "io"),
                     {"task": '判断 2+2 是否等于 4。是则 port 用 ok，否则用 bad。'})
        self.rt.drain(job)

        req = self.backend.last_request_for("router")
        allowed = set(req.output_contract.allowed_emit_ports)
        for _kind, body in [(s.kind, s.body) for s in
                            self.rt.store.history(f"run/{job}")]:
            for edge in body.get("edges_traversed", []):
                src_port = edge.split("->")[0].split(".")[-1] if "->" in edge else ""
                if src_port:
                    self.assertIn(src_port, allowed | {"io"})

    # ---- 循环：命题本身 --------------------------------------------------

    def test_L3_rework_epoch_context_is_trimmed_under_a_real_model(self):
        """★★ 帧 13 —— 命题本身，在真实模型下验一次。

        epoch 2 的上下文必须只含 head + 失败切片，
        **不含 epoch 1 的原始任务，也不含 epoch 1 的模型输出**。
        """
        self.rt.compile_agent_spec("coder", model="live",
                                   cards=[("rules", "base")])

        def gate(payloads, ctx):
            epoch = ctx["state"].get("epoch", 0) + 1
            ctx["state"]["epoch"] = epoch
            ann = {"object_refs": {"plan": "plan@1"}, "fields": {"epoch": epoch}}
            if epoch == 1:
                return {"annotate": ann, "emit": {"again": {
                    "failed": ["t_07"],
                    "hint": '只修复 t_07，用 emit 输出，port=out',
                }}}
            return {"annotate": ann, "emit": {"done": {"ok": True}}}

        self.rt.register_handler("gate", gate)
        self.rt.register_policy("gate-policy", {"readiness": "ANY", "output": {}})

        tpl = self.rt.register_graph_template("live-rework", {
            "nodes": {
                "coder": {"kind": "agent", "spec": "coder",
                          "systemPrompt": SYSTEM,
                          "endpoints": {"io": {}, "out": {}}},
                "gate": {"kind": "strategy", "policy": "gate-policy",
                         "handler": "gate",
                         "endpoints": {"io": {}, "again": {}, "done": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [
                {"id": "e1", "from": "coder.out", "to": "gate.io"},
                {"id": "e2", "from": "gate.again", "to": "coder.io"},
                {"id": "e3", "from": "gate.done", "to": "sink.io"},
            ],
        })
        job = self.rt.instantiate(tpl, owner="service:live",
                                  params={"context_head": ["repo/survey@1"]})

        marker = "ORIGINAL-TASK-9931"
        self.rt.send((job, "coder", "io"),
                     {"task": f'任务编号 {marker}：把 "abc" 变大写，用 emit 输出，port=out'})
        self.rt.drain(job)

        reqs = self.backend.requests_for("coder")
        if len(reqs) < 2:
            # epoch 1 模型没调 emit ⇒ gate 收不到输入 ⇒ 循环起不来。
            # 这是**模型顺从度**问题，不是编排缺陷 —— 按既定规矩跳过而非失败。
            self.skipTest(f"模型未在 epoch 1 输出，循环未触发（仅 {len(reqs)} 次调用）")
        e1, e2 = reqs[0], reqs[1]

        # head 跨 epoch 不变
        self.assertEqual(e1.context.head, e2.context.head)
        self.assertEqual(e2.context.head, ("repo/survey@1",))

        # ★ epoch 2 只见失败切片，不含 epoch 1 的原始任务
        blob2 = str(e2.context.messages)
        self.assertNotIn(marker, blob2, "epoch 2 的上下文里混进了 epoch 1 的原始任务")
        self.assertIn("t_07", blob2)

        # 每轮都是重建的单条，不累积
        self.assertEqual(len(e1.context.messages), 1)
        self.assertEqual(len(e2.context.messages), 1)

        # 节点状态里不藏执行历史
        self.assertNotIn("transcript",
                         self.rt.node_persistent_state(job, "coder"))

        # 两个 epoch 各留下一条 Annotation，且是 ObjectVersion
        anns = self.rt.annotations(job)
        self.assertGreaterEqual(len(anns), 1)
        self.assertEqual(anns[0].kind, "annotation")
        self.assertEqual(anns[0].provenance.graph_instance_id, job)

        # 全程无压缩
        self.assertEqual(self.rt.usage(job).compactions, 0)

    # ---- 版本权 ----------------------------------------------------------

    def test_L4_store_owns_versions_even_with_a_real_backend(self):
        """★V1：真实 backend 提交内容，版本号仍只由 ObjectStore 分配。"""
        self.rt.compile_agent_spec("writer", model="live",
                                   cards=[("rules", "base")])
        tpl = self.rt.register_graph_template("writer-flow", {
            "nodes": {"writer": {"kind": "agent", "spec": "writer",
                                 "systemPrompt": SYSTEM,
                                 "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:live")
        self.rt.send((job, "writer", "io"), {"task": "说一句话，用 emit，port=out"})
        self.rt.drain(job)

        for ov in self.rt.store.history(f"run/{job}"):
            self.assertGreaterEqual(ov.version, 1)
            self.assertTrue(ov.content_hash)
            self.assertEqual(ov.provenance.graph_instance_id, job)
        # 版本连续，由 store 分配而非 backend 声明
        versions = [ov.version for ov in self.rt.store.history(f"run/{job}")]
        self.assertEqual(versions, list(range(1, len(versions) + 1)))


def _node() -> str:
    return os.environ.get("NODE_BIN", "node")


if __name__ == "__main__":
    unittest.main(verbosity=2)
