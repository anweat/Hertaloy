"""Nodeflow V4 —— 控制面 MCP stdio 传输层（Phase 4）

把 `nodeflow_control.ControlPlane` 暴露为 JSON-RPC 2.0 / MCP：
  - initialize / ping
  - tools/list    → TOOLS 的 name/description/inputSchema
  - tools/call    → ControlPlane.dispatch(name, arguments, actor=…)

actor 是**可信边界**：由进程环境变量 `NODEFLOW_MCP_ACTOR` 注入
（缺省 system:core），工具参数里的身份字段一律不信。

运行：python nodeflow_mcp.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Mapping, TextIO

from nodeflow_control import TOOLS, ControlPlane
from nodeflow_v4 import InvariantError, Runtime

PROTOCOL_VERSION = "2024-11-05"


class McpServer:
    def __init__(self, rt: Runtime, *, actor: str):
        self.control = ControlPlane(rt)
        self.actor = actor

    def handle_line(self, line: str) -> str | None:
        """处理一行 JSON-RPC；通知（无 id）返回 None，其余返回响应行。"""
        if not line.strip():
            return None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            return self._response(None, {"code": -32700,
                                         "message": f"Parse error: {exc}"})
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            return self._response(mid, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "nodeflow-control",
                               "version": "v4"},
            })
        if method == "ping":
            return self._response(mid, {})
        if method in ("notifications/initialized",
                      "notifications/cancelled"):
            return None
        if method == "tools/list":
            return self._response(mid, {
                "tools": [
                    {"name": name,
                     "description": tool["description"],
                     "inputSchema": tool["inputSchema"]}
                    for name, tool in TOOLS.items()
                ],
            })
        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            try:
                if name not in TOOLS:
                    raise InvariantError(f"unknown control tool: {name}")
                result = self.control.dispatch(name, arguments,
                                               actor=self.actor)
                return self._tool_result(mid, result)
            except Exception as exc:        # noqa: BLE001
                return self._tool_error(mid, exc)
        return self._response(mid, {"code": -32601,
                                    "message": f"Method not found: {method}"},
                              is_error=True)

    @staticmethod
    def _response(mid, result, *, is_error=False) -> str:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": mid}
        payload["error" if is_error else "result"] = result
        return json.dumps(payload, ensure_ascii=False, default=repr)

    @staticmethod
    def _tool_result(mid, value) -> str:
        return McpServer._response(mid, {
            "content": [{"type": "text",
                         "text": json.dumps(value, ensure_ascii=False,
                                            default=repr)}],
            "isError": False,
        })

    @staticmethod
    def _tool_error(mid, exc: Exception) -> str:
        return McpServer._response(mid, {
            "content": [{"type": "text",
                         "text": f"{type(exc).__name__}: {exc}"}],
            "isError": True,
        })


def serve_stdio(rt: Runtime, *, actor: str,
                stdin: TextIO = sys.stdin,
                stdout: TextIO = sys.stdout) -> None:
    server = McpServer(rt, actor=actor)
    for line in stdin:
        out = server.handle_line(line)
        if out is not None:
            stdout.write(out + "\n")
            stdout.flush()


def main() -> None:
    rt = Runtime()
    actor = os.environ.get("NODEFLOW_MCP_ACTOR", "system:core")
    serve_stdio(rt, actor=actor)


if __name__ == "__main__":
    main()
