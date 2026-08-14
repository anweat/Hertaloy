"""Nodeflow V4 —— 观察投影

只读。任何写入都不属于这里。

本文件由 `Runtime` 通过 mixin 组合；状态仍集中在 `Runtime` 实例上。
这是**模块级职责划分**，不是对象级解耦 —— 真正抽出独立对象留待具体实现阶段，
届时边界已由本文件画好。
"""

from __future__ import annotations


from typing import Any, Mapping, Sequence

from nodeflow_core import (
    ExecutionRecordView, InvariantError,
    InvocationContext, ObjectVersion, QueueView, Usage,
)


class ProjectionsMixin:
    def graph_status(self, gid): return self._instances[gid].status

    def node_persistent_state(self, gid, node_id):
        return self._instances[gid].nodes[node_id].persistent

    def node_executions(self, gid, node_id) -> Sequence[ExecutionRecordView]:
        return [
            ExecutionRecordView(r.execution_id, r.gid, r.node_id, r.status)
            for r in self._records.values()
            if r.gid == gid and r.node_id == node_id
        ]

    def children_of(self, gid, slot_id):
        return list(self._instances[gid].children.get(slot_id, []))

    def context_of(self, gid, node_id) -> InvocationContext:
        """该节点**当前**的上下文构成。想看某次调用实际收到的，读 backend 记录的请求。"""
        st = self._instances[gid].nodes[node_id]
        return InvocationContext(head=self._instances[gid].head, tail=tuple(st.tail))

    def agent_spec_of(self, gid, node_id) -> Mapping[str, Any]:
        st = self._instances[gid].nodes[node_id]
        if st.last_spec is None:
            tpl = self._templates[self._instances[gid].template_ref]
            return self._resolve_spec(tpl["nodes"][node_id]["spec"])
        return st.last_spec

    def _append_object(self, oid, body, *, kind=None, provenance=None) -> ObjectVersion:
        """内部写入口 —— 一律经 store，绝不自行分配版本号。"""
        if kind is None:
            kind = ("run" if oid.startswith("run/")
                    else "annotation" if oid.startswith("annotation/")
                    else "object")
        ov = self.store.put(oid, kind, body, provenance)
        # 每条 RunSnapshot 恰好对应一次提交 —— 持久化挂在这里，一处覆盖全部提交路径
        if kind == "run" and self.on_commit is not None:
            self.on_commit(self, ov)
        return ov

    def artifact_versions(self, oid) -> list[int]:
        return [ov.version for ov in self.store.history(oid)]

    def artifact(self, oid, version) -> Mapping[str, Any]:
        return self.store.get(oid, version).body

    def annotations(self, gid) -> Sequence[ObjectVersion]:
        """Annotation 就是 kind="annotation" 的 ObjectVersion。"""
        return self.store.history(f"annotation/{gid}")

    def queue(self, topic_id) -> QueueView:
        with self._lock:
            if topic_id not in self._topics:
                raise InvariantError(f"unknown topic: {topic_id}")
            depth = sum(
                1 for m in self._messages.values()
                if m.topic == topic_id and m.state == "QUEUED"
            )
            return QueueView(
                topic_id=topic_id,
                depth=depth,
                subscriber_endpoints=tuple(t for _s, t in self._subs.get(topic_id, [])),
            )

    def usage(self, gid) -> Usage:
        acc: dict[str, Any] = {}
        for ov in self.store.history(f"run/{gid}"):
            u = ov.body.get("usage")
            if not isinstance(u, Mapping):
                continue
            for k, v in u.items():
                acc[k] = acc.get(k, 0) + v
        return Usage(**acc) if acc else Usage()

    def context_alerts(self, gid) -> list[Mapping[str, Any]]:
        """压缩不是特性，是图切分错误的告警信号（FOUNDATION §1）。"""
        out = []
        for ov in self.store.history(f"run/{gid}"):
            body = ov.body
            u = body.get("usage")
            if isinstance(u, Mapping) and u.get("compactions"):
                out.append({
                    "kind": "compaction",
                    "node": body.get("node"),
                    "execution": body.get("execution"),
                    "compactions": u["compactions"],
                    "reason": "上下文压缩发生 —— 该节点承担的任务过大，应拆分",
                })
            trims = body.get("context_trims") or []
            if trims:
                out.append({
                    "kind": "truncation",
                    "node": body.get("node"),
                    "execution": body.get("execution"),
                    "trims": list(trims),
                    "reason": "为塞进预算裁剪了上下文 —— 与压缩同级的失败信号",
                })
        return out

    def commit_seq(self, gid): return self._instances[gid].seq
