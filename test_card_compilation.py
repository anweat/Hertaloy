"""卡片编译规则 —— 上下文质量的决定处

编译规则**属内核，用户不可改**：它决定每次 agent 调用看到什么，
而"精确构造每次调用的上下文"就是编排面存在的理由（FOUNDATION §1）。

布局按缓存稳定性排列（INTERFACES §1.2）：

    ┌─ 稳定前缀（参与缓存，同一 spec 跨调用逐字节相同）──────┐
    │ [1] tools 全集声明                                    │
    │ [2] system:                                           │
    │      a. rules 卡全量（必须遵守）                       │
    │      b. 角色（prompt 卡 / 节点级 systemPrompt）         │
    │      c. mcp 可用列表（名称 + 摘要，不含全量 schema）     │
    │      d. skill 压缩索引（summary，不是全文）             │
    │      e. 输出契约（由 emit 端点 contract 生成，非人写）   │
    ├─ 缓存断点 ────────────────────────────────────────────┤
    │ [3] messages: head / messages / tail / transient       │
    └───────────────────────────────────────────────────────┘

★ 不变量 X：稳定前缀不得因运行期发现而改变。
    skill / 资料 → 可运行期追加（落 tail，断点之后）
    tool         → **不可**运行期新增（编译期声明全集）

运行：python -m unittest test_card_compilation -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import ExecutionResult, MockExecutionBackend, Runtime


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class CompileTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}) or {})
        self.backend.on("w", lambda req: _ok(req, emissions=(("out", {}),)))

        self.rt.register_card(kind="rules", card_id="py", version=1,
                              body={"text": "只改 src/ 下的文件。"})
        self.rt.register_card(kind="prompt", card_id="coder", version=1,
                              body={"text": "你是一名后端工程师。"})
        self.rt.register_card(kind="skill", card_id="openapi", version=1,
                              body={"summary": "生成 OpenAPI 规格",
                                    "text": "（此处是 skill 全文，很长很长）"})
        self.rt.register_card(kind="mcp", card_id="git", version=2,
                              body={"server": "git",
                                    "tools": [{"name": "git_log",
                                               "summary": "查看提交历史"},
                                              {"name": "git_diff",
                                               "summary": "查看改动"}]})

    def _job(self, *, cards=None, endpoints=None, node_prompt=None):
        self.rt.compile_agent_spec(
            "w", model="m",
            cards=cards if cards is not None else [
                ("rules", "py", 1), ("prompt", "coder", 1),
                ("skill", "openapi", 1), ("mcp", "git", 2)],
        )
        node = {"kind": "agent", "spec": "w",
                "endpoints": endpoints or {"io": {}, "out": {}}}
        if node_prompt:
            node["systemPrompt"] = node_prompt
        tpl = self.rt.register_graph_template(f"t{len(self.rt._templates)}", {
            "nodes": {"w": node,
                      "sink": {"kind": "plain", "handler": "record",
                               "endpoints": {"io": {}}}},
            "edges": [{"id": "e1", "from": "w.out", "to": "sink.io"}],
        })
        return self.rt.instantiate(tpl, owner="service:job")

    def _spec_after_run(self, job, payload=None):
        self.rt.send((job, "w", "io"), payload or {"task": "t"})
        self.rt.drain(job)
        return self.backend.last_request_for("w").agent_spec


# ---------------------------------------------------------------------------
# 布局
# ---------------------------------------------------------------------------


class TestPromptLayout(CompileTestCase):

    def test_L1_sections_appear_in_the_prescribed_order(self):
        """五段的**顺序**是编译规则的一部分，不是随意排列。"""
        spec = self._spec_after_run(self._job())
        p = spec["systemPrompt"]
        idx = [p.index(h) for h in
               ("# 规则（必须遵守）", "# 角色", "# 可用 MCP 工具",
                "# 可用 skill", "# 输出契约")]
        self.assertEqual(idx, sorted(idx), f"段落顺序不对：\n{p}")

    def test_L2_rules_go_in_full(self):
        spec = self._spec_after_run(self._job())
        self.assertIn("只改 src/ 下的文件。", spec["systemPrompt"])

    def test_L3_skill_index_carries_summary_not_full_text(self):
        """★ skill 进的是**压缩索引**，全文要到运行期才按需追加。

        这是命题的直接体现：不把用不上的东西塞进每一次调用。
        """
        spec = self._spec_after_run(self._job())
        self.assertIn("生成 OpenAPI 规格", spec["systemPrompt"])
        self.assertNotIn("此处是 skill 全文", spec["systemPrompt"])

    def test_L4_mcp_lists_names_and_summaries_only(self):
        """mcp 只列名称与摘要，不塞全量 schema。"""
        spec = self._spec_after_run(self._job())
        self.assertIn("git_log：查看提交历史", spec["systemPrompt"])
        self.assertIn("git_diff", spec["systemPrompt"])

    def test_L5_node_prompt_is_treated_as_an_inline_prompt_card(self):
        """节点级 systemPrompt 并入"角色"段，而非绕过编译规则。"""
        spec = self._spec_after_run(self._job(node_prompt="额外的节点级约束。"))
        p = spec["systemPrompt"]
        self.assertIn("额外的节点级约束。", p)
        self.assertLess(p.index("# 角色"), p.index("额外的节点级约束。"))
        self.assertLess(p.index("额外的节点级约束。"), p.index("# 输出契约"))

    def test_L6_output_contract_is_generated_from_endpoints(self):
        """★ 输出契约由拓扑生成，不是人写的 —— 改一条边，prompt 自动跟着变。"""
        self.rt.register_contract("Result", 1, {
            "type": "object",
            "properties": {"summary": {"type": "string"}, "files": {"type": "array"}},
            "required": ["summary"],
        })
        # 端点声明了契约，输出就必须合规 —— 校验器不会放水
        self.backend.on("w", lambda req: _ok(
            req, emissions=(("out", {"summary": "done"}),)))
        job = self._job(endpoints={
            "io": {}, "out": {"emit": {"PUSH": {"contract": "Result@1"}}}})
        p = self._spec_after_run(job)["systemPrompt"]
        self.assertIn("# 输出契约", p)
        self.assertIn("Result@1", p)
        self.assertIn("summary", p)
        self.assertIn("必需", p)


# ---------------------------------------------------------------------------
# 不变量 X
# ---------------------------------------------------------------------------


class TestPrefixStability(CompileTestCase):

    def test_X1_runtime_discovered_skill_does_not_touch_the_prefix(self):
        """★★ 不变量 X：运行期追加 skill 不得改变稳定前缀。

        追加的东西落在 context.tail（缓存断点之后），前缀指纹必须不变。
        """
        job = self._job()
        first = self._spec_after_run(job)

        self.rt.append_context_tail(job, "w", "skill/openapi@1 全文……")
        second = self._spec_after_run(job)

        self.assertEqual(first["prefix_hash"], second["prefix_hash"],
                         "运行期发现改变了稳定前缀 —— 缓存全废")
        # 但它确实到达了模型，只是在断点之后
        self.assertIn("skill/openapi@1 全文……",
                      self.backend.last_request_for("w").context.tail)

    def test_X2_tools_are_declared_at_compile_time_in_full(self):
        """★ 工具全集编译期定型，且标记为延迟加载（运行期只启用不新增）。"""
        spec = self._spec_after_run(self._job())
        names = {t["name"] for t in spec["tools"]}
        self.assertEqual(names, {"git_log", "git_diff"})
        self.assertTrue(all(t["defer_loading"] for t in spec["tools"]))
        self.assertTrue(all(t["source"] == "mcp/git@2" for t in spec["tools"]))

    def test_X3_prefix_changes_only_when_cards_change(self):
        """卡片变了前缀才该变 —— 否则缓存失效就是无谓损失。"""
        job = self._job()
        before = self._spec_after_run(job)["prefix_hash"]
        same = self._spec_after_run(job)["prefix_hash"]
        self.assertEqual(before, same)

        # 换一张 rules 卡 → 前缀应当变
        self.rt.register_card(kind="rules", card_id="py", version=2,
                              body={"text": "改成：只改 lib/ 下的文件。"})
        job2 = self._job(cards=[("rules", "py", 2), ("prompt", "coder", 1),
                                ("skill", "openapi", 1), ("mcp", "git", 2)])
        self.assertNotEqual(before, self._spec_after_run(job2)["prefix_hash"])

    def test_X4_prefix_is_stable_across_instances_of_the_same_spec(self):
        """同一 spec 的不同实例共享前缀 —— 这是缓存能命中的前提。"""
        a = self._spec_after_run(self._job())["prefix_hash"]
        b = self._spec_after_run(self._job())["prefix_hash"]
        self.assertEqual(a, b)


class TestCompilationIsKernelOwned(CompileTestCase):

    def test_K1_card_versions_are_traceable_from_the_compiled_spec(self):
        """编译产物要能溯源到具体卡片版本。"""
        spec = self._spec_after_run(self._job())
        self.assertEqual(spec["cards"]["rules/py"], 1)
        self.assertEqual(spec["cards"]["mcp/git"], 2)
        self.assertIn("skill/openapi@1", spec["card_refs"])

    def test_K2_empty_spec_compiles_to_contract_only(self):
        """一张卡都没有时，仍应产出输出契约段 —— 那是拓扑给的，不是卡片给的。"""
        job = self._job(cards=[])
        p = self._spec_after_run(job)["systemPrompt"]
        self.assertIn("# 输出契约", p)
        self.assertNotIn("# 规则", p)


if __name__ == "__main__":
    unittest.main(verbosity=2)
