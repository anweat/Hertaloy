"""Phase 4 —— 装配面卡片库：标签索引与检索投影

search_cards 是纯查询（kind 过滤 / tags 全命中 / query 模糊匹配 id+summary+text），
返回精确版本引用，多版本并存时全部列出。不引入新的运行子系统。

运行：python -m unittest test_card_library -v
"""

from __future__ import annotations

import unittest

from nodeflow_v4 import InvariantError, Runtime


class CardLibraryTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_card(
            kind="skill", card_id="openapi-gen", version=1,
            body={"summary": "生成 OpenAPI 规格", "text": "..."},
            tags=["api", "codegen"])
        self.rt.register_card(
            kind="skill", card_id="openapi-gen", version=2,
            body={"summary": "生成 OpenAPI 规格 v2", "text": "..."},
            tags=["api", "codegen", "v2"])
        self.rt.register_card(
            kind="rules", card_id="py-strict", version=3,
            body={"text": "只改 src/ 下的文件"},
            tags=["python", "coding"])

    def test_C1_search_by_kind_tags_and_query(self):
        self.assertEqual(
            self.rt.search_cards(tags={"api"}),
            ["skill/openapi-gen@1", "skill/openapi-gen@2"])
        self.assertEqual(
            self.rt.search_cards(kind="rules", tags={"python"}),
            ["rules/py-strict@3"])
        self.assertEqual(
            self.rt.search_cards(tags={"api", "v2"}),
            ["skill/openapi-gen@2"])
        self.assertEqual(
            self.rt.search_cards(query="py-strict"),
            ["rules/py-strict@3"])
        self.assertEqual(
            self.rt.search_cards(query="OpenAPI"),
            ["skill/openapi-gen@1", "skill/openapi-gen@2"])
        self.assertEqual(self.rt.search_cards(tags={"ghost"}), [])

    def test_C2_invalid_tags_are_rejected_at_registration(self):
        with self.assertRaises(InvariantError):
            self.rt.register_card(kind="prompt", card_id="p", version=1,
                                  body={}, tags=[""])
        with self.assertRaises(InvariantError):
            self.rt.register_card(kind="prompt", card_id="p", version=1,
                                  body={}, tags=[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
