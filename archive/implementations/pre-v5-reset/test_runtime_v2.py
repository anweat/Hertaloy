"""Behavior tests that define the current Nodeflow Runtime V2 discussion boundary."""

import copy
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from runtime_v2 import (
    AuthorizationError,
    InvariantError,
    MessageDraft,
    RuntimeHarness,
)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class RuntimeV2BehaviorTest(unittest.TestCase):
    def make_runtime(self):
        runtime = RuntimeHarness()
        runtime.register_container_template(
            {
                "templateId": "workspace@1",
                "allowedGraphTemplates": ["flow@1", "parent@1", "child@1"],
            }
        )
        runtime.create_container("workspace@1", "workspace-1", owner_id="owner")
        return runtime

    def test_01_push_fanout_uses_immutable_edges_and_stateless_servos(self):
        runtime = self.make_runtime()
        graph_template = {
            "templateId": "flow@1",
            "nodes": {
                "start": {"kind": "start", "inputs": ["in"], "outputs": ["out"]},
                "sinkA": {"kind": "sink", "inputs": ["in"]},
                "sinkB": {"kind": "sink", "inputs": ["in"]},
            },
            "edges": [
                {
                    "from": "start.out",
                    "to": "sinkA.in",
                    "operation": "PUSH",
                    "servo": {"set": {"branch": "A", "normalized": True}},
                },
                {
                    "from": "start.out",
                    "to": "sinkB.in",
                    "operation": "PUSH",
                    "servo": {"set": {"branch": "B", "normalized": True}},
                },
            ],
        }
        runtime.register_graph_template(graph_template)
        before = runtime.graph_template_fingerprint("flow@1")
        graph_id = runtime.create_graph_instance(
            "workspace-1", "flow@1", "graph-1"
        )

        original_payload = {"id": 7}
        source_id = runtime.send(
            graph_id,
            "start.in",
            MessageDraft.push(original_payload),
        )
        runtime.drain(graph_id)

        received_a = runtime.messages(graph_id, target_endpoint="sinkA.in")
        received_b = runtime.messages(graph_id, target_endpoint="sinkB.in")
        self.assertEqual([{"id": 7, "branch": "A", "normalized": True}], [m.payload for m in received_a])
        self.assertEqual([{"id": 7, "branch": "B", "normalized": True}], [m.payload for m in received_b])
        self.assertEqual({"id": 7}, runtime.message(source_id).payload)
        self.assertTrue(all(m.delivery_state == "CONSUMED" for m in [runtime.message(source_id), *received_a, *received_b]))
        self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))

    def test_02_callback_waiting_is_nested_in_call_message_and_reply_reenters_endpoint(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "callee": {"kind": "sink", "inputs": ["in"]},
                    "resume": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        call_id = runtime.call(
            source_graph_instance_id=graph_id,
            target_graph_instance_id=graph_id,
            target_endpoint="callee.in",
            payload={"question": "review"},
            reply_target="resume.in",
        )
        runtime.step(graph_id)

        call = runtime.message(call_id)
        self.assertEqual("CONSUMED", call.delivery_state)
        self.assertEqual("WAITING", call.callback_state)
        self.assertIsNone(call.reply_message_id)

        reply_id = runtime.reply(graph_id, call_id, {"approved": True})
        runtime.drain(graph_id)

        call = runtime.message(call_id)
        reply = runtime.message(reply_id)
        self.assertEqual("RESOLVED", call.callback_state)
        self.assertEqual(reply_id, call.reply_message_id)
        self.assertEqual(call_id, reply.reply_to_message_id)
        self.assertEqual([{"approved": True}], [m.payload for m in runtime.messages(graph_id, target_endpoint="resume.in")])
        snapshot = runtime.snapshot_container("workspace-1")
        self.assertNotIn("waits", snapshot)
        self.assertNotIn("continuations", snapshot)
        self.assertIn("callback", snapshot["messages"][call_id])
        self.assertEqual(
            graph_id,
            snapshot["messages"][call_id]["callback"]["replyTargetGraphInstanceId"],
        )

    def test_03_two_calls_to_same_endpoint_resolve_by_message_id_even_when_replies_reverse(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "callee": {"kind": "sink", "inputs": ["in"]},
                    "resume": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        first = runtime.call(graph_id, graph_id, "callee.in", {"n": 1}, "resume.in")
        second = runtime.call(graph_id, graph_id, "callee.in", {"n": 2}, "resume.in")
        runtime.drain(graph_id)

        reply_second = runtime.reply(graph_id, second, {"n": 2, "done": True})
        reply_first = runtime.reply(graph_id, first, {"n": 1, "done": True})
        runtime.drain(graph_id)

        self.assertEqual(reply_first, runtime.message(first).reply_message_id)
        self.assertEqual(reply_second, runtime.message(second).reply_message_id)
        self.assertEqual(2, len(runtime.messages(graph_id, target_endpoint="resume.in")))

    def test_04_strategy_all_claims_required_inputs_atomically_under_worker_race(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "all-required@1",
            {
                "readiness": "ALL_REQUIRED",
                "requiredInputs": ["left", "right"],
                "selection": "ONE_PER_INPUT",
                "output": "EMIT_EACH",
            },
        )

        calls = []

        def join_handler(batch, context):
            calls.append(tuple(sorted(m.id for messages in batch.values() for m in messages)))
            return {"out": {"left": batch["left"][0].payload, "right": batch["right"][0].payload}}

        runtime.register_handler("join-handler", join_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "join": {
                        "kind": "strategy",
                        "inputs": ["left", "right"],
                        "outputs": ["out"],
                        "policy": "all-required@1",
                        "handler": "join-handler",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [{"from": "join.out", "to": "sink.in", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        left_id = runtime.send(graph_id, "join.left", MessageDraft.push({"a": 1}))
        self.assertEqual(0, runtime.step(graph_id))
        right_id = runtime.send(graph_id, "join.right", MessageDraft.push({"b": 2}))

        barrier = threading.Barrier(3)

        def race_step():
            barrier.wait()
            return runtime.step(graph_id)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(race_step) for _ in range(2)]
            barrier.wait()
            [future.result() for future in futures]
        runtime.drain(graph_id)

        outputs = runtime.messages(graph_id, target_endpoint="sink.in")
        self.assertEqual(1, len(outputs))
        self.assertEqual(frozenset({left_id, right_id}), outputs[0].causation_ids)
        self.assertEqual(1, len(calls))
        self.assertEqual("CONSUMED", runtime.message(left_id).delivery_state)
        self.assertEqual("CONSUMED", runtime.message(right_id).delivery_state)

    def test_05_strategy_stream_processes_each_arrival_without_hidden_barrier(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "stream@1",
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": "EMIT_EACH",
            },
        )

        def stream_handler(batch, context):
            message = next(iter(batch.values()))[0]
            return {"out": {"seen": message.payload["value"]}}

        runtime.register_handler("stream-handler", stream_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "stream": {
                        "kind": "strategy",
                        "inputs": ["in"],
                        "outputs": ["out"],
                        "policy": "stream@1",
                        "handler": "stream-handler",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [{"from": "stream.out", "to": "sink.in", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        first = runtime.send(graph_id, "stream.in", MessageDraft.push({"value": "A"}))
        runtime.drain(graph_id)
        outputs_after_first = runtime.messages(graph_id, target_endpoint="sink.in")
        self.assertEqual([{"seen": "A"}], [m.payload for m in outputs_after_first])
        self.assertEqual(frozenset({first}), outputs_after_first[0].causation_ids)

        second = runtime.send(graph_id, "stream.in", MessageDraft.push({"value": "B"}))
        runtime.drain(graph_id)
        outputs = runtime.messages(graph_id, target_endpoint="sink.in")
        self.assertEqual([{"seen": "A"}, {"seen": "B"}], [m.payload for m in outputs])
        self.assertEqual(frozenset({second}), outputs[1].causation_ids)

    def test_06_strategy_templates_cover_select_join_and_cross_without_topology_change(self):
        cases = [
            (
                "SELECT_TOP",
                {
                    "readiness": "ANY",
                    "selection": "TOP_ONE",
                    "rankField": "rank",
                    "unselected": "DISCARD",
                },
                {"in": [{"id": "low", "rank": 1}, {"id": "high", "rank": 9}]},
                [{"id": "high", "rank": 9}],
            ),
            (
                "JOIN",
                {"readiness": "ALL_REQUIRED", "requiredInputs": ["left", "right"], "selection": "ONE_PER_INPUT"},
                {"left": [{"a": 1}], "right": [{"b": 2}]},
                [{"left": {"a": 1}, "right": {"b": 2}}],
            ),
            (
                "CROSS",
                {"readiness": "ALL_REQUIRED", "requiredInputs": ["left", "right"], "selection": "CROSS_ALL"},
                {"left": [{"v": "L1"}, {"v": "L2"}], "right": [{"v": "R1"}, {"v": "R2"}]},
                [
                    {"left": "L1", "right": "R1"},
                    {"left": "L1", "right": "R2"},
                    {"left": "L2", "right": "R1"},
                    {"left": "L2", "right": "R2"},
                ],
            ),
        ]

        for mode, policy, arrivals, expected in cases:
            with self.subTest(mode=mode):
                runtime = self.make_runtime()
                runtime.register_policy(f"{mode}@1", {**policy, "output": "EMIT_EACH"})

                def handler(batch, context, current_mode=mode):
                    if current_mode == "SELECT_TOP":
                        return {"out": batch["in"][0].payload}
                    if current_mode == "JOIN":
                        return {"out": {"left": batch["left"][0].payload, "right": batch["right"][0].payload}}
                    return {
                        "out": [
                            {
                                "payload": {
                                    "left": left.payload["v"],
                                    "right": right.payload["v"],
                                },
                                "tags": [],
                                "causationIds": [left.id, right.id],
                            }
                            for left, right in context["crossPairs"]
                        ]
                    }

                runtime.register_handler("policy-handler", handler)
                inputs = sorted(arrivals)
                runtime.register_graph_template(
                    {
                        "templateId": "flow@1",
                        "nodes": {
                            "strategy": {
                                "kind": "strategy",
                                "inputs": inputs,
                                "outputs": ["out"],
                                "policy": f"{mode}@1",
                                "handler": "policy-handler",
                            },
                            "sink": {"kind": "sink", "inputs": ["in"]},
                        },
                        "edges": [{"from": "strategy.out", "to": "sink.in", "operation": "PUSH"}],
                    }
                )
                before = runtime.graph_template_fingerprint("flow@1")
                graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
                arrival_ids = []
                arrival_ids_by_payload = {}
                for endpoint, payloads in arrivals.items():
                    for payload in payloads:
                        message_id = runtime.send(
                            graph_id,
                            f"strategy.{endpoint}",
                            MessageDraft.push(payload),
                        )
                        arrival_ids.append(message_id)
                        arrival_ids_by_payload[(endpoint, canonical(payload))] = message_id
                runtime.step(graph_id)
                runtime.drain(graph_id)

                output_messages = runtime.messages(graph_id, target_endpoint="sink.in")
                actual = [m.payload for m in output_messages]
                self.assertEqual(expected, actual)
                if mode == "CROSS":
                    for message in output_messages:
                        self.assertEqual(
                            frozenset(
                                {
                                    arrival_ids_by_payload[
                                        ("left", canonical({"v": message.payload["left"]}))
                                    ],
                                    arrival_ids_by_payload[
                                        ("right", canonical({"v": message.payload["right"]}))
                                    ],
                                }
                            ),
                            message.causation_ids,
                        )
                self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))
                snapshot = runtime.snapshot_container("workspace-1")
                self.assertNotIn("strategyCycles", snapshot)
                self.assertNotIn("inputBuffers", snapshot)
                self.assertNotIn("outputBuffers", snapshot)
                if mode == "SELECT_TOP":
                    self.assertTrue(
                        all(
                            runtime.message(message_id).delivery_state == "CONSUMED"
                            for message_id in arrival_ids
                        ),
                        "ONCE + DISCARD must not strand unselected messages",
                    )

    def test_07_close_is_an_authorized_message_and_waits_for_callback_and_drain(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "callee": {"kind": "sink", "inputs": ["in"]},
                    "resume": {"kind": "sink", "inputs": ["in"]},
                    "end": {"kind": "end", "inputs": ["in"]},
                },
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        call_id = runtime.call(graph_id, graph_id, "callee.in", {"work": 1}, "resume.in")
        runtime.drain(graph_id)
        self.assertEqual("WAITING", runtime.message(call_id).callback_state)

        before_count = len(runtime.messages(graph_id))
        with self.assertRaises(AuthorizationError):
            runtime.send(
                graph_id,
                "end.in",
                MessageDraft.push({}, tags={"control.graph.close"}),
                actor_id="ordinary-agent",
            )
        self.assertEqual(before_count, len(runtime.messages(graph_id)))

        close_id = runtime.send(
            graph_id,
            "end.in",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )
        self.assertEqual(0, runtime.step(graph_id))
        self.assertEqual("OPEN", runtime.graph_instance(graph_id).status)
        self.assertEqual("QUEUED", runtime.message(close_id).delivery_state)

        runtime.reply(graph_id, call_id, {"done": True})
        runtime.drain(graph_id)
        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)
        self.assertEqual("CONSUMED", runtime.message(close_id).delivery_state)
        with self.assertRaises(InvariantError):
            runtime.send(graph_id, "callee.in", MessageDraft.push({"late": True}))

    def test_08_strategy_can_translate_data_into_the_same_close_message_shape(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "stream@1",
            {"readiness": "ANY", "selection": "FIRST", "output": "EMIT_EACH"},
        )

        def close_handler(batch, context):
            return {"close": {"payload": {}, "tags": {"control.graph.close"}}}

        runtime.register_handler("close-handler", close_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "decider": {
                        "kind": "strategy",
                        "inputs": ["in"],
                        "outputs": ["close"],
                        "policy": "stream@1",
                        "handler": "close-handler",
                    },
                    "end": {"kind": "end", "inputs": ["in"]},
                },
                "edges": [{"from": "decider.close", "to": "end.in", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        runtime.send(graph_id, "decider.in", MessageDraft.push({"signal": "finished"}))
        runtime.drain(graph_id)

        close_messages = runtime.messages(graph_id, tag="control.graph.close")
        self.assertEqual(1, len(close_messages))
        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)

    def test_09_subflow_reuses_call_message_callback_lifecycle(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "nodes": {"resume": {"kind": "sink", "inputs": ["in"]}},
                "edges": [],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "nodes": {"entry": {"kind": "sink", "inputs": ["in"]}},
                "edges": [],
            }
        )
        parent_graph = runtime.create_graph_instance("workspace-1", "parent@1", "parent-1")
        child_graph = runtime.create_graph_instance(
            "workspace-1",
            "child@1",
            "child-1",
            parent_graph_instance_id=parent_graph,
        )

        call_id = runtime.call(
            parent_graph,
            child_graph,
            "entry.in",
            {"delegated": True},
            "resume.in",
        )
        runtime.drain(child_graph)
        self.assertEqual("WAITING", runtime.message(call_id).callback_state)
        reply_id = runtime.reply(child_graph, call_id, {"child": "done"})
        runtime.drain(parent_graph, child_graph)

        self.assertEqual("RESOLVED", runtime.message(call_id).callback_state)
        self.assertEqual(reply_id, runtime.message(call_id).reply_message_id)
        self.assertEqual([{"child": "done"}], [m.payload for m in runtime.messages(parent_graph, target_endpoint="resume.in")])
        snapshot = runtime.snapshot_container("workspace-1")
        self.assertNotIn("subflowContinuations", snapshot)

    def test_10_preexisting_queue_binding_does_not_freeze_queue_creation_timing(self):
        runtime = self.make_runtime()
        runtime.register_queue_template({"templateId": "jobs@1"})
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "queueSlots": {
                    "jobs": {"queueTemplateId": "jobs@1", "target": "worker.in"}
                },
                "nodes": {"worker": {"kind": "sink", "inputs": ["in"]}},
                "edges": [],
            }
        )
        queue_id = runtime.create_queue("workspace-1", "jobs@1", "jobs-1")
        before_queue_ids = [queue.id for queue in runtime.queues("workspace-1")]
        graph_id = runtime.create_graph_instance(
            "workspace-1",
            "flow@1",
            "graph-1",
            queue_bindings={"jobs": queue_id},
        )

        message_id = runtime.queue_send(graph_id, "jobs", {"job": 7})
        runtime.drain(graph_id)

        self.assertEqual([queue_id], before_queue_ids)
        self.assertEqual(before_queue_ids, [queue.id for queue in runtime.queues("workspace-1")])
        self.assertEqual(queue_id, runtime.message(message_id).queue_instance_id)
        self.assertEqual([{"job": 7}], [m.payload for m in runtime.messages(graph_id, target_endpoint="worker.in")])
        published = runtime.graph_template("flow@1")
        self.assertEqual("jobs@1", published["queueSlots"]["jobs"]["queueTemplateId"])
        self.assertNotIn("queueInstanceId", published["queueSlots"]["jobs"])

    def test_11_message_asset_slice_is_bounded_and_transient_context_is_per_round(self):
        runtime = self.make_runtime()
        runtime.register_asset("workspace-1", "asset-A", {"text": "A"})
        runtime.register_asset("workspace-1", "asset-B", {"text": "B"})

        def probe_agent(batch, context):
            saw_transient = "x" in context["transient"]
            context["transient"]["x"] = "must-not-survive"
            return {
                "out": {
                    "assetIds": list(context["messageAssetIds"]),
                    "sawTransientX": saw_transient,
                    "graphInstanceId": context["graphInstanceId"],
                }
            }

        runtime.register_handler("probe-agent", probe_agent)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "contextPolicy": {"maxMessageAssets": 1},
                "nodes": {
                    "agent": {
                        "kind": "agent",
                        "inputs": ["in"],
                        "outputs": ["out"],
                        "handler": "probe-agent",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [{"from": "agent.out", "to": "sink.in", "operation": "PUSH"}],
            }
        )
        first_graph = runtime.create_graph_instance(
            "workspace-1", "flow@1", "graph-A"
        )
        second_graph = runtime.create_graph_instance(
            "workspace-1", "flow@1", "graph-B"
        )

        runtime.send(
            first_graph,
            "agent.in",
            MessageDraft.push({"assetRefs": ["asset-A", "asset-B"]}),
        )
        runtime.send(
            second_graph,
            "agent.in",
            MessageDraft.push({"assetRefs": ["asset-B"]}),
        )
        runtime.drain(first_graph, second_graph)
        runtime.send(first_graph, "agent.in", MessageDraft.push({"assetRefs": []}))
        runtime.drain(first_graph)

        first_outputs = [m.payload for m in runtime.messages(first_graph, target_endpoint="sink.in")]
        second_outputs = [m.payload for m in runtime.messages(second_graph, target_endpoint="sink.in")]
        self.assertEqual(["asset-A"], first_outputs[0]["assetIds"])
        self.assertEqual(["asset-B"], second_outputs[0]["assetIds"])
        self.assertFalse(first_outputs[0]["sawTransientX"])
        self.assertFalse(second_outputs[0]["sawTransientX"])
        self.assertEqual([], first_outputs[1]["assetIds"])
        self.assertFalse(first_outputs[1]["sawTransientX"])

    def test_12_checkpoint_state_is_owned_by_checkpoint_node_instance(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "start": {"kind": "start", "inputs": ["in"], "outputs": ["out"]},
                    "checkpoint": {
                        "kind": "checkpoint",
                        "inputs": ["in"],
                        "outputs": ["out"],
                        "label": "loop-check",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [
                    {"from": "start.out", "to": "checkpoint.in", "operation": "PUSH"},
                    {"from": "checkpoint.out", "to": "sink.in", "operation": "PUSH"},
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        runtime.send(graph_id, "start.in", MessageDraft.push({"iteration": 3}))
        runtime.drain(graph_id)

        checkpoint = runtime.node_state(graph_id, "checkpoint")
        observed = runtime.message(
            checkpoint["checkpoint"]["lastObservedMessageId"]
        )
        self.assertEqual(3, observed.payload["iteration"])
        snapshot = runtime.snapshot_container("workspace-1")
        self.assertNotIn("checkpointRuns", snapshot)

    def test_13_context_head_is_fixed_at_instantiation_and_discovery_appends_to_instance_tail(self):
        runtime = self.make_runtime()
        for asset_id in ("system", "dynamic-A", "dynamic-B"):
            runtime.register_asset("workspace-1", asset_id, {"id": asset_id})

        def context_probe(batch, context):
            return {
                "out": {
                    "head": list(context["headAssetIds"]),
                    "tail": list(context["tailAssetIds"]),
                    "loaded": sorted(context["assets"]),
                }
            }

        runtime.register_handler("context-probe", context_probe)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "agent": {
                        "kind": "agent",
                        "inputs": ["in"],
                        "outputs": ["out"],
                        "handler": "context-probe",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [{"from": "agent.out", "to": "sink.in", "operation": "PUSH"}],
            }
        )
        before = runtime.graph_template_fingerprint("flow@1")
        first_graph = runtime.create_graph_instance(
            "workspace-1",
            "flow@1",
            "graph-A",
            context_head=["system"],
        )
        second_graph = runtime.create_graph_instance(
            "workspace-1",
            "flow@1",
            "graph-B",
            context_head=["system"],
        )
        runtime.append_context_tail(first_graph, "dynamic-A", actor_id="owner")
        runtime.append_context_tail(second_graph, "dynamic-B", actor_id="owner")
        with self.assertRaises(AuthorizationError):
            runtime.append_context_tail(first_graph, "dynamic-B", actor_id="task-agent")
        runtime.send(first_graph, "agent.in", MessageDraft.push({}))
        runtime.send(second_graph, "agent.in", MessageDraft.push({}))
        runtime.drain(first_graph, second_graph)

        first_output = runtime.messages(first_graph, target_endpoint="sink.in")[0].payload
        second_output = runtime.messages(second_graph, target_endpoint="sink.in")[0].payload
        self.assertEqual(
            {
                "head": ["system"],
                "tail": ["dynamic-A"],
                "loaded": ["dynamic-A", "system"],
            },
            first_output,
        )
        self.assertEqual(
            {
                "head": ["system"],
                "tail": ["dynamic-B"],
                "loaded": ["dynamic-B", "system"],
            },
            second_output,
        )
        self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))

    def test_14_stream_input_can_wait_for_all_required_outputs_inside_strategy_node(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "stream-wait-outputs@1",
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {
                    "mode": "WAIT_ALL",
                    "requiredOutputs": ["leftOut", "rightOut"],
                },
            },
        )

        def partial_output_handler(batch, context):
            message = next(iter(batch.values()))[0]
            endpoint = "leftOut" if message.payload["side"] == "L" else "rightOut"
            return {endpoint: {"value": message.payload["value"]}}

        runtime.register_handler("partial-output", partial_output_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "strategy": {
                        "kind": "strategy",
                        "inputs": ["in"],
                        "outputs": ["leftOut", "rightOut"],
                        "policy": "stream-wait-outputs@1",
                        "handler": "partial-output",
                    },
                    "leftSink": {"kind": "sink", "inputs": ["in"]},
                    "rightSink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [
                    {"from": "strategy.leftOut", "to": "leftSink.in", "operation": "PUSH"},
                    {"from": "strategy.rightOut", "to": "rightSink.in", "operation": "PUSH"},
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        left_input = runtime.send(
            graph_id,
            "strategy.in",
            MessageDraft.push({"side": "L", "value": 1}),
        )
        runtime.drain(graph_id)
        self.assertEqual([], runtime.messages(graph_id, target_endpoint="leftSink.in"))
        self.assertEqual([], runtime.messages(graph_id, target_endpoint="rightSink.in"))
        staged = runtime.node_state(graph_id, "strategy")["policyState"]["stagedOutputs"]
        self.assertEqual(["leftOut"], sorted(staged))

        right_input = runtime.send(
            graph_id,
            "strategy.in",
            MessageDraft.push({"side": "R", "value": 2}),
        )
        runtime.drain(graph_id)
        left_outputs = runtime.messages(graph_id, target_endpoint="leftSink.in")
        right_outputs = runtime.messages(graph_id, target_endpoint="rightSink.in")
        self.assertEqual([{"value": 1}], [m.payload for m in left_outputs])
        self.assertEqual([{"value": 2}], [m.payload for m in right_outputs])
        self.assertEqual(
            frozenset({left_input, right_input}),
            left_outputs[0].causation_ids,
        )
        self.assertEqual(
            frozenset({left_input, right_input}),
            right_outputs[0].causation_ids,
        )
        staged = runtime.node_state(graph_id, "strategy")["policyState"]["stagedOutputs"]
        self.assertEqual({}, staged)

    def test_15_output_cross_policy_expands_candidate_sets_without_creating_edges(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "output-cross@1",
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {
                    "mode": "CROSS",
                    "left": "leftCandidates",
                    "right": "rightCandidates",
                    "target": "out",
                },
            },
        )

        def candidates_handler(batch, context):
            return {
                "leftCandidates": [{"v": "L1"}, {"v": "L2"}],
                "rightCandidates": [{"v": "R1"}, {"v": "R2"}],
            }

        runtime.register_handler("candidate-output", candidates_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "strategy": {
                        "kind": "strategy",
                        "inputs": ["in"],
                        "outputs": ["leftCandidates", "rightCandidates", "out"],
                        "policy": "output-cross@1",
                        "handler": "candidate-output",
                    },
                    "sink": {"kind": "sink", "inputs": ["in"]},
                },
                "edges": [{"from": "strategy.out", "to": "sink.in", "operation": "PUSH"}],
            }
        )
        before = runtime.graph_template_fingerprint("flow@1")
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        runtime.send(graph_id, "strategy.in", MessageDraft.push({"go": True}))
        runtime.drain(graph_id)

        outputs = [m.payload for m in runtime.messages(graph_id, target_endpoint="sink.in")]
        self.assertEqual(
            [
                {"left": {"v": "L1"}, "right": {"v": "R1"}},
                {"left": {"v": "L1"}, "right": {"v": "R2"}},
                {"left": {"v": "L2"}, "right": {"v": "R1"}},
                {"left": {"v": "L2"}, "right": {"v": "R2"}},
            ],
            outputs,
        )
        self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))

    def test_16_public_ingress_cannot_forge_call_and_call_edges_require_reply_target(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {"node": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        with self.assertRaises(InvariantError):
            runtime.send(
                graph_id,
                "node.io",
                MessageDraft("CALL", {"forged": True}),
            )

        another = self.make_runtime()
        with self.assertRaises(InvariantError):
            another.register_graph_template(
                {
                    "templateId": "flow@1",
                    "nodes": {
                        "caller": {"kind": "ordinary", "endpoints": ["io"]},
                        "callee": {"kind": "sink", "endpoints": ["io"]},
                    },
                    "edges": [
                        {
                            "from": "caller.io",
                            "to": "callee.io",
                            "operation": "CALL",
                        }
                    ],
                }
            )

    def test_17_existing_queue_can_bind_after_graph_instantiation_without_auto_creation(self):
        runtime = self.make_runtime()
        runtime.register_queue_template({"templateId": "jobs@1"})
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "queueSlots": {
                    "jobs": {"queueTemplateId": "jobs@1", "target": "worker.io"}
                },
                "nodes": {"worker": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        queue_id = runtime.create_queue("workspace-1", "jobs@1", "jobs-existing")
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        with self.assertRaises(InvariantError):
            runtime.queue_send(graph_id, "jobs", {"job": "before-bind"})
        runtime.bind_queue(graph_id, "jobs", queue_id, actor_id="owner")
        message_id = runtime.queue_send(graph_id, "jobs", {"job": "after-bind"})
        runtime.drain(graph_id)

        self.assertEqual(queue_id, runtime.message(message_id).queue_instance_id)
        self.assertEqual(
            [queue_id],
            [queue.id for queue in runtime.queues("workspace-1")],
            "binding must not provision an implicit queue",
        )

    def test_18_cross_take_all_is_an_atomic_current_batch_not_hidden_history(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "cross-batch@1",
            {
                "readiness": "ALL_REQUIRED",
                "requiredInputs": ["left", "right"],
                "selection": "CROSS_ALL",
                "output": "EMIT_EACH",
            },
        )

        def cross_handler(batch, context):
            return {
                "out": [
                    {
                        "left": left.payload["v"],
                        "right": right.payload["v"],
                    }
                    for left, right in context["crossPairs"]
                ]
            }

        runtime.register_handler("cross-batch", cross_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "cross": {
                        "kind": "strategy",
                        "endpoints": ["left", "right", "out"],
                        "policy": "cross-batch@1",
                        "handler": "cross-batch",
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [{"from": "cross.out", "to": "sink.io", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        runtime.send(graph_id, "cross.left", MessageDraft.push({"v": "L1"}))
        self.assertEqual(0, runtime.step(graph_id))
        runtime.send(graph_id, "cross.right", MessageDraft.push({"v": "R1"}))
        runtime.drain(graph_id)
        runtime.send(graph_id, "cross.right", MessageDraft.push({"v": "R2"}))
        self.assertEqual(0, runtime.step(graph_id))
        runtime.send(graph_id, "cross.left", MessageDraft.push({"v": "L2"}))
        runtime.drain(graph_id)

        self.assertEqual(
            [
                {"left": "L1", "right": "R1"},
                {"left": "L2", "right": "R2"},
            ],
            [m.payload for m in runtime.messages(graph_id, target_endpoint="sink.io")],
        )

    def test_19_duplicate_close_messages_close_once_and_are_both_consumed(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {"end": {"kind": "end", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        first = runtime.send(
            graph_id,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )
        second = runtime.send(
            graph_id,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )

        runtime.drain(graph_id)

        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)
        self.assertEqual("CONSUMED", runtime.message(first).delivery_state)
        self.assertEqual("CONSUMED", runtime.message(second).delivery_state)

    def test_20_child_graph_cannot_claim_parent_graph_from_another_container(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "nodes": {"node": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "nodes": {"node": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        parent_graph = runtime.create_graph_instance(
            "workspace-1", "parent@1", "parent-1"
        )
        runtime.create_container("workspace@1", "workspace-2", owner_id="other-owner")

        with self.assertRaises(InvariantError):
            runtime.create_graph_instance(
                "workspace-2",
                "child@1",
                "invalid-child",
                parent_graph_instance_id=parent_graph,
            )

    def test_21_handlers_in_independent_node_instances_are_not_globally_serialized(self):
        runtime = self.make_runtime()
        entered = {"graph-A": threading.Event(), "graph-B": threading.Event()}
        release = threading.Event()
        claimed_states = {}

        def blocking_handler(batch, context):
            message = batch["io"][0]
            claimed_states[context["graphInstanceId"]] = runtime.message(
                message.id
            ).delivery_state
            entered[context["graphInstanceId"]].set()
            release.wait(2)
            return {"out": {"graphInstanceId": context["graphInstanceId"]}}

        runtime.register_handler("blocking", blocking_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "agent": {
                        "kind": "agent",
                        "endpoints": ["io", "out"],
                        "handler": "blocking",
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [{"from": "agent.out", "to": "sink.io", "operation": "PUSH"}],
            }
        )
        graph_a = runtime.create_graph_instance(
            "workspace-1", "flow@1", "graph-A"
        )
        graph_b = runtime.create_graph_instance(
            "workspace-1", "flow@1", "graph-B"
        )
        message_a = runtime.send(graph_a, "agent.io", MessageDraft.push({"v": "A"}))
        message_b = runtime.send(graph_b, "agent.io", MessageDraft.push({"v": "B"}))

        with ThreadPoolExecutor(max_workers=2) as pool:
            future_a = pool.submit(runtime.step, graph_a)
            future_b = pool.submit(runtime.step, graph_b)
            both_entered = entered["graph-A"].wait(1) and entered["graph-B"].wait(1)
            release.set()
            result_a = future_a.result(timeout=3)
            result_b = future_b.result(timeout=3)

        self.assertTrue(both_entered)
        self.assertEqual({"graph-A": "CLAIMED", "graph-B": "CLAIMED"}, claimed_states)
        self.assertEqual((1, 1), (result_a, result_b))
        self.assertEqual("CONSUMED", runtime.message(message_a).delivery_state)
        self.assertEqual("CONSUMED", runtime.message(message_b).delivery_state)

    def test_22_one_unified_endpoint_can_receive_push_call_reply_and_emit_on_an_edge(self):
        runtime = self.make_runtime()

        def bridge_handler(batch, context):
            message = batch["io"][0]
            return {
                "io": {
                    "seenOperation": message.operation,
                    "value": message.payload["value"],
                }
            }

        runtime.register_handler("bridge", bridge_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "bridge": {
                        "kind": "ordinary",
                        "endpoints": {
                            "io": {"accepts": ["PUSH", "CALL", "REPLY"]}
                        },
                        "handler": "bridge",
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [{"from": "bridge.io", "to": "sink.io", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        runtime.send(graph_id, "bridge.io", MessageDraft.push({"value": "push"}))
        call_id = runtime.call(
            graph_id,
            graph_id,
            "bridge.io",
            {"value": "call"},
            "bridge.io",
        )
        runtime.drain(graph_id)
        runtime.reply(graph_id, call_id, {"value": "reply"})
        runtime.drain(graph_id)

        self.assertEqual(
            ["PUSH", "CALL", "REPLY"],
            [
                message.payload["seenOperation"]
                for message in runtime.messages(graph_id, target_endpoint="sink.io")
            ],
        )

    def test_23_bound_subflow_node_uses_call_message_waiting_and_does_not_create_child(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "nodes": {
                    "delegate": {
                        "kind": "subflow",
                        "endpoints": ["in", "return", "out"],
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [{"from": "delegate.out", "to": "sink.io", "operation": "PUSH"}],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "nodes": {"entry": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        parent_graph = runtime.create_graph_instance("workspace-1", "parent@1", "parent-1")
        child_graph = runtime.create_graph_instance(
            "workspace-1", "child@1", "child-1", parent_graph_instance_id=parent_graph
        )
        runtime.bind_subflow(
            parent_graph,
            "delegate",
            child_graph,
            "entry.io",
            return_endpoint="delegate.return",
            actor_id="owner",
        )
        graph_count_before = len(runtime.snapshot_container("workspace-1")["graphs"])

        runtime.send(parent_graph, "delegate.in", MessageDraft.push({"work": 7}))
        runtime.step(parent_graph)
        calls = [
            message
            for message in runtime.messages(child_graph, target_endpoint="entry.io")
            if message.operation == "CALL"
        ]
        self.assertEqual(1, len(calls))
        self.assertEqual("WAITING", runtime.message(calls[0].id).callback_state)
        runtime.drain(child_graph)
        runtime.reply(child_graph, calls[0].id, {"result": 8})
        runtime.drain(parent_graph, child_graph)

        self.assertEqual("RESOLVED", runtime.message(calls[0].id).callback_state)
        self.assertEqual(
            [{"result": 8}],
            [m.payload for m in runtime.messages(parent_graph, target_endpoint="sink.io")],
        )
        snapshot = runtime.snapshot_container("workspace-1")
        self.assertEqual(graph_count_before, len(snapshot["graphs"]))
        self.assertNotIn("subflowContinuations", snapshot)

    def test_24_strategy_policy_fields_are_executable_contracts_not_decorative_json(self):
        invalid_policies = [
            {
                "readiness": "MAYBE",
                "selection": "FIRST",
            },
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "consume": "PEEK",
            },
            {
                "readiness": "ALL_REQUIRED",
                "selection": "ONE_PER_INPUT",
            },
            {
                "readiness": "ANY",
                "selection": "TOP_ONE",
                "trigger": "ONCE",
            },
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {"mode": "WAIT_ALL"},
            },
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {"mode": "CROSS", "left": "a"},
            },
        ]
        for index, policy in enumerate(invalid_policies):
            with self.subTest(index=index), self.assertRaises(InvariantError):
                runtime = self.make_runtime()
                runtime.register_policy(f"invalid-{index}@1", policy)

    def test_25_call_edge_creates_message_waiting_and_reply_reenters_unified_endpoint(self):
        runtime = self.make_runtime()

        def caller_handler(batch, context):
            endpoint, messages = next(iter(batch.items()))
            if endpoint == "reply":
                return {"result": {"answer": messages[0].payload["answer"]}}
            return {"request": {"question": messages[0].payload["question"]}}

        runtime.register_handler("caller", caller_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "caller": {
                        "kind": "ordinary",
                        "endpoints": ["trigger", "request", "reply", "result"],
                        "handler": "caller",
                    },
                    "callee": {"kind": "sink", "endpoints": ["io"]},
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [
                    {
                        "from": "caller.request",
                        "to": "callee.io",
                        "operation": "CALL",
                        "replyTarget": "caller.reply",
                    },
                    {
                        "from": "caller.result",
                        "to": "sink.io",
                        "operation": "PUSH",
                    },
                ],
            }
        )
        before = runtime.graph_template_fingerprint("flow@1")
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        runtime.send(
            graph_id,
            "caller.trigger",
            MessageDraft.push({"question": "meaning"}),
        )
        runtime.drain(graph_id)
        calls = [
            message
            for message in runtime.messages(graph_id, target_endpoint="callee.io")
            if message.operation == "CALL"
        ]
        self.assertEqual(1, len(calls))
        call = calls[0]
        self.assertEqual("caller.request", call.source_endpoint)
        self.assertEqual("CONSUMED", call.delivery_state)
        self.assertEqual("WAITING", call.callback_state)

        reply_id = runtime.reply(graph_id, call.id, {"answer": 42})
        runtime.drain(graph_id)

        self.assertEqual("RESOLVED", runtime.message(call.id).callback_state)
        self.assertEqual(call.id, runtime.message(reply_id).reply_to_message_id)
        self.assertEqual(
            [{"answer": 42}],
            [m.payload for m in runtime.messages(graph_id, target_endpoint="sink.io")],
        )
        self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))

    def test_26_checkpoint_observes_a_fixed_cycle_while_strategy_message_closes_it(self):
        runtime = self.make_runtime()
        runtime.register_policy(
            "loop-policy@1",
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": "EMIT_EACH",
            },
        )

        def loop_handler(batch, context):
            iteration = batch["in"][0].payload["iteration"]
            if iteration < 3:
                return {"loop": {"iteration": iteration + 1}}
            return {
                "close": {
                    "payload": {"lastIteration": iteration},
                    "tags": {"control.graph.close"},
                }
            }

        runtime.register_handler("loop-handler", loop_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "checkpoint": {
                        "kind": "checkpoint",
                        "endpoints": ["in", "out"],
                        "label": "loop-check",
                    },
                    "strategy": {
                        "kind": "strategy",
                        "endpoints": ["in", "loop", "close"],
                        "policy": "loop-policy@1",
                        "handler": "loop-handler",
                    },
                    "end": {"kind": "end", "endpoints": ["io"]},
                },
                "edges": [
                    {
                        "from": "checkpoint.out",
                        "to": "strategy.in",
                        "operation": "PUSH",
                    },
                    {
                        "from": "strategy.loop",
                        "to": "checkpoint.in",
                        "operation": "PUSH",
                    },
                    {
                        "from": "strategy.close",
                        "to": "end.io",
                        "operation": "PUSH",
                    },
                ],
            }
        )
        before = runtime.graph_template_fingerprint("flow@1")
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        runtime.send(
            graph_id,
            "checkpoint.in",
            MessageDraft.push({"iteration": 1}),
        )
        runtime.drain(graph_id)

        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)
        checkpoint_message_id = runtime.node_state(graph_id, "checkpoint")[
            "checkpoint"
        ]["lastObservedMessageId"]
        self.assertEqual(3, runtime.message(checkpoint_message_id).payload["iteration"])
        self.assertEqual(3, len(runtime.messages(graph_id, target_endpoint="checkpoint.in")))
        self.assertEqual(before, runtime.graph_template_fingerprint("flow@1"))

    def test_27_servo_can_edit_payload_but_cannot_forge_message_envelope(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "start": {"kind": "start", "endpoints": ["in", "out"]},
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                    "end": {"kind": "end", "endpoints": ["io"]},
                },
                "edges": [
                    {
                        "from": "start.out",
                        "to": "sink.io",
                        "operation": "PUSH",
                        "servo": {
                            "set": {
                                "operation": "CALL",
                                "targetEndpoint": "end.io",
                                "tags": ["control.graph.close"],
                            }
                        },
                    }
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        runtime.send(graph_id, "start.in", MessageDraft.push({"safe": True}))
        runtime.drain(graph_id)

        delivered = runtime.messages(graph_id, target_endpoint="sink.io")[0]
        self.assertEqual("PUSH", delivered.operation)
        self.assertEqual("sink.io", delivered.target_endpoint)
        self.assertEqual(frozenset(), delivered.tags)
        self.assertEqual("CALL", delivered.payload["operation"])
        self.assertEqual(["control.graph.close"], delivered.payload["tags"])
        self.assertEqual("OPEN", runtime.graph_instance(graph_id).status)

    def test_28_failed_commit_restores_claim_and_removes_partial_outputs(self):
        runtime = self.make_runtime()

        def produce(batch, context):
            return {"out": {"value": 1}}

        runtime.register_handler("produce", produce)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "producer": {
                        "kind": "ordinary",
                        "endpoints": ["in", "out"],
                        "handler": "produce",
                    },
                    "sinkA": {"kind": "sink", "endpoints": ["io"]},
                    "sinkB": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [
                    {
                        "from": "producer.out",
                        "to": "sinkA.io",
                        "operation": "PUSH",
                    },
                    {
                        "from": "producer.out",
                        "to": "sinkB.io",
                        "operation": "PUSH",
                        "servo": {"map": {"value": "missing"}},
                    },
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        input_id = runtime.send(graph_id, "producer.in", MessageDraft.push({"go": True}))

        with self.assertRaises(InvariantError):
            runtime.step(graph_id)

        self.assertEqual("QUEUED", runtime.message(input_id).delivery_state)
        self.assertEqual([], runtime.messages(graph_id, target_endpoint="sinkA.io"))
        self.assertEqual([], runtime.messages(graph_id, target_endpoint="sinkB.io"))

    def test_29_drain_waits_for_an_in_flight_node_claim_before_reporting_empty(self):
        runtime = self.make_runtime()
        entered = threading.Event()
        release = threading.Event()

        def blocking_handler(batch, context):
            entered.set()
            release.wait(2)
            return {"out": {"done": True}}

        runtime.register_handler("blocking-drain", blocking_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "agent": {
                        "kind": "agent",
                        "endpoints": ["in", "out"],
                        "handler": "blocking-drain",
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [{"from": "agent.out", "to": "sink.io", "operation": "PUSH"}],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        input_id = runtime.send(graph_id, "agent.in", MessageDraft.push({"go": True}))

        with ThreadPoolExecutor(max_workers=2) as pool:
            step_future = pool.submit(runtime.step, graph_id)
            self.assertTrue(entered.wait(1))
            self.assertEqual("CLAIMED", runtime.message(input_id).delivery_state)
            drain_future = pool.submit(runtime.drain, graph_id)
            with self.assertRaises(TimeoutError):
                drain_future.result(timeout=0.1)
            release.set()
            self.assertEqual(1, step_future.result(timeout=3))
            drain_future.result(timeout=3)

        self.assertEqual("CONSUMED", runtime.message(input_id).delivery_state)
        sink_messages = runtime.messages(graph_id, target_endpoint="sink.io")
        self.assertEqual([{"done": True}], [m.payload for m in sink_messages])
        self.assertEqual(["CONSUMED"], [m.delivery_state for m in sink_messages])

    def test_30_subflow_called_by_call_resolves_outer_call_instead_of_leaking_wait(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {"resume": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "nodes": {
                    "delegate": {
                        "kind": "subflow",
                        "endpoints": ["in", "return", "out"],
                    },
                    "localSink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [
                    {
                        "from": "delegate.out",
                        "to": "localSink.io",
                        "operation": "PUSH",
                    }
                ],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "nodes": {"entry": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        caller_graph = runtime.create_graph_instance("workspace-1", "flow@1", "caller")
        parent_graph = runtime.create_graph_instance("workspace-1", "parent@1", "parent")
        child_graph = runtime.create_graph_instance(
            "workspace-1", "child@1", "child", parent_graph_instance_id=parent_graph
        )
        runtime.bind_subflow(
            parent_graph,
            "delegate",
            child_graph,
            "entry.io",
            return_endpoint="delegate.return",
            actor_id="owner",
        )

        outer_call_id = runtime.call(
            caller_graph,
            parent_graph,
            "delegate.in",
            {"work": 1},
            "resume.io",
        )
        runtime.drain(parent_graph)
        child_calls = [
            message
            for message in runtime.messages(child_graph, target_endpoint="entry.io")
            if message.operation == "CALL"
        ]
        self.assertEqual(1, len(child_calls))
        runtime.drain(child_graph)
        runtime.reply(child_graph, child_calls[0].id, {"result": 2})
        runtime.drain(parent_graph, caller_graph)

        self.assertEqual("RESOLVED", runtime.message(outer_call_id).callback_state)
        self.assertEqual(
            [{"result": 2}],
            [m.payload for m in runtime.messages(caller_graph, target_endpoint="resume.io")],
        )
        self.assertEqual(
            [],
            runtime.messages(parent_graph, target_endpoint="localSink.io"),
            "a CALL into subflow must reply to its caller, not also emit a local PUSH",
        )

    def test_31_subflow_rechecks_prebound_child_is_open_before_creating_call(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "nodes": {
                    "delegate": {
                        "kind": "subflow",
                        "endpoints": ["in", "return", "out"],
                    }
                },
                "edges": [],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "entry": {"kind": "sink", "endpoints": ["io"]},
                    "end": {"kind": "end", "endpoints": ["io"]},
                },
                "edges": [],
            }
        )
        parent_graph = runtime.create_graph_instance("workspace-1", "parent@1", "parent")
        child_graph = runtime.create_graph_instance(
            "workspace-1", "child@1", "child", parent_graph_instance_id=parent_graph
        )
        runtime.bind_subflow(
            parent_graph,
            "delegate",
            child_graph,
            "entry.io",
            return_endpoint="delegate.return",
            actor_id="owner",
        )
        runtime.send(
            child_graph,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )
        runtime.drain(child_graph)
        input_id = runtime.send(
            parent_graph, "delegate.in", MessageDraft.push({"work": 1})
        )

        with self.assertRaises(InvariantError):
            runtime.step(parent_graph)

        self.assertEqual("QUEUED", runtime.message(input_id).delivery_state)
        self.assertEqual([], runtime.messages(child_graph, target_endpoint="entry.io"))

    def test_32_start_and_checkpoint_can_receive_and_emit_on_one_unified_endpoint(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "start": {"kind": "start", "endpoints": ["io"]},
                    "checkpoint": {
                        "kind": "checkpoint",
                        "endpoints": ["io"],
                    },
                    "sink": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [
                    {"from": "start.io", "to": "checkpoint.io", "operation": "PUSH"},
                    {"from": "checkpoint.io", "to": "sink.io", "operation": "PUSH"},
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        runtime.send(graph_id, "start.io", MessageDraft.push({"value": 7}))
        runtime.drain(graph_id)

        self.assertEqual(
            [{"value": 7}],
            [m.payload for m in runtime.messages(graph_id, target_endpoint="sink.io")],
        )
        observed_id = runtime.node_state(graph_id, "checkpoint")["checkpoint"][
            "lastObservedMessageId"
        ]
        self.assertEqual("checkpoint.io", runtime.message(observed_id).target_endpoint)

    def test_33_strategy_policy_endpoints_must_exist_on_the_bound_node(self):
        invalid_cases = [
            {
                "readiness": "ALL_REQUIRED",
                "requiredInputs": ["missing"],
                "selection": "ONE_PER_INPUT",
                "output": "EMIT_EACH",
            },
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {
                    "mode": "WAIT_ALL",
                    "requiredOutputs": ["ghost"],
                },
            },
            {
                "readiness": "ANY",
                "selection": "FIRST",
                "output": {
                    "mode": "CROSS",
                    "left": "left",
                    "right": "missing",
                    "target": "out",
                },
            },
        ]
        for index, policy in enumerate(invalid_cases):
            with self.subTest(index=index):
                runtime = self.make_runtime()
                runtime.register_policy("policy@1", policy)
                with self.assertRaises(InvariantError):
                    runtime.register_graph_template(
                        {
                            "templateId": "flow@1",
                            "nodes": {
                                "strategy": {
                                    "kind": "strategy",
                                    "endpoints": ["in", "left", "right", "out"],
                                    "policy": "policy@1",
                                    "handler": "not-needed-for-validation",
                                }
                            },
                            "edges": [],
                        }
                    )

    def test_34_end_rejects_data_messages_and_unknown_closure_modes(self):
        invalid = self.make_runtime()
        with self.assertRaises(InvariantError):
            invalid.register_graph_template(
                {
                    "templateId": "flow@1",
                    "closurePolicy": {
                        "tag": "control.graph.close",
                        "mode": "MAGIC",
                    },
                    "nodes": {"end": {"kind": "end", "endpoints": ["io"]}},
                    "edges": [],
                }
            )

        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {"end": {"kind": "end", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")

        with self.assertRaises(AuthorizationError):
            runtime.send(graph_id, "end.io", MessageDraft.push({"junk": True}))
        self.assertEqual([], runtime.messages(graph_id, target_endpoint="end.io"))
        runtime.send(
            graph_id,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )
        runtime.drain(graph_id)
        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)

    def test_35_one_node_rollback_cannot_detach_another_nodes_in_flight_message(self):
        runtime = self.make_runtime()
        a_entered = threading.Event()
        b_claimed = threading.Event()
        release_b = threading.Event()

        def failing_handler(batch, context):
            a_entered.set()
            self.assertTrue(b_claimed.wait(2))
            return {"out": {"value": "A"}}

        def successful_handler(batch, context):
            b_claimed.set()
            release_b.wait(2)
            return {"out": {"value": "B"}}

        runtime.register_handler("failing", failing_handler)
        runtime.register_handler("successful", successful_handler)
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "nodes": {
                    "nodeA": {
                        "kind": "ordinary",
                        "endpoints": ["in", "out"],
                        "handler": "failing",
                    },
                    "nodeB": {
                        "kind": "ordinary",
                        "endpoints": ["in", "out"],
                        "handler": "successful",
                    },
                    "sinkA": {"kind": "sink", "endpoints": ["io"]},
                    "sinkB": {"kind": "sink", "endpoints": ["io"]},
                },
                "edges": [
                    {"from": "nodeA.out", "to": "sinkA.io", "operation": "PUSH"},
                    {
                        "from": "nodeA.out",
                        "to": "sinkA.io",
                        "operation": "PUSH",
                        "servo": {"map": {"value": "missing"}},
                    },
                    {"from": "nodeB.out", "to": "sinkB.io", "operation": "PUSH"},
                ],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        a_id = runtime.send(graph_id, "nodeA.in", MessageDraft.push({"go": "A"}))
        b_id = runtime.send(graph_id, "nodeB.in", MessageDraft.push({"go": "B"}))

        with ThreadPoolExecutor(max_workers=2) as pool:
            a_future = pool.submit(runtime.step, graph_id)
            self.assertTrue(a_entered.wait(1))
            b_future = pool.submit(runtime.step, graph_id)
            with self.assertRaises(InvariantError):
                a_future.result(timeout=3)
            release_b.set()
            self.assertEqual(1, b_future.result(timeout=3))

        self.assertEqual("QUEUED", runtime.message(a_id).delivery_state)
        self.assertEqual("CONSUMED", runtime.message(b_id).delivery_state)
        self.assertEqual(
            [{"value": "B"}],
            [m.payload for m in runtime.messages(graph_id, target_endpoint="sinkB.io")],
        )

    def test_36_close_rechecks_drain_atomically_against_late_ingress(self):
        runtime = self.make_runtime()
        runtime.register_graph_template(
            {
                "templateId": "flow@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "nodes": {
                    "worker": {"kind": "sink", "endpoints": ["io"]},
                    "end": {"kind": "end", "endpoints": ["io"]},
                },
                "edges": [],
            }
        )
        graph_id = runtime.create_graph_instance("workspace-1", "flow@1", "graph-1")
        close_id = runtime.send(
            graph_id,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )

        end_claimed = threading.Event()
        release_end = threading.Event()
        original_execute = runtime._execute_claimed_node
        gate_used = False

        def gated_execute(
            current_graph_id,
            graph,
            template,
            node_id,
            node,
            selection,
        ):
            nonlocal gate_used
            if node.get("kind") == "end" and not gate_used:
                gate_used = True
                end_claimed.set()
                release_end.wait(2)
            return original_execute(
                current_graph_id,
                graph,
                template,
                node_id,
                node,
                selection,
            )

        runtime._execute_claimed_node = gated_execute
        with ThreadPoolExecutor(max_workers=1) as pool:
            close_future = pool.submit(runtime.step, graph_id)
            self.assertTrue(end_claimed.wait(1))
            late_id = runtime.send(
                graph_id,
                "worker.io",
                MessageDraft.push({"late": True}),
            )
            release_end.set()
            self.assertEqual(0, close_future.result(timeout=3))

        self.assertEqual("OPEN", runtime.graph_instance(graph_id).status)
        self.assertEqual("QUEUED", runtime.message(close_id).delivery_state)
        self.assertEqual("QUEUED", runtime.message(late_id).delivery_state)
        runtime.drain(graph_id)
        self.assertEqual("CLOSED", runtime.graph_instance(graph_id).status)
        self.assertEqual("CONSUMED", runtime.message(late_id).delivery_state)

    def test_37_closed_graph_rejects_owner_mutations_and_child_creation(self):
        runtime = self.make_runtime()
        runtime.register_queue_template({"templateId": "jobs@1"})
        runtime.register_asset("workspace-1", "asset-A", {"text": "A"})
        runtime.register_graph_template(
            {
                "templateId": "parent@1",
                "controllers": ["controller"],
                "closurePolicy": {"tag": "control.graph.close", "mode": "DRAIN"},
                "queueSlots": {
                    "jobs": {"queueTemplateId": "jobs@1", "target": "worker.io"}
                },
                "nodes": {
                    "worker": {"kind": "sink", "endpoints": ["io"]},
                    "end": {"kind": "end", "endpoints": ["io"]},
                },
                "edges": [],
            }
        )
        runtime.register_graph_template(
            {
                "templateId": "child@1",
                "nodes": {"entry": {"kind": "sink", "endpoints": ["io"]}},
                "edges": [],
            }
        )
        queue_id = runtime.create_queue("workspace-1", "jobs@1", "jobs-1")
        parent_graph = runtime.create_graph_instance(
            "workspace-1", "parent@1", "parent-1"
        )
        runtime.send(
            parent_graph,
            "end.io",
            MessageDraft.push({}, tags={"control.graph.close"}),
            actor_id="controller",
        )
        runtime.drain(parent_graph)
        self.assertEqual("CLOSED", runtime.graph_instance(parent_graph).status)

        with self.subTest(operation="create-child"):
            with self.assertRaises(InvariantError):
                runtime.create_graph_instance(
                    "workspace-1",
                    "child@1",
                    "child-after-close",
                    parent_graph_instance_id=parent_graph,
                )

        with self.subTest(operation="append-context-tail"):
            with self.assertRaises(InvariantError):
                runtime.append_context_tail(
                    parent_graph,
                    "asset-A",
                    actor_id="owner",
                )

        with self.subTest(operation="bind-queue"):
            with self.assertRaises(InvariantError):
                runtime.bind_queue(
                    parent_graph,
                    "jobs",
                    queue_id,
                    actor_id="owner",
                )


if __name__ == "__main__":
    unittest.main()
