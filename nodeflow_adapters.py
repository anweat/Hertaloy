"""Nodeflow V4 —— 执行面适配层

编排面（Python）与各家 harness（TS / Rust / 其他 CLI）之间的边界。
边界固定在 **JSON** 上，不绑定实现语言 —— 因为 pi 是 TS、Claude SDK 是 TS、
Codex 侧是 Python，无论如何都要跨语言。

## 线格式

Python → driver（stdin，每行一个 JSON）：
    {"type": "run",    "request": {...}}
    {"type": "cancel", "execution_id": "..."}

driver → Python（stdout，每行一个 JSON）：
    {"type": "event",       "execution_id": ..., "event": {...}}   # 流式观测
    {"type": "observation", "execution_id": ..., "observation": {...}}
    {"type": "result",      "execution_id": ..., "result": {...}}
    {"type": "error",       "execution_id": ..., "message": "..."}

`observation` 用于记录 backend 实际发生了什么，**包括不可干预的内部 tool**
（判据 B6）。其中 `gated: false` 表示"我们只能看见，拦不住"。

driver 侧的义务见 `DRIVER_CONTRACT`。
"""

from __future__ import annotations

import json
import subprocess
import threading
from dataclasses import asdict
from typing import Any, Callable, Mapping, Sequence

from nodeflow_v4 import (
    ExecutionBackend,
    ExecutionLimits,
    ExecutionRequest,
    ExecutionResult,
    InvocationContext,
    InvariantError,
    OutputContract,
    Usage,
    WorkspaceScope,
)

DRIVER_CONTRACT = """\
一个合法 driver 必须：
  1. 无状态          —— 同一 request 重放产生等价执行，不依赖上次调用的隐藏状态
  2. 历史外来        —— 完整对话只来自 request.context，不得自行补历史
  3. 工具封闭        —— 暴露给模型的工具集 == agent_spec.tools，一个不多
  4. 如实计量        —— usage 反映真实消耗；发生压缩必须置 compactions
  5. 观测完备        —— 每次工具调用都发 observation，拦不住的标 gated:false
  6. 可取消          —— 收到 cancel 后停止并回 termination:"CANCELLED"
  7. 会话不外泄      —— 不依赖自身持久化；session_handle 仅作缓存优化
"""


# ---------------------------------------------------------------------------
# 编解码
# ---------------------------------------------------------------------------


def request_to_json(req: ExecutionRequest) -> dict[str, Any]:
    return {
        "execution_id": req.execution_id,
        "agent_spec": dict(req.agent_spec),
        "context": {
            "head": list(req.context.head),
            "messages": list(req.context.messages),
            "tail": list(req.context.tail),
            "transient": list(req.context.transient),
        },
        "origin": list(req.origin),
        "workspace": asdict(req.workspace),
        "output_contract": {
            "schema": dict(req.output_contract.schema),
            "allowed_emit_ports": list(req.output_contract.allowed_emit_ports),
        },
        "limits": asdict(req.limits),
        "resume_handle": req.resume_handle,
    }


def result_from_json(payload: Mapping[str, Any]) -> ExecutionResult:
    return ExecutionResult(
        execution_id=payload["execution_id"],
        emissions=tuple((e["port"], e["payload"]) for e in payload.get("emissions", [])),
        artifacts=tuple(
            (a["kind"], a["object_id"], a["body"]) for a in payload.get("artifacts", [])
        ),
        usage=Usage(**payload.get("usage", {})),
        termination=payload.get("termination", "DONE"),
        session_handle=payload.get("session_handle"),
        observations=tuple(payload.get("observations", ())),
        diagnostics=payload.get("diagnostics", {}),
    )


def json_to_request(payload: Mapping[str, Any]) -> ExecutionRequest:
    """driver 侧若用 Python 实现，可复用此函数。"""
    ctx = payload["context"]
    oc = payload.get("output_contract", {})
    return ExecutionRequest(
        execution_id=payload["execution_id"],
        agent_spec=payload.get("agent_spec", {}),
        context=InvocationContext(
            head=tuple(ctx.get("head", ())),
            messages=tuple(ctx.get("messages", ())),
            tail=tuple(ctx.get("tail", ())),
            transient=tuple(ctx.get("transient", ())),
        ),
        origin=tuple(payload.get("origin", ("", ""))),
        workspace=WorkspaceScope(**payload.get("workspace", {})),
        output_contract=OutputContract(
            schema=oc.get("schema", {}),
            allowed_emit_ports=tuple(oc.get("allowed_emit_ports", ())),
        ),
        limits=ExecutionLimits(**payload.get("limits", {})),
        resume_handle=payload.get("resume_handle"),
    )


