"""Phase 4 —— MCP stdio 传输层测试

进程内验证 JSON-RPC/MCP 形状与 actor 注入；子进程 smoke 验证 stdio 线路。

运行：python -m unittest test_mcp -v
"""

from __future__ import annotations

import json
import os
import subprocess
import unittest

from nodeflow_mcp import McpServer
from nodeflow_v4 import Runtime

HERE = os.path.dirname(os.path.abspath(__file__))


class McpInProcessTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.rt.register_handler("record",
                                 lambda p, c: c["state"].update({"last": p}))
        self.server = McpServer(self.rt, actor="human:alice")

    def _rpc(self, mid, method, params=None):
        return json.loads(self.server.handle_line(
            json.dumps({"jsonrpc": "2.0", "id": mid, "method": method,
                        "params": params or {}})))

    def test_M1_initialize_and_tools_list(self):
        init = self._rpc(1, "initialize")
        self.assertEqual(init["result"]["protocolVersion"], "2024-11-05")
        self.assertIn("tools", init["result"]["capabilities"])

        tools = self._rpc(2, "tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        for expected in ("register_card", "propose_graph_template",
                         "approve_graph_template", "instantiate",
                         "send", "drain", "query_graph"):
            self.assertIn(expected, names)
        self.assertIn("inputSchema", tools[0])

    def test_M2_tools_call_dispatches_with_injected_actor(self):
        res = self._rpc(3, "tools/call", {
            "name": "propose_graph_template",
            "arguments": {
                "proposal_id": "p1",
                "template_id": "flow",
                "spec": {"nodes": {"n": {"kind": "plain", "handler": "record",
                                         "endpoints": {"io": {}}}},
                         "edges": []},
                "proposer": "human:mallory",     # payload 身份不可信
            },
        })
        self.assertFalse(res["result"]["isError"])
        proposal = self.rt.graph_template_proposal("p1")
        self.assertEqual(proposal.body["proposer"], "human:alice")

    def test_M3_unknown_tool_and_bad_arguments_are_errors(self):
        res = self._rpc(4, "tools/call", {"name": "ghost", "arguments": {}})
        self.assertTrue(res["result"]["isError"])
        self.assertIn("unknown", res["result"]["content"][0]["text"])

        res = self._rpc(5, "tools/call", {"name": "instantiate",
                                          "arguments": {}})
        self.assertTrue(res["result"]["isError"])

    def test_M4_notifications_do_not_emit_responses(self):
        out = self.server.handle_line(
            '{"jsonrpc":"2.0","method":"notifications/initialized"}')
        self.assertIsNone(out)


class McpStdioSmokeTestCase(unittest.TestCase):

    def test_M5_stdio_transport_roundtrip(self):
        proc = subprocess.Popen(
            [os.environ.get("PY_BIN", "python"), "nodeflow_mcp.py"],
            cwd=HERE,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "NODEFLOW_MCP_ACTOR": "human:alice"})
        try:
            proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {}}) + "\n")
            proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list",
                 "params": {}}) + "\n")
            proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": "query_template_versions",
                            "arguments": {"template_id": "none"}}}) + "\n")
            proc.stdin.flush()

            replies = [json.loads(proc.stdout.readline()),
                       json.loads(proc.stdout.readline()),
                       json.loads(proc.stdout.readline())]
            self.assertEqual([r["id"] for r in replies], [1, 2, 3])
            self.assertEqual(replies[0]["result"]["protocolVersion"],
                             "2024-11-05")
            self.assertEqual(len(replies[1]["result"]["tools"]),
                             len(__import__("nodeflow_control").TOOLS))
            self.assertEqual(replies[2]["result"]["content"][0]["text"],
                             "[]")
        finally:
            proc.stdin.close()
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    unittest.main(verbosity=2)
