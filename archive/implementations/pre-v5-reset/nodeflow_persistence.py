"""Nodeflow V4 —— sqlite 持久化

让崩溃接管（测试 E6）从内存断言变成真能力。

## 落什么、不落什么

| | 处理 | 理由 |
|---|---|---|
| ObjectVersion（含 run / annotation） | **落盘，append-only** | 版本不可变，天然增量 |
| GraphInstance / NodeInstance 状态 | 落盘，每次提交后 upsert | 崩溃后要能续跑 |
| ExecutionRecord | 落盘 | **崩溃接管的唯一依据** |
| MessageInstance + 投递状态 | 落盘 | 决定重启后还有什么活 |
| Subscription | 落盘 | 队列是独立索引，订阅是运行期关系 |
| 模板 / 卡片 / 策略 / handler / transform | **不落盘** | 定义层来自装配面，启动时重新注册；handler 本就是 Python 函数，存不了 |

## 一致性

写入挂在 `Runtime.on_commit` 上——每条 RunSnapshot 恰好对应一次提交，
因此"提交成功"与"落盘成功"同步发生。单写者、同步事务。

当前实现每次提交做一次全量 upsert；对象表是增量。运行状态表在骨架规模下
无所谓，需要时再上脏标记。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import asdict
from typing import Any, Mapping

from nodeflow_v4 import (
    ObjectStore,
    ObjectVersion,
    Provenance,
    Runtime,
    _Instance,
    _Message,
    _NodeState,
    _Record,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
    object_id    TEXT NOT NULL,
    version      INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    body         TEXT NOT NULL,
    provenance   TEXT NOT NULL,
    PRIMARY KEY (object_id, version)
);
CREATE INDEX IF NOT EXISTS idx_objects_hash ON objects(object_id, content_hash);

CREATE TABLE IF NOT EXISTS instances (
    gid          TEXT PRIMARY KEY,
    template_ref TEXT NOT NULL,
    owner        TEXT NOT NULL,
    status       TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    params       TEXT NOT NULL,
    head         TEXT NOT NULL,
    nodes        TEXT NOT NULL,
    children     TEXT NOT NULL,
    pool_cursor  TEXT NOT NULL,
    overflow     TEXT NOT NULL,
    controllers  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
    execution_id       TEXT PRIMARY KEY,
    gid                TEXT NOT NULL,
    node_id            TEXT NOT NULL,
    status             TEXT NOT NULL,
    claimed            TEXT NOT NULL,
    base_node_version  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);

CREATE TABLE IF NOT EXISTS messages (
    mid      TEXT PRIMARY KEY,
    target   TEXT NOT NULL,
    payload  TEXT NOT NULL,
    state    TEXT NOT NULL,
    callback TEXT,
    topic    TEXT,
    mkind    TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    exit_port TEXT,
    request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);

CREATE TABLE IF NOT EXISTS subscriptions (
    sid    TEXT PRIMARY KEY,
    topic  TEXT NOT NULL,
    target TEXT NOT NULL
);
"""

_J = lambda v: json.dumps(v, ensure_ascii=False, default=repr)  # noqa: E731