# ---------------------------------------------------------------------------
# 子进程 backend
# ---------------------------------------------------------------------------


class DriverError(InvariantError):
    pass


class SubprocessBackend(ExecutionBackend):
    """把任意语言的 driver 当作执行面。

    单线程同步：发一条 run，逐行读到 result / error 为止。事件与观测在读取
    过程中回调出去，因此流式监控不需要额外线程。
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: str | None = None,
        on_event: Callable[[str, Mapping[str, Any]], None] | None = None,
        timeout: float | None = None,
    ) -> None:
        self.command = list(command)
        self.cwd = cwd
        self.on_event = on_event
        self.timeout = timeout
        self.events: list[tuple[str, Mapping[str, Any]]] = []
        self.seen: list[ExecutionRequest] = []      # 与 MockExecutionBackend 对齐
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._cancelled: set[str] = set()

    # ---- 生命周期 ---------------------------------------------------------

    def _ensure(self) -> subprocess.Popen:
        if self._proc is None or self._proc.poll() is not None:
            self._proc = subprocess.Popen(
                self.command,
                cwd=self.cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        return self._proc

    def close(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
            if proc is None:
                return
            if proc.poll() is None:
                for stream in (proc.stdin,):
                    try:
                        stream.close()
                    except Exception:
                        pass
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
            for stream in (proc.stdout, proc.stderr, proc.stdin):
                try:
                    if stream is not None and not stream.closed:
                        stream.close()
                except Exception:
                    pass

    def __enter__(self) -> SubprocessBackend:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- ExecutionBackend -------------------------------------------------

    def run(self, request: ExecutionRequest) -> ExecutionResult:
        self.seen.append(request)
        proc = self._ensure()
        self._send(proc, {"type": "run", "request": request_to_json(request)})

        while True:
            line = proc.stdout.readline()
            if not line:
                err = proc.stderr.read() if proc.stderr else ""
                raise DriverError(f"driver 提前退出：{err.strip()[:500]}")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                raise DriverError(f"driver 输出非 JSON：{line[:200]!r}") from exc

            kind = msg.get("type")
            if kind in ("event", "observation"):
                body = msg.get("event") or msg.get("observation") or {}
                self.events.append((kind, body))
                if self.on_event is not None:
                    self.on_event(kind, body)
                continue
            if kind == "error":
                raise DriverError(msg.get("message", "unknown driver error"))
            if kind == "result":
                return result_from_json(msg["result"])
            raise DriverError(f"未知 driver 消息类型：{kind!r}")

    def cancel(self, execution_id: str) -> None:
        self._cancelled.add(execution_id)
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            self._send(proc, {"type": "cancel", "execution_id": execution_id})
        except Exception:
            # driver 不响应取消 —— 降级为杀进程（判据 C1 的降级路径）
            proc.kill()
            self.close()

    # ---- 内部 -------------------------------------------------------------

    @staticmethod
    def _send(proc: subprocess.Popen, payload: Mapping[str, Any]) -> None:
        proc.stdin.write(json.dumps(payload, ensure_ascii=False, default=repr) + "\n")
        proc.stdin.flush()

    # ---- 观测投影 ---------------------------------------------------------

    def last_request_for(self, spec_id: str) -> ExecutionRequest:
        for req in reversed(self.seen):
            if req.agent_spec.get("spec_id") == spec_id:
                return req
        raise KeyError(spec_id)

    def requests_for(self, spec_id: str) -> list[ExecutionRequest]:
        return [r for r in self.seen if r.agent_spec.get("spec_id") == spec_id]

    def tool_calls(self) -> list[Mapping[str, Any]]:
        return [b for k, b in self.events if k == "observation" and b.get("kind") == "tool_call"]

    def ungated_tool_calls(self) -> list[Mapping[str, Any]]:
        """拦不住、只能看见的内部 tool（判据 B6）。"""
        return [c for c in self.tool_calls() if not c.get("gated", True)]
