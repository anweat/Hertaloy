"""Harness 探针 P1–P7 —— 同一把尺子量所有 backend

用法：为每个候选 backend 派生一个 TestCase，实现 `make_backend()` 与
`fake(**kw)`（把探针意图翻译成该 backend 能理解的驱动方式），其余全部复用。

判据来源：HARNESS_EVALUATION.md §2（三档：★必控 / ◇宜控 / ○只需观测）
  P1 ★A2  传入人造历史能否续跑
  P2 ★A3  超长上下文是否擅自压缩
  P3 ◇B1  工具集是否恰好是给定那个
  P4 ○B6  内部 tool 拦不住时，是否至少能观测
  P5 ◇C1  中途取消，副作用是否如实上报
  P6 ★D1  完全不配会话存储能否运行
  P7 —    同一 request 连跑两次是否等价（无状态）

★ 项失败 ⇒ 淘汰。◇ 失败 ⇒ 降级但可用。○ 失败 ⇒ 运行不可解释。

运行：python -m unittest test_probes -v
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest

from nodeflow_v4 import (
    ExecutionLimits,
    ExecutionRequest,
    InvocationContext,
    OutputContract,
    WorkspaceScope,
)
from nodeflow_adapters import SubprocessBackend

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE_DRIVER = os.path.join(HERE, "drivers", "fake_driver.mjs")


# ---------------------------------------------------------------------------
# 探针基类
# ---------------------------------------------------------------------------


class ProbeSuite:
    """混入。子类实现 make_backend / fake，即可跑完整 7 条。"""

    def make_backend(self):
        raise NotImplementedError

    def fake(self, **kw) -> dict:
        """把探针意图翻译成该 backend 的驱动方式。

        真实 backend 通常返回 {} —— 行为由真实模型决定，断言相应放宽。
        """
        raise NotImplementedError

    # ---- 工具 -------------------------------------------------------------

    def request(self, *, messages=(), tools=(), ports=("out",), system="SYS",
                budget=None, **fake) -> ExecutionRequest:
        spec = {"spec_id": "probe", "model": "probe-model",
                "systemPrompt": system, "tools": list(tools)}
        spec.update(self.fake(**fake))
        return ExecutionRequest(
            execution_id=f"probe-{next(_ids)}",
            agent_spec=spec,
            context=InvocationContext(messages=tuple(messages)),
            origin=("probe-gi", "probe-node"),
            workspace=WorkspaceScope(root=HERE),
            output_contract=OutputContract(allowed_emit_ports=tuple(ports)),
            limits=ExecutionLimits(token_budget=budget),
        )

    # ---- P1 ★A2 -----------------------------------------------------------

    def test_P1_accepts_foreign_history(self):
        """★A2：传入一段**非该 harness 产生的**历史，能否正常续跑。

        这是"自维护会话历史"的前提。做不到 ⇒ 淘汰。
        """
        history = [
            {"role": "user", "content": "之前发生过的第一轮"},
            {"role": "assistant", "content": "之前的回答"},
            {"role": "user", "content": "接着这个上下文继续"},
        ]
        be = self.make_backend()
        res = be.run(self.request(messages=history, echoContext=True,
                                  emit=[{"port": "out", "payload": {"ok": True}}]))
        self.assertEqual(res.termination, "DONE")
        echoed = res.diagnostics.get("received_context")
        if echoed is not None:                       # 假 driver 能自证
            self.assertEqual(echoed["messages"], history)

    # ---- P2 ★A3 -----------------------------------------------------------

    #: P2 构造的上下文规模。真实 backend 调小以免烧钱与撞供应商上限。
    probe_context_chars = 20_000
    probe_context_turns = 20

    def test_P2_no_unauthorized_compaction(self):
        """★A3：超长上下文，backend 不得擅自压缩。

        擅自压缩 ⇒ 命题静默失效（我们以为切分得好，模型看到的却是压过的）。
        两种合格表现：
          a) 原样发出，不压缩
          b) 因超长而**报错** —— 错误是可观测的，比静默压缩好
        不合格：静默压缩后照常返回。
        """
        huge = [
            {"role": "user", "content": "x" * self.probe_context_chars}
            for _ in range(self.probe_context_turns)
        ]
        be = self.make_backend()
        res = be.run(self.request(messages=huge,
                                  emit=[{"port": "out", "payload": {}}]))
        if res.usage.compactions:
            self.fail(
                f"backend 擅自压缩了上下文（compactions={res.usage.compactions}）；"
                f"若不可关闭，该 backend 只能降级使用"
            )
        if res.termination == "FAILED":
            # 供应商侧因长度拒绝 —— 这是合格表现 b
            self.assertIn(
                "error", res.diagnostics,
                "FAILED 但没有可观测的错误信息，无法判断是否静默压缩",
            )

    def test_P2b_compaction_is_reported_when_it_happens(self):
        """○A4：压缩若真的发生，必须可观测——否则我们连降级都判断不了。"""
        be = self.make_backend()
        res = be.run(self.request(compactions=2,
                                  emit=[{"port": "out", "payload": {}}]))
        if not self.supports_forced_compaction:
            self.skipTest("该 backend 无法被强制压缩，此项由 P2 覆盖")
        self.assertEqual(res.usage.compactions, 2)

    # ---- P3 ◇B1 -----------------------------------------------------------

    def test_P3_tool_set_is_exactly_what_we_gave(self):
        """◇B1：暴露给模型的工具集应恰好等于 agent_spec.tools。

        做不到 ⇒ 退到 B1′（至少能观测实际可用工具）。
        """
        tools = [{"name": "emit"}, {"name": "read_artifact"}]
        be = self.make_backend()
        res = be.run(self.request(tools=tools, echoContext=True,
                                  emit=[{"port": "out", "payload": {}}]))
        received = res.diagnostics.get("received_tools")
        if received is None:
            self.skipTest("该 backend 不回报工具集；见 P4 的观测降级")
        self.assertEqual([t["name"] for t in received], ["emit", "read_artifact"])

    # ---- P4 ○B6 -----------------------------------------------------------

    def test_P4_internal_tools_are_observable_even_when_ungated(self):
        """○B6：拦不住的内部 tool 也必须能观测到，落进 RunSnapshot 供展示。

        控制不了没关系；看不见才是问题。
        """
        be = self.make_backend()
        res = be.run(self.request(
            toolCalls=[{"name": "emit", "gated": True},
                       {"name": "internal_todo", "gated": False}],
            emit=[{"port": "out", "payload": {}}],
        ))
        names = [o.get("name") for o in res.observations if o.get("kind") == "tool_call"]
        if not names:
            self.skipTest("该 backend 未产生工具调用；真实模型下需人工复核")
        self.assertIn("internal_todo", names)
        ungated = [o for o in res.observations if o.get("gated") is False]
        self.assertTrue(ungated, "拦不住的调用必须标记 gated:false，而不是隐藏")

    # ---- P5 ◇C1 -----------------------------------------------------------

    def test_P5_cancel_stops_and_reports_truthfully(self):
        """◇C1：中途取消后停止，且终止原因如实上报。

        不支持取消 ⇒ 降级为杀子进程；此时应观察到进程终止而非静默完成。
        """
        be = self.make_backend()
        if not self.supports_hang:
            self.skipTest("该 backend 无法构造可控挂起；取消需人工验证")
        req = self.request(hang=True, emit=[{"port": "out", "payload": {}}])

        def cancel_soon():
            time.sleep(0.3)
            be.cancel(req.execution_id)

        t = threading.Thread(target=cancel_soon, daemon=True)
        t.start()
        res = be.run(req)
        t.join(timeout=2)
        self.assertEqual(res.termination, "CANCELLED")

    # ---- P6 ★D1 -----------------------------------------------------------

    def test_P6_runs_without_any_session_storage(self):
        """★D1：完全不配置会话存储也要能跑。做不到 ⇒ 淘汰。"""
        be = self.make_backend()
        res = be.run(self.request(emit=[{"port": "out", "payload": {"n": 1}}]))
        self.assertEqual(res.termination, "DONE")
        self.assertEqual(res.emissions, (("out", {"n": 1}),))

    # ---- P7 无状态 --------------------------------------------------------

    def test_P7_same_request_twice_is_equivalent(self):
        """无状态：同一 request 连跑两次应等价，不得依赖上次留下的隐藏状态。"""
        be = self.make_backend()
        mk = lambda: self.request(                       # noqa: E731
            messages=[{"role": "user", "content": "同一个问题"}],
            echoContext=True, emit=[{"port": "out", "payload": {"n": 1}}],
        )
        a, b = be.run(mk()), be.run(mk())
        self.assertEqual(a.emissions, b.emissions)
        self.assertEqual(a.termination, b.termination)
        if a.diagnostics.get("received_context") is not None:
            self.assertEqual(
                a.diagnostics["received_context"], b.diagnostics["received_context"]
            )


def _counter():
    n = 0
    while True:
        n += 1
        yield n


_ids = _counter()


# ---------------------------------------------------------------------------
# 候选：假 driver（验证适配层本身）
# ---------------------------------------------------------------------------


@unittest.skipUnless(os.path.exists(FAKE_DRIVER), "fake driver 缺失")
class TestFakeDriver(ProbeSuite, unittest.TestCase):
    """不是候选 backend —— 用来证明**探针与适配层本身**是可执行的。"""

    supports_forced_compaction = True
    supports_hang = True

    def setUp(self):
        self._backends = []

    def tearDown(self):
        for be in self._backends:
            be.close()

    def make_backend(self):
        be = SubprocessBackend([_node(), FAKE_DRIVER], cwd=HERE)
        self._backends.append(be)
        return be

    def fake(self, **kw):
        return {"fake": kw} if kw else {}


def _node() -> str:
    return os.environ.get("NODE_BIN", "node")


# ---------------------------------------------------------------------------
# 候选：OpenAI 兼容端点（DeepSeek 等）—— 对照组
# ---------------------------------------------------------------------------


OPENAI_DRIVER = os.path.join(HERE, "drivers", "openai_compat_driver.mjs")
LLM_CONFIG = os.environ.get(
    "NODEFLOW_LLM_CONFIG", os.path.join(HERE, "config", "llm.local.json")
)


def _llm_configured() -> bool:
    if os.environ.get("NODEFLOW_LLM_API_KEY") and os.environ.get("NODEFLOW_LLM_BASE_URL"):
        return True
    return os.path.exists(LLM_CONFIG)


@unittest.skipUnless(
    os.path.exists(OPENAI_DRIVER) and _llm_configured(),
    f"未配置 LLM（{LLM_CONFIG} 不存在，且未设 NODEFLOW_LLM_* 环境变量）",
)
class TestOpenAICompat(ProbeSuite, unittest.TestCase):
    """对照组：我们自己实现的最小 backend。

    四条必控判据天然满足，因此它应当 **7/7 全过**。
    若某条在这里都过不了，说明是探针本身写错了，不是 backend 的问题。
    """

    supports_forced_compaction = False   # 我们永不压缩，A3 由 P2 直接覆盖
    supports_hang = True                 # driver 支持不打 API 的可控挂起
    probe_context_chars = 4_000          # 真实端点：~20k tokens，够触发压缩又不烧钱
    probe_context_turns = 10

    def setUp(self):
        self._backends = []

    def tearDown(self):
        for be in self._backends:
            be.close()

    def make_backend(self):
        be = SubprocessBackend([_node(), OPENAI_DRIVER], cwd=HERE)
        self._backends.append(be)
        return be

    def fake(self, **kw):
        """真实模型不受剧本控制：只翻译 hang，其余意图靠提示词表达。"""
        spec = {}
        if kw.get("hang"):
            spec["probe_hang"] = True
        return spec

    # 真实模型需要被告知该干什么，覆盖两条依赖具体输出的探针
    def request(self, *, messages=(), **kw):
        if not messages:
            messages = [{"role": "user",
                         "content": "调用 emit 工具，port 用 out，payload 填 {\"n\": 1}。"}]
        return super().request(messages=messages, **kw)

    def test_P2_no_unauthorized_compaction(self):
        """★A3：真实端点上，超长上下文不得被 driver 擅自压缩。

        注意这验证的是 **driver 不压缩**；供应商侧若有截断，会表现为 API 报错
        而非静默压缩 —— 那是可观测的，符合判据。
        """
        super().test_P2_no_unauthorized_compaction()


# ---------------------------------------------------------------------------
# 候选：pi —— 待 driver 落地
# ---------------------------------------------------------------------------


PI_DRIVER = os.path.join(HERE, "drivers", "pi_driver.mjs")


@unittest.skipUnless(
    os.path.exists(PI_DRIVER) and os.environ.get("PROBE_PI") == "1",
    "pi driver 未就绪或未设 PROBE_PI=1",
)
class TestPi(ProbeSuite, unittest.TestCase):
    supports_forced_compaction = False
    supports_hang = False

    def setUp(self):
        self._backends = []

    def tearDown(self):
        for be in self._backends:
            be.close()

    def make_backend(self):
        be = SubprocessBackend([_node(), PI_DRIVER], cwd=HERE)
        self._backends.append(be)
        return be

    def fake(self, **kw):
        # 真实 backend：行为由模型决定，探针只提供意图不提供剧本
        return {}


# TODO: TestClaudeAgentSDK / TestCodex —— 同一 ProbeSuite，换 driver 即可


if __name__ == "__main__":
    unittest.main(verbosity=2)
