"""Phase 1 —— workspace 传播与内置工具执行器的确定性验证

workspace.root 的优先级：node.workspace > instance.params.workspace_root > "."。
执行器本体由 Node 侧测试覆盖（drivers/tool_executors.test.mjs），
这里只负责"编排面确实把它装进 ExecutionRequest"与"Node 测试可被 pytest 执行"。

运行：python -m unittest test_workspace -v
"""

from __future__ import annotations

import os
import subprocess
import unittest

from nodeflow_v4 import ExecutionResult, MockExecutionBackend, Runtime

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_TEST = os.path.join(HERE, "drivers", "tool_executors.test.mjs")


def _ok(req, **kw):
    return ExecutionResult(execution_id=req.execution_id, **kw)


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self):
        self.rt = Runtime()
        self.backend = MockExecutionBackend()
        self.rt.set_backend(self.backend)
        self.rt.register_card(kind="rules", card_id="base", version=1, body={})
        self.rt.compile_agent_spec("w", model="m", cards=[("rules", "base")])
        self.backend.on("w", lambda req: _ok(req))

    def _job(self, *, node_workspace=None, params=None):
        node = {"kind": "agent", "spec": "w", "endpoints": {"io": {}, "out": {}}}
        if node_workspace is not None:
            node["workspace"] = node_workspace
        tpl = self.rt.register_graph_template(
            f"t{len(self.rt._templates)}", {"nodes": {"w": node}, "edges": []})
        return self.rt.instantiate(tpl, owner="service:job", params=params)

    def _claimed_workspace(self, job):
        self.rt.send((job, "w", "io"), {"task": "t"})
        _eid, req = self.rt.begin_execution(job, "w")
        return req.workspace.root


class TestWorkspacePropagation(WorkspaceTestCase):

    def test_W1_node_workspace_wins(self):
        job = self._job(node_workspace="C:/work/node",
                        params={"workspace_root": "C:/work/instance"})
        self.assertEqual(self._claimed_workspace(job), "C:/work/node")

    def test_W2_instance_params_fallback(self):
        job = self._job(params={"workspace_root": "C:/work/instance"})
        self.assertEqual(self._claimed_workspace(job), "C:/work/instance")

    def test_W3_default_is_current_directory(self):
        job = self._job()
        self.assertEqual(self._claimed_workspace(job), ".")


class TestNodeToolExecutors(unittest.TestCase):

    @unittest.skipUnless(
        os.path.exists(TOOLS_TEST), "drivers/tool_executors.test.mjs 缺失")
    def test_W4_node_executor_suite_passes(self):
        """执行器本体：6 条 Node 断言（越界/读写/列目录/run_shell 开关）。"""
        proc = subprocess.run(
            ["node", TOOLS_TEST], cwd=HERE, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(proc.returncode, 0,
                         f"node 执行器测试失败：\n{proc.stdout}\n{proc.stderr}")
        self.assertIn("pass 6", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
