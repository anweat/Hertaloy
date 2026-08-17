"""上下文预算：分配与降级 —— 命题的直接延伸

`F4` 已证明"超预算在调用前被处理，不丢给 harness 压缩"。本文件补上**怎么处理**：

    head       永不裁剪。它是实例化时固定的引用，动它等于换任务。
               head 自己超预算 ⇒ 图切分过粗，直接失败，不悄悄降级。
    transient  最先砍，本轮临时。
    tail       其次，运行期发现的补充资料。
    messages   最后，且**至少保留一条** —— 那是当前任务，丢光则 agent 无事可做。

裁剪与压缩同级：都是"这个节点承担的任务过大"的告警信号，不是特性。

后半部分（TestEstimatorCalibration）**用真实 API 校准估算系数**。
估算准不准只有真 backend 能回答；不测就只是猜。

运行：python -m unittest test_context_budget -v
"""

from __future__ import annotations

import os
import unittest

from nodeflow_adapters import SubprocessBackend
from nodeflow_v4 import (
    ExecutionResult,
    InvocationContext,
    InvariantError,
    MockExecutionBackend,
    Runtime,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "drivers", "openai_compat_driver.mjs")
LLM_CONFIG = os.environ.get(
    "NODEFLOW_LLM_CONFIG", os.path.join(HERE, "config", "llm.local.json")
)


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


def _configured() -> bool:
    if os.environ.get("NODEFLOW_LLM_API_KEY") and os.environ.get("NODEFLOW_LLM_BASE_URL"):
        return True
    return os.path.exists(LLM_CONFIG)


class BudgetTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("worker", model="m", cards=[("rules", "base")])
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}) or {})
        self.backend.on("worker", lambda req: _ok(req, emissions=(("out", {}),)))

    def _job(self, *, budget, head=()):
        tpl = self.rt.register_graph_template(f"b-{budget}-{len(head)}", {
            "nodes": {
                "worker": {"kind": "agent", "spec": "worker",
                           "limits": {"token_budget": budget},
                           "endpoints": {"io": {}, "out": {}}},
                "sink": {"kind": "plain", "handler": "record",
                         "endpoints": {"io": {}}},
            },
            "edges": [{"id": "e1", "from": "worker.out", "to": "sink.io"}],
        })
        return self.rt.instantiate(tpl, owner="service:job",
                                   params={"context_head": list(head)})


# ---------------------------------------------------------------------------
# 分配与降级
# ---------------------------------------------------------------------------


class TestAllocation(BudgetTestCase):

    def test_A1_fits_without_trimming_when_under_budget(self):
        job = self._job(budget=10_000)
        self.rt.send((job, "worker", "io"), {"task": "short"})
        self.rt.drain(job)
        self.assertEqual(self.rt.context_alerts(job), [])
        self.assertEqual(self.backend.last_request_for("worker").context.messages,
                         ({"task": "short"},))

    def test_A2_transient_is_dropped_first(self):
        """transient 最先砍。"""
        ctx = InvocationContext(
            head=("h",), messages=({"t": "m"},),
            tail=("tail-item",), transient=("x" * 4000,),
        )
        fitted, trims = self.rt._fit_context(ctx, 200, gid="g", node_id="n")
        self.assertEqual(fitted.transient, ())
        self.assertEqual(fitted.tail, ("tail-item",))       # 还没轮到
        self.assertEqual([t["section"] for t in trims], ["transient"])

    def test_A3_tail_is_dropped_before_messages(self):
        """tail 是补充资料，messages 是任务本身 —— 先砍 tail。"""
        ctx = InvocationContext(
            head=("h",),
            messages=({"t": "keep-me"},),
            tail=("x" * 2000, "y" * 2000),
        )
        fitted, trims = self.rt._fit_context(ctx, 100, gid="g", node_id="n")
        self.assertEqual(fitted.tail, ())
        self.assertEqual(fitted.messages, ({"t": "keep-me"},))   # 任务保住了
        self.assertTrue(all(t["section"] == "tail" for t in trims))

    def test_A4_oldest_goes_first(self):
        """同一段里砍**最旧**的：预算只够留一条时，留下的必须是最新那条。"""
        items = ("a" * 400, "b" * 400, "c" * 400)
        ctx = InvocationContext(tail=items)
        one = self.rt.estimate_text_tokens(items[0])
        fitted, trims = self.rt._fit_context(ctx, one + 5, gid="g", node_id="n")
        self.assertEqual(fitted.tail, (items[-1],))       # 只剩最新的
        self.assertEqual(len(trims), 2)

    def test_A5_last_message_is_never_dropped(self):
        """★ 当前任务不可丢光 —— 丢了 agent 就无事可做。"""
        ctx = InvocationContext(messages=({"task": "x" * 4000},))
        with self.assertRaises(InvariantError) as cm:
            self.rt._fit_context(ctx, 10, gid="g", node_id="n")
        self.assertIn("无可再裁", str(cm.exception))

    def test_A6_head_is_never_trimmed_and_oversized_head_fails_loudly(self):
        """★ head 永不裁剪；head 自己超预算 = 图切分过粗，必须显式失败。"""
        job = self._job(budget=10, head=("x" * 4000,))
        self.rt.send((job, "worker", "io"), {"task": "t"})
        with self.assertRaises(InvariantError) as cm:
            self.rt.drain(job)
        msg = str(cm.exception)
        self.assertIn("head 不可裁剪", msg)
        self.assertIn("图切分过粗", msg)
        # 关键：backend 从未被调用
        self.assertEqual(self.backend.requests_for("worker")
                         if hasattr(self.backend, "requests_for")
                         else [r for r in self.backend.seen
                               if r.agent_spec["spec_id"] == "worker"], [])


