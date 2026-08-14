"""Nodeflow V4 —— 上下文预算

估算与降级：head 永不裁剪；transient → tail → messages（至少留一条）。
系数由真实 usage 校准，改前先跑 test_context_budget 的校准用例。

本文件由 `Runtime` 通过 mixin 组合；状态仍集中在 `Runtime` 实例上。
这是**模块级职责划分**，不是对象级解耦 —— 真正抽出独立对象留待具体实现阶段，
届时边界已由本文件画好。
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any, Mapping

from nodeflow_core import (
    InvariantError, InvocationContext,
)


class ContextBudgetMixin:
    def estimate_tokens(self, ctx: InvocationContext) -> int:
        blob = "".join(str(x) for x in (ctx.head, ctx.messages, ctx.tail, ctx.transient))
        return self.estimate_text_tokens(blob)

    def estimate_text_tokens(self, text: str) -> int:
        """粗略估算。CJK 与拉丁字符的 token 密度差好几倍，分开算。

        系数由 `test_context_budget.py` 的校准用例对着真实 usage 量出来，
        不是拍的。改系数前先跑那条。
        """
        cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿"
                  or "豈" <= ch <= "﫿"
                  or "぀" <= ch <= "ヿ")
        return int(cjk / self.cjk_chars_per_token
                   + (len(text) - cjk) / self.chars_per_token)

    def estimate_spec_tokens(self, spec: Mapping[str, Any]) -> int:
        """system prompt 与工具 schema 也占输入预算 —— 漏算它们会系统性低估。"""
        blob = str(spec.get("systemPrompt") or "")
        blob += json.dumps(spec.get("tools") or [], ensure_ascii=False, default=repr)
        return self.estimate_text_tokens(blob)

    def _fit_context(self, ctx: InvocationContext, budget: int | None,
                     *, gid: str, node_id: str, overhead: int = 0):
        """把上下文裁到预算内。

        **head 永不裁剪** —— 它是实例化时固定的引用，动它等于换任务。
        head 自己就超预算 ⇒ 图切分过粗，直接失败，不要悄悄降级。

        其余按 `truncation_order` 依次砍**最旧**的。每次裁剪产生一条告警，
        与压缩同级 —— 都是"这个节点承担的任务过大"的信号。
        """
        if budget is None:
            return ctx, []
        head_only = InvocationContext(head=ctx.head)
        head_tokens = self.estimate_tokens(head_only) + overhead
        if head_tokens > budget:
            raise InvariantError(
                f"{gid}/{node_id}：head + spec 开销 {head_tokens} tokens 已超预算 {budget}；"
                f"head 不可裁剪（图切分过粗，应拆分节点）"
            )
        trims: list[dict[str, Any]] = []
        cur = ctx
        for section in self.truncation_order:
            keep = self.min_keep.get(section, 0)
            while self.estimate_tokens(cur) + overhead > budget:
                items = getattr(cur, section)
                if len(items) <= keep:
                    break
                trims.append({
                    "section": section,
                    "dropped_index": len(trims),
                    "approx_tokens": self.estimate_text_tokens(str(items[0])),
                })
                cur = replace(cur, **{section: tuple(items[1:])})   # 砍最旧
            if self.estimate_tokens(cur) + overhead <= budget:
                break
        if self.estimate_tokens(cur) + overhead > budget:
            raise InvariantError(
                f"{gid}/{node_id}：裁到无可再裁仍超预算"
                f"（{self.estimate_tokens(cur) + overhead} > {budget}，"
                f"其中 spec 开销 {overhead}）"
            )
        return cur, trims