class SqlitePersistence:
    """挂在 Runtime 上的落盘层。用法：

        p = SqlitePersistence("run.db")
        p.attach(rt)              # 之后每次提交自动落盘

    重启后：

        rt = Runtime(); register_definitions(rt)   # 定义层重新注册
        p = SqlitePersistence("run.db"); p.restore(rt); p.attach(rt)
        rt.reclaim_stale_executions()              # 崩溃时在途的执行退回可认领
    """

    def __init__(self, path: str = ":memory:") -> None:
        # check_same_thread=False：flush 挂在 Runtime.on_commit/on_change 上，
        # drain_concurrent 的 worker 线程会调用它；真正的串行化由 _write_lock
        # 保证（P0-3：持久化必须能与并发调度一起工作）。
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self._write_lock = threading.RLock()
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()
        #: 每个 object_id 已落盘到第几版 —— 对象 append-only，只补写增量
        self._hwm: dict[str, int] = {}

    def _migrate(self) -> None:
        """对旧库补列：attempts/exit_port/request_id（消息）与 overflow（实例）。"""
        cols = {row[1] for row in self.conn.execute("PRAGMA table_info(messages)")}
        if "attempts" not in cols:
            self.conn.execute(
                "ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
        if "exit_port" not in cols:
            self.conn.execute("ALTER TABLE messages ADD COLUMN exit_port TEXT")
        if "request_id" not in cols:
            self.conn.execute("ALTER TABLE messages ADD COLUMN request_id TEXT")

        icols = {row[1] for row in self.conn.execute("PRAGMA table_info(instances)")}
        if "overflow" not in icols:
            self.conn.execute(
                "ALTER TABLE instances ADD COLUMN overflow TEXT NOT NULL DEFAULT '{}'")

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> SqlitePersistence:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- 挂载 -------------------------------------------------------------

    def attach(self, rt: Runtime) -> None:
        rt.on_commit = lambda runtime, ov: self.flush(runtime, ov)
        # claim / release / 订阅增删没有 RunSnapshot，但同样是提交边界（P0-4/P0-5）
        rt.on_change = lambda runtime: self.flush(runtime)

    # ---- 写 ---------------------------------------------------------------

    def flush(self, rt: Runtime, latest: ObjectVersion | None = None) -> None:
        """一次提交 = 一次事务。对象增量写，运行状态 upsert。

        注意不能只写 `latest`：同一次提交里通常先写产物、后写 RunSnapshot，
        只写后者会漏掉前者。按 object_id 的水位补写增量。
        """
        c = self.conn
        with self._write_lock:      # 并发提交时串行化整个事务（P0-3）
            with c:
                for oid, versions in rt.store._by_object.items():
                    start = self._hwm.get(oid, 0)
                    if len(versions) > start:
                        for ov in versions[start:]:
                            self._put_object(c, ov)
                        self._hwm[oid] = len(versions)

                for inst in rt._instances.values():
                    c.execute(
                        "INSERT OR REPLACE INTO instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (inst.gid, inst.template_ref, inst.owner, inst.status, inst.seq,
                         _J(dict(inst.params)), _J(list(inst.head)),
                         _J({n: {"persistent": s.persistent, "tail": s.tail,
                                 "transient": s.transient,
                                 "version": s.version} for n, s in inst.nodes.items()}),
                         _J(inst.children), _J(inst.pool_cursor),
                         _J(inst.overflow), _J(sorted(inst.controllers))),
                    )
                for rec in rt._records.values():
                    c.execute(
                        "INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?)",
                        (rec.execution_id, rec.gid, rec.node_id, rec.status,
                         _J(list(rec.claimed)), rec.base_node_version),
                    )
                for m in rt._messages.values():
                    c.execute(
                        "INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (m.mid, _J(list(m.target)), _J(m.payload), m.state,
                         _J(list(m.callback)) if m.callback else None,
                         m.topic, m.mkind, m.attempts, m.exit_port, m.request_id),
                    )
                # 订阅是运行期关系：先删掉内存里已不存在的行（unsubscribe 必须
                # 持久化，否则重启后幽灵订阅复活，P0-5），再 upsert 现存条目。
                live_sids = {sid for entries in rt._subs.values()
                             for sid, _t in entries}
                for (sid,) in c.execute("SELECT sid FROM subscriptions"):
                    if sid not in live_sids:
                        c.execute("DELETE FROM subscriptions WHERE sid = ?", (sid,))
                for topic, entries in rt._subs.items():
                    for sid, target in entries:
                        c.execute("INSERT OR REPLACE INTO subscriptions VALUES (?,?,?)",
                                  (sid, topic, _J(list(target))))

    @staticmethod
    def _put_object(c: sqlite3.Connection, ov: ObjectVersion) -> None:
        c.execute(
            "INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?,?)",
            (ov.object_id, ov.version, ov.kind, ov.content_hash,
             _J(dict(ov.body)), _J(asdict(ov.provenance))),
        )

    # ---- 读 ---------------------------------------------------------------

    def restore(self, rt: Runtime) -> Runtime:
        """把运行状态灌回一个已注册好定义层的 Runtime。"""
        c = self.conn
        store = ObjectStore()
        for oid, ver, kind, h, body, prov in c.execute(
            "SELECT object_id, version, kind, content_hash, body, provenance "
            "FROM objects ORDER BY object_id, version"
        ):
            ov = ObjectVersion(object_id=oid, version=ver, kind=kind,
                               content_hash=h, body=json.loads(body),
                               provenance=Provenance(**json.loads(prov)))
            store._by_object.setdefault(oid, []).append(ov)
            store._by_hash[(oid, h)] = ov
        rt.store = store
        self._hwm = {oid: len(v) for oid, v in store._by_object.items()}

        rt._instances.clear()
        for (gid, tref, owner, status, seq, params, head,
             nodes, children, cursor, overflow, controllers) in c.execute(
                "SELECT * FROM instances"):
            inst = _Instance(
                gid=gid, template_ref=tref, owner=owner, status=status, seq=seq,
                params=json.loads(params), head=tuple(json.loads(head)),
                children=json.loads(children), pool_cursor=json.loads(cursor),
                overflow=json.loads(overflow),
                controllers=set(json.loads(controllers)),
            )
            for node_id, st in json.loads(nodes).items():
                inst.nodes[node_id] = _NodeState(
                    persistent=st.get("persistent", {}),
                    tail=list(st.get("tail", [])),
                    transient=list(st.get("transient", [])),
                    version=st.get("version", 0),
                )
            rt._instances[gid] = inst

        rt._records.clear()
        for eid, gid, node_id, status, claimed, base in c.execute(
                "SELECT * FROM records"):
            rt._records[eid] = _Record(
                execution_id=eid, gid=gid, node_id=node_id, status=status,
                claimed=tuple(json.loads(claimed)), base_node_version=base,
            )

        rt._messages.clear()
        for (mid, target, payload, state, callback, topic, mkind,
             attempts, exit_port, request_id) in c.execute("SELECT * FROM messages"):
            rt._messages[mid] = _Message(
                mid=mid, target=tuple(json.loads(target)),
                payload=json.loads(payload), state=state,
                callback=tuple(json.loads(callback)) if callback else None,
                topic=topic, mkind=mkind,
                attempts=int(attempts or 0), exit_port=exit_port,
                request_id=request_id,
            )

        for sid, topic, target in c.execute("SELECT * FROM subscriptions"):
            rt._subs.setdefault(topic, []).append((sid, tuple(json.loads(target))))

        rt._bump_id_counter()
        return rt

    # ---- 观察 -------------------------------------------------------------

    def stale_executions(self) -> list[str]:
        """重启后仍标 RUNNING 的执行 —— 崩溃时在途的那些。"""
        return [r[0] for r in self.conn.execute(
            "SELECT execution_id FROM records WHERE status = 'RUNNING'")]

    def counts(self) -> Mapping[str, int]:
        return {t: self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("objects", "instances", "records", "messages", "subscriptions")}