class TestTruncationIsAnAlert(BudgetTestCase):

    def test_A7_trimming_surfaces_as_an_alert(self):
        """★ 裁剪与压缩同级：都是失败信号，必须可观测。"""
        job = self._job(budget=60)
        self.rt.append_context_tail(job, "worker", "x" * 2000)
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)

        alerts = self.rt.context_alerts(job)
        kinds = [a["kind"] for a in alerts]
        self.assertIn("truncation", kinds)
        trim_alert = next(a for a in alerts if a["kind"] == "truncation")
        self.assertEqual(trim_alert["node"], "worker")
        self.assertTrue(trim_alert["trims"])
        self.assertIn("失败信号", trim_alert["reason"])

    def test_A8_trims_are_recorded_in_the_run_snapshot(self):
        """裁剪进 RunSnapshot —— 可回溯、可展示。"""
        job = self._job(budget=60)
        self.rt.append_context_tail(job, "worker", "y" * 2000)
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)

        snaps = [ov.body for ov in self.rt.store.history(f"run/{job}")]
        with_trims = [s for s in snaps if s.get("context_trims")]
        self.assertTrue(with_trims, "裁剪没有落进 RunSnapshot")

    def test_A9_backend_receives_the_trimmed_context_not_the_original(self):
        """裁剪发生在调用**前** —— backend 看到的就是裁过的。"""
        job = self._job(budget=60)
        self.rt.append_context_tail(job, "worker", "z" * 2000)
        self.rt.send((job, "worker", "io"), {"task": "t"})
        self.rt.drain(job)

        got = self.backend.last_request_for("worker").context
        self.assertEqual(got.tail, ())
        self.assertEqual(got.messages, ({"task": "t"},))


# ---------------------------------------------------------------------------
# 估算校准 —— 只有真 backend 能回答
# ---------------------------------------------------------------------------


@unittest.skipUnless(os.path.exists(DRIVER) and _configured(), "未配置 LLM")
class TestEstimatorCalibration(unittest.TestCase):
    """`estimate_tokens` 决定预算什么时候触发。系数拍脑袋定就等于没有预算。

    这里对着真实 `usage.in_tokens` 量一遍。中文与英文的 token 密度差好几倍，
    所以两种都要量。
    """

    def setUp(self):
        self.rt = Runtime()
        self.backend = SubprocessBackend([_node(), DRIVER], cwd=HERE)
        self.rt.set_backend(self.backend)

    def tearDown(self):
        self.backend.close()

    def _measure(self, text: str) -> tuple[int, int]:
        """返回 (我们的估算, 真实 in_tokens)。"""
        self.rt.register_card(kind="rules", card_id="r", version=1, body={})
        self.rt.compile_agent_spec("probe", model="live", cards=[("rules", "r")])
        tpl = self.rt.register_graph_template(f"cal-{len(text)}", {
            "nodes": {"probe": {"kind": "agent", "spec": "probe",
                                "systemPrompt": "回复 ok 即可，不要调用工具。",
                                "endpoints": {"io": {}, "out": {}}}},
            "edges": [],
        })
        job = self.rt.instantiate(tpl, owner="service:cal")
        self.rt.send((job, "probe", "io"), {"role": "user", "content": text})
        self.rt.drain(job)

        req = self.backend.last_request_for("probe")
        # 口径要一致：真实 in_tokens 含 system prompt 与工具 schema，估算也必须含
        estimated = (self.rt.estimate_tokens(req.context)
                     + self.rt.estimate_spec_tokens(req.agent_spec))
        actual = self.rt.usage(job).in_tokens
        return estimated, actual

    def test_E1_latin_estimate_is_within_a_sane_band(self):
        est, actual = self._measure("The quick brown fox jumps over the lazy dog. " * 40)
        self.assertGreater(actual, 0, "真实 token 数没拿到")
        ratio = est / actual
        print(f"\n  [拉丁] 估算 {est} / 实际 {actual} = {ratio:.2f}")
        # 宁可高估：高估 = 预算提前触发（安全）；低估 = 命题静默失效（危险）
        self.assertGreater(ratio, 0.85, f"低估 {1/ratio:.2f} 倍 —— 预算会失效")
        self.assertLess(ratio, 2.0, f"高估 {ratio:.2f} 倍 —— 会误伤")

    def test_E2_cjk_estimate_is_within_a_sane_band(self):
        """★ 主线场景是中文。按英文系数算会严重低估，预算形同虚设。"""
        est, actual = self._measure("这是一段用于校准估算系数的中文文本，反复出现。" * 40)
        self.assertGreater(actual, 0)
        ratio = est / actual
        print(f"\n  [中文] 估算 {est} / 实际 {actual} = {ratio:.2f}")
        # 宁可高估：高估 = 预算提前触发（安全）；低估 = 命题静默失效（危险）
        self.assertGreater(ratio, 0.85, f"低估 {1/ratio:.2f} 倍 —— 预算会失效")
        self.assertLess(ratio, 2.0, f"高估 {ratio:.2f} 倍 —— 会误伤")


def _node() -> str:
    return os.environ.get("NODE_BIN", "node")


if __name__ == "__main__":
    unittest.main(verbosity=2)
