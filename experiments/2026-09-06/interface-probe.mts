/** Isolated interface experiments. No model API, credentials, or existing run is used. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { RunState, exportSnapshot, writePermissions } from '../../packages/state/src/index.ts';
import { BUILTIN_HANDLERS, init, drain, status, truncate, validate, why } from '../../packages/cli/src/index.ts';
import { templates } from '../../packages/cli/src/state-commands.ts';
import { TOOLS } from '../../packages/mcp/src/tools.ts';
import { listen } from '../../packages/cli/src/serve.ts';
import { checkAgentSpec, SandboxBackend, WslRunner } from '../../packages/sandbox/src/index.ts';
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from '../../packages/contracts/src/index.ts';
import { lastSegment } from '../../packages/contracts/src/index.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(join(tmpdir(), 'hertaloy-interface-probe-'));
const selected = process.argv[2];
if (selected && !/^(0[1-9]|10|11)$/.test(selected)) throw new Error('Experiment prefix must be 01..11');
const HUMAN = { kind: 'human', id: 'probe' } as const;
const results: { name: string; observed?: unknown; experimentError?: string }[] = [];
const recv = { direction: 'receive' };
const node = (handler = 'noop') => ({ kind: 'handler', handler, ports: { in: recv } });
const simple = { nodes: { work: node() }, edges: {}, children: {} };
const directory = (name: string) => join(root, name);
function state<T>(dir: string, f: (s: RunState) => T, readonly = false, options: Parameters<typeof RunState.open>[1] = {}): T {
  const s = RunState.open(dir, { readOnly: readonly, validateExecutionSpec: checkAgentSpec, ...options });
  try { const out = f(s); if (!readonly) s.persist(); return out; } finally { s.close(); }
}
function tool(dir: string, name: string, args: Record<string, unknown> = {}) {
  const t = TOOLS.find(t => t.name === name)!;
  return t.handler({ dir, actor: HUMAN }, t.schema.parse(args));
}
function rejection(f: () => unknown) { try { f(); return null; } catch (e) { return String(e); } }
async function probe(name: string, f: () => unknown | Promise<unknown>) {
  if (selected && !name.startsWith(selected) && !(['08', '10'].includes(selected) && name.startsWith('03'))) return;
  try { results.push({ name, observed: await f() }); console.log(`OBSERVED ${name}`); }
  catch (e) { results.push({ name, experimentError: String(e) }); console.error(`EXPERIMENT ERROR ${name}: ${e}`); }
}
const agentSpec = {
  nodes: {
    worker: { kind: 'handler', agent: { argv: ['true'] }, ports: {
      in: { direction: 'receive', servo: { vars: { value: { type: 'short', from: '$.value' } } } },
      out: { direction: 'emit' },
    } },
    sink: node(),
  },
  edges: { next: { from: { node: 'worker', port: 'out' }, to: { node: 'sink', port: 'in' } } },
};
function createAgentRun(dir: string) {
  const r = init(dir, HUMAN, { templates: [{ id: 'root', kind: 'root_config', spec: agentSpec }],
    root: { template: 'root', id: 'job' }, send: [{ instance: "job/worker", port: 'in', payload: { value: 7 } }] });
  assert.equal(r.code, 0, r.text);
}
const done = (r: ExecutionRequest): ExecutionResult => ({ executionId: r.executionId, termination: 'DONE', emissions: { out: { value: 7 } } });

await probe('01-template-library-and-version-pinning', () => {
  const dir = directory('versions');
  const defined = tool(dir, 'define_template', { id: 'worker', spec: simple });
  assert.equal(defined.isError, false);
  const beforeRoot = templates(dir, HUMAN).data;
  const savedBeforeRoot = tool(dir, 'read_object', { ref: 'worker@1' });
  assert.equal(savedBeforeRoot.isError, false);
  const pinning = state(dir, s => {
    const rootSpec = { children: { workers: { template: 'worker@1' } } };
    const root1 = s.control.define(HUMAN, 'root', rootSpec, 'root_config');
    s.registry.createRoot(root1, 'job');
    const first = s.control.spawn(HUMAN, 'job', 'workers', 'before');
    const v2 = s.control.define(HUMAN, 'worker', { nodes: { work: node('echo') } });
    const root2 = s.control.define(HUMAN, 'root', { children: { workers: { template: v2 } } }, 'root_config');
    const later = s.control.spawn(HUMAN, 'job', 'workers', 'after');
    const overlay = s.control.define(HUMAN, 'worker-variant', { extends: v2, override: { 'nodes/work/handler': 'noop' } });
    assert.equal(first.templateRef, 'worker@1');
    assert.equal(later.templateRef, 'worker@1');
    assert.equal(s.registry.get('job').templateRef, root1);
    return { rootPinned: root1, rootHead: root2, firstChild: first.templateRef, laterChild: later.templateRef,
      workerHead: v2, overlay: s.store.resolve(overlay), secondRoot: rejection(() => s.registry.createRoot(root2, 'job2')) };
  });
  return { defined, savedWithoutRun: !savedBeforeRoot.isError, templatesBeforeRoot: beforeRoot,
    templatesAfterRoot: Object.keys(templates(dir, HUMAN).data as object), pinning,
    recovered: state(dir, s => ({ root: s.registry.get('job').templateRef, child: s.registry.get('job/after').templateRef }), true) };
});

await probe('02-validation-and-adapter-parity', () => {
  const missing = { children: { workers: { template: 'missing@1' } } };
  const invalidAgent = { nodes: { worker: { kind: 'handler', agent: { argv: ['true'], workspace: { source: 123 } }, ports: { in: recv } } } };
  const unknownHandler = { nodes: { worker: node('not_registered') } };
  const dir = directory('validation');
  const missingDefine = tool(dir, 'define_template', { id: 'missing-parent', spec: missing });
  const missingSpawn = state(dir, s => rejection(() => {
    s.registry.createRoot('missing-parent@1', 'job'); s.control.spawn(HUMAN, 'job', 'workers', 'child');
  }));
  return {
    missingDependency: { validate: validate(missing), define: missingDefine, spawn: missingSpawn,
      withEntry: tool(dir, 'define_template', { id: 'missing-with-entry', spec: { children: { workers: { template: 'missing@1', entry: { node: 'work', port: 'in' } } } } }) },
    invalidAgent: { validate: validate(invalidAgent), mcpDefine: tool(dir, 'define_template', { id: 'invalid-agent', spec: invalidAgent }),
      checkedDefine: state(directory('checked-define'), s => rejection(() => s.control.define(HUMAN, 'invalid-agent', invalidAgent))) },
    unknownHandler: { validate: validate(unknownHandler), define: tool(dir, 'define_template', { id: 'unknown-handler', spec: unknownHandler }) },
    malformedOverlay: validate({ extends: 'missing@1', override: { 'bad//path': 123 } }),
  };
});

await probe('03-aggregation-causality-and-read-model', async () => {
  const dir = directory('aggregate');
  const scenario = JSON.parse(readFileSync(join(repo, 'examples/aggregate.json'), 'utf8'));
  assert.equal(init(dir, HUMAN, scenario).code, 0);
  const before = status(dir, HUMAN).data;
  const run = await drain(dir, HUMAN);
  assert.equal(run.code, 0, run.text);
  const detail = state(dir, s => {
    const messages = s.runtime.messages();
    const output = messages.find(m => lastSegment(m.target.instance) === 'sink')!;
    const snapshots = s.runtime.snapshots('job-1');
    return { outputMessage: output, causes: s.control.causesOf(HUMAN, 'job-1', output.id),
      snapshots, objects: s.store.appended(0).map(v => ({ id: v.object_id, version: v.version, kind: v.kind })),
      projection: exportSnapshot(s, HUMAN) };
  }, true);
  return { before, run, after: status(dir, HUMAN).data, detail, why: why(dir, HUMAN, detail.outputMessage.id) };
});

await probe('04-request-reply-versus-ordinary-callback-send', () => state(directory('request'), s => {
  const asker = { nodes: { work: { kind: 'handler', handler: 'ask', ports: {
    start: { direction: 'receive', servo: { vars: { q: { type: 'short', from: '$.q' } } } },
    ask: { direction: 'emit', alias: 'service', callback: 'got', unavailable: { a: 'unavailable' } },
    got: { direction: 'receive', servo: { vars: { a: { type: 'short', from: '$.a' } } } },
  } } } };
  const service = { nodes: { serve: { kind: 'handler', handler: 'serve', ports: {
    inbox: { direction: 'receive', servo: { vars: { q: { type: 'short', from: '$.q' } } } },
    answer: { direction: 'emit', reply: true },
  } } } };
  const a = s.control.define(HUMAN, 'asker', asker), b = s.control.define(HUMAN, 'service', service);
  const r = s.control.define(HUMAN, 'root', { children: { askers: { template: a }, services: { template: b } },
    bindings: [{ alias: 'service', slot: 'services', node: 'serve', port: 'inbox' }] }, 'root_config');
  s.registry.createRoot(r, 'job');
  s.control.spawn(HUMAN, 'job', 'askers', 'asker'); s.control.spawn(HUMAN, 'job', 'services', 'service');
  s.runtime.registerHandler('ask', (vars, ctx) => ctx.port === 'start' ? { ask: { q: vars.q ?? null } } : {});
  s.runtime.registerHandler('serve', vars => ({ answer: { a: `answer:${vars.q}` } }));
  s.control.send(HUMAN, { instance: "job/asker/work", port: 'start' }, { q: 'probe' });
  const requestStep = s.runtime.step();
  const before = s.control.locks(HUMAN, 'job/asker');
  assert.equal(before.filter(l => l.kind === 'request').length, 1);
  const manual = s.control.send(HUMAN, { instance: "job/asker/work", port: 'got' }, { a: 'human supplied' });
  const afterOrdinarySend = s.control.locks(HUMAN, 'job/asker');
  assert.equal(afterOrdinarySend.filter(l => l.kind === 'request').length, 1);
  const manualStep = s.runtime.step();
  const afterManualConsumed = s.control.locks(HUMAN, 'job/asker');
  assert.equal(s.runtime.message(manual).state, 'CONSUMED');
  assert.equal(afterManualConsumed.filter(l => l.kind === 'request').length, 1);
  const replyStep = s.runtime.step();
  const afterReply = s.control.locks(HUMAN, 'job/asker');
  assert.equal(afterReply.filter(l => l.kind === 'request').length, 0);
  return { requestStep, before, manual, afterOrdinarySend, manualStep, afterManualConsumed, replyStep, afterReply, pending: s.runtime.pending() };
}, false, { scheduler: candidates => candidates.find(c => c.message.target.port === 'got') ?? candidates[0] ?? null }));

await probe('05-execution-persistence-and-late-result-fence', async () => {
  const dir = directory('fence'); createAgentRun(dir);
  let release!: (r: ExecutionResult) => void;
  let request!: ExecutionRequest;
  let cancels = 0;
  const backend: ExecutionBackend = { run: r => { request = r; return new Promise(resolve => { release = resolve; }); }, cancel: async () => { cancels++; } };
  const running = drain(dir, HUMAN, backend);
  assert.ok(request, 'drain reaches backend synchronously before first await');
  const during = status(dir, HUMAN).data;
  const cut = truncate(dir, HUMAN, 'job', 'isolated late-result experiment');
  const afterCut = status(dir, HUMAN).data;
  release(done(request));
  const returned = await running;
  const stateAfter = state(dir, s => ({ messages: s.runtime.messages(), records: s.runtime.records(), snapshot: exportSnapshot(s, HUMAN) }), true);
  assert.equal(stateAfter.messages.filter(m => lastSegment(m.target.instance) === 'sink').length, 0);
  return { request, during, cut, afterCut, backendCancelCalls: cancels, returned, stateAfter };
});

await probe('06-two-drivers-on-one-run', async () => {
  const dir = directory('two-drivers'); createAgentRun(dir);
  const requests: ExecutionRequest[] = [];
  const releases: (() => void)[] = [];
  const backend: ExecutionBackend = { run: r => { requests.push(r); return new Promise(resolve => releases.push(() => resolve(done(r)))); }, cancel: async () => {} };
  const a = drain(dir, HUMAN, backend);
  const b = drain(dir, HUMAN, backend);
  const during = status(dir, HUMAN).data;
  const startedBeforeAnyResult = requests.map(r => r.executionId);
  const raw = state(dir, s => s.runtime.records(), true);
  // Finish every bounded fake execution, including a retry caused by the competing driver.
  let stopped = false; const pump = setInterval(() => { for (const release of releases.splice(0)) release(); }, 10);
  try {
    const commands = await Promise.all([a, b]); stopped = true;
    return { startedBeforeAnyResult, during, raw, commands, requests: requests.map(r => r.executionId) };
  } finally { clearInterval(pump); assert.ok(stopped); }
});

await probe('07-run-scope-is-authorization-not-scheduling', () => {
  const dir = directory('scope');
  state(dir, s => {
    const leaf = s.control.define(HUMAN, 'leaf', simple);
    const r = s.control.define(HUMAN, 'root', { children: { workers: { template: leaf } } }, 'root_config');
    s.registry.createRoot(r, 'job');
    for (const id of ['a', 'b']) { s.control.spawn(HUMAN, 'job', 'workers', id); s.control.send(HUMAN, { instance: `job/${id}/work`, port: 'in' }, {}); }
  });
  writePermissions(dir, [{ principal: 'agent:branch-a', scope: 'job/a', ops: ['DML', 'DQL'] }]);
  return state(dir, s => {
    for (const [name, handler] of Object.entries(BUILTIN_HANDLERS)) s.runtime.registerHandler(name, handler);
    const steps = s.control.run({ kind: 'agent', id: 'branch-a' }, 'job/a');
    return { requestedScope: 'job/a', executedScopes: steps.map(step => step.traceid) };
  });
});

await probe('08-http-current-surface', async () => {
  const server = await listen({ dir: directory('aggregate'), actor: HUMAN, port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port()}`;
    const observations = [];
    for (const [method, path, authorized] of [['GET','/scene',false], ['GET','/scene',true], ['GET','/templates',true],
      ['GET','/api/snapshot',true], ['GET','/api/object/job-1',true], ['POST','/send',true]] as const) {
      const r = await fetch(base + path, { method, headers: authorized ? { 'x-hertaloy-token': server.token } : {} });
      const body = await r.json();
      observations.push({ method, path, authorized, status: r.status, keys: Object.keys(body) });
    }
    return observations;
  } finally { await server.close(); }
});

await probe('09-real-wsl-execution-through-cli-driver', async () => {
  const dir = directory('wsl');
  const trace = 'probe-' + root.slice(root.lastIndexOf('-') + 1).toLowerCase();
  const spec = structuredClone(agentSpec);
  spec.nodes.worker.agent.argv = ['sh', '-c', `printf '%s' '{"out":{"value":"from Linux"}}' > ../.hertaloy/emit.json; printf '%s' 'probe output' > result.txt`];
  assert.equal(init(dir, HUMAN, { templates: [{ id: 'root', kind: 'root_config', spec }], root: { template: 'root', id: trace },
    send: [{ instance: `${trace}/worker`, port: 'in', payload: { value: 'probe' } }] }).code, 0);
  const backend = new SandboxBackend({ runner: new WslRunner(), retain: 'never' });
  const command = await drain(dir, HUMAN, backend);
  const details = state(dir, s => ({ status: s.registry.get(trace), records: s.runtime.records(),
    execution: s.store.history(`${trace}/$exec`), messages: s.runtime.messages() }), true);
  assert.equal(command.code, 0, command.text);
  assert.equal(details.status.status, 'TERMINAL');
  return { command, details };
});

await probe('10-mcp-stdio-real-transport', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/mcp/src/server.ts', '--dir', directory('aggregate')], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', stderr = '', id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  child.stderr.on('data', b => { stderr += b.toString(); });
  child.stdout.on('data', b => { buf += b.toString(); const lines = buf.split('\n'); buf = lines.pop()!;
    for (const line of lines.filter(Boolean)) { const msg = JSON.parse(line); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
  });
  const timer = setTimeout(() => { for (const p of pending.values()) p.reject(new Error('MCP transport timeout: ' + stderr)); child.kill(); }, 20000);
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const rid = ++id; pending.set(rid, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hertaloy-interface-probe', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list');
    const status = await request('tools/call', { name: 'get_status', arguments: {} });
    assert.equal(list.tools.length, 11);
    return { initialized, toolNames: list.tools.map((t: any) => t.name), status, stderr };
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
});

await probe('11-message-retention-versus-replay', () => state(directory('retention'), s => {
  const spec = { nodes: {
    echo: { kind: 'handler', handler: 'echo', ports: { in: { direction: 'receive', servo: { vars: { value: { type: 'short', from: '$.value' } } } }, out: { direction: 'emit' } } },
    sink: node(),
  }, edges: { e: { from: { node: 'echo', port: 'out' }, to: { node: 'sink', port: 'in' } } } };
  const ref = s.control.define(HUMAN, 'root', spec, 'root_config'); s.registry.createRoot(ref, 'job');
  for (const [name, handler] of Object.entries(BUILTIN_HANDLERS)) s.runtime.registerHandler(name, handler);
  for (let i = 0; i < 600; i++) { s.control.send(HUMAN, { instance: "job/echo", port: 'in' }, { value: `input-${i}` }); s.control.run(HUMAN, 'job'); }
  return { sent: 600, produced: 600, retainedMessages: s.runtime.messages().length,
    firstMessage: rejection(() => s.runtime.message('msg-1')), oldOutputCauses: s.control.causesOf(HUMAN, 'job', 'msg-2'),
    firstCommit: s.runtime.snapshots('job')[0], snapshotCount: s.runtime.snapshots('job').length };
}));

const output = join(dirname(fileURLToPath(import.meta.url)), selected ? `results-${selected}.json` : 'results.json');
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  runtime: process.version, stateRoot: root, modelCalls: 0, results }, null, 2) + '\n');
console.log(`Results: ${output}`);
console.log(`Isolated state: ${root}`);
if (results.some(r => r.experimentError)) process.exitCode = 1;
