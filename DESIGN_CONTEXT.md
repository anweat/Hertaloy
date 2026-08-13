# Nodeflow Runtime V2 — Clean-Room Design Context

> Historical scope: this file constrains the V2 executable discussion only.
> The accepted conceptual direction after 2026-08-12 is documented in
> `CONTAINER_MODEL_V3.md`; protocol details remain under discussion in
> `PROTOCOL_WORKBENCH_V3.md`. V2 code must not be presented as a V3
> implementation.

This file is the only design context for the V2 convergence exercise. Earlier
runtime object proposals are not inputs unless a behavior test independently
proves them necessary.

## Product subject

Agent-oriented graph orchestration, organized only around these domains:

1. Message and message queue.
2. Node: ordinary, agent, strategy, endpoint/start/end/checkpoint, subflow, etc.
3. Container, template and instance.
4. Edge and Servo (simple JSON editing).
5. Asset library and context management.

GraphInstance is the only work-instance identity. Runtime behavior must not add
another nested run identity or disconnected execution subsystem beneath it.

## Confirmed constraints

- Runtime never mutates graph topology.
- A graph definition is a template and may create multiple independent graph
  instances.
- A GraphInstance is created directly in OPEN state. It owns its node-instance
  state, context, queue bindings and node concurrency locks. A child
  GraphInstance records its owning relation as `parentGraphInstanceId`. CLOSED
  is terminal: the instance cannot accept work, configuration mutation or new
  owned children.
- Messages and runtime commands address the exact GraphInstance; there is no
  subordinate run identity between a GraphInstance and its node instances.
- A container is created from a template. The creating/owning container manages
  its instance objects, while each GraphInstance owns its mutable graph context.
  Observable outputs remain messages or registered assets, not a second
  container-owned output-state subsystem.
- A Servo is a small, deterministic JSON edit/transform.
- Nodes expose a variable number of unified endpoints. Runtime message
  semantics may still distinguish PUSH/CALL/REPLY or equivalent operations.
- A message that expects a callback must instantiate durable waiting state, but
  that state must belong to the message/message-queue model. Do not create a
  disconnected top-level WaitInstance abstraction.
- Whether QueueInstance may be created during runtime is intentionally open.
- Strategy behavior is composed from input and output policies: wait for all,
  process incrementally, select some, join/cross inputs or outputs, etc. Common
  combinations may be templates. Atomic selection/consumption needs locking.
- Closing a GraphInstance may be produced by a Strategy converting a signal,
  or by authorized upper-level agents emitting a uniform message/tag. Control
  should be open to composition through typed messages, not direct topology
  mutation.
- Agent context is rebuilt per invocation/round; hidden conversation history is
  not durable orchestration state.
- Context refs resolved before GraphInstance creation form the invocation head;
  owner-approved refs discovered after creation append to that instance's
  context tail. Head/tail belong to that GraphInstance, not template mutable
  state, another GraphInstance or a shared Agent session.
- Failure, fallback, retry, timeout and broker ACK/lease are not the first
  design target. First close the normal runtime chain.

## Rejected / prohibited starting abstractions

- No standalone WaitInstance, CallContinuation, AwaitGroup or similarly orphaned
  callback subsystem as a starting point.
- No proliferation of Route/Handler or other binding objects before a test
  demonstrates separate lifecycles or ownership.
- No separate StrategyCycle, InputBuffer or OutputBuffer table merely because
  the terms exist; first try to represent them with node-instance-owned message
  collections and policy state.
- No runtime Agent ability to create or mutate graph nodes, edges, templates or
  privileged orchestration facilities.
- No state enum whose transition is not exercised by a normal-path test.

## Required behavioral scenarios

1. PUSH traverses immutable edge(s), Servo edits JSON, downstream node consumes.
2. A callback-capable message is instantiated, becomes waiting inside the
   message domain, receives a correlated reply, and wakes/reroutes work.
3. Strategy waits for all required endpoints and runs once atomically.
4. Strategy processes messages incrementally (some arrive, some compute).
5. Strategy selects, joins or crosses inputs/outputs according to a reusable
   policy template without changing topology.
6. A close control tag/message is produced by a Strategy or authorized upper
   controller and the target GraphInstance closes only when its policy allows.
7. A subflow/child graph instance receives a message and returns via callback
   using the same message semantics.
8. Queue binding works with a pre-existing QueueInstance, while runtime queue
   creation/provision policy remains an unresolved design choice.
9. Assets are referenced, selected and loaded into a per-round context whose
   message asset slice is bounded; the total context budget remains open. Two
   GraphInstances sharing an Agent template do not share mutable context.

## Test question

For every proposed persisted object or status ask:

> Which required scenario cannot be expressed correctly without this state?

If no scenario answers the question, delete or derive it.
