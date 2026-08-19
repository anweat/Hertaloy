#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = 'D:/codeproject/Hertaloy';
const scan = JSON.parse(fs.readFileSync(path.join(root, '.understand-anything/intermediate/scan-result.json'), 'utf8'));
const graph = JSON.parse(fs.readFileSync(path.join(root, '.understand-anything/intermediate/assembled-graph.json'), 'utf8'));

const files = scan.files.map(f => f.path);
const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
const importEdges = graph.edges.filter(e => e.type === 'imports');
const importEdgeSet = new Set(importEdges.map(e => `${e.source}\u0000${e.target}`));

// Extract import specifiers from TypeScript/JS source.
function extractSpecifiers(content) {
  const specs = [];
  const re = /(?:^|\n|\s|;)(?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1] || m[2];
    if (spec && !spec.startsWith('node:') && !spec.startsWith('\0')) specs.push(spec);
  }
  return specs;
}

function tryResolveRelative(dir, spec) {
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [];
  if (path.posix.extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(base + '.ts', base + '.mjs', base + '.js', base + '/index.ts', base + '/index.mjs', base + '/index.js');
  }
  for (const c of candidates) {
    const p = c.replace(/\.js$/i, '.ts');
    if (files.includes(p)) return p;
    // NodeNext: .js -> .ts mapping
    if (p.endsWith('.ts') && files.includes(p)) return p;
  }
  // Try direct replacement of .js with .ts even when ext known
  if (path.posix.extname(base) === '.js') {
    const alt = base.slice(0, -3) + '.ts';
    if (files.includes(alt)) return alt;
  }
  return null;
}

function resolveSpecifier(sourcePath, spec) {
  const dir = path.posix.dirname(sourcePath);
  if (spec.startsWith('.')) return tryResolveRelative(dir, spec);
  if (spec.startsWith('@nodeflow/')) {
    const rest = spec.slice('@nodeflow/'.length); // e.g. "contracts" or "contracts/foo"
    const pkg = rest.split('/')[0];
    const sub = rest.slice(pkg.length).replace(/^\//, '');
    if (!sub) {
      const idx = `packages/${pkg}/src/index.ts`;
      if (files.includes(idx)) return idx;
    } else {
      const idx = `packages/${pkg}/src/${sub}`;
      const resolved = tryResolveRelative(`packages/${pkg}/src`, sub);
      if (resolved) return resolved;
      const idxTs = idx + '.ts';
      if (files.includes(idxTs)) return idxTs;
    }
    return null;
  }
  return null; // external/bare module
}

const actual = {};
const missing = [];
for (const file of files) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) continue;
  const ext = path.extname(file);
  if (!['.ts', '.mjs', '.js', '.tsx', '.mts', '.cts'].includes(ext)) continue;
  const content = fs.readFileSync(abs, 'utf8');
  const sourceId = `file:${file}`;
  const targets = [];
  for (const spec of extractSpecifiers(content)) {
    const resolved = resolveSpecifier(file, spec);
    if (!resolved) continue;
    const targetId = `file:${resolved}`;
    if (!nodeById.has(targetId)) {
      // Possibly target is config? imports should point to file nodes only in practice.
      console.error(`WARN target node missing for ${sourceId} -> ${resolved} (${spec})`);
      continue;
    }
    if (!targets.includes(targetId)) targets.push(targetId);
    if (!importEdgeSet.has(`${sourceId}\u0000${targetId}`)) {
      missing.push({ source: sourceId, target: targetId, spec, sourcePath: file });
    }
  }
  actual[file] = targets;
}

// Extra import edges in graph not found by source regex.
const expectedPairs = new Set();
for (const file of Object.keys(actual)) {
  for (const t of actual[file]) expectedPairs.add(`${file}\u0000${t.replace(/^file:/, '')}`);
}
const extra = [];
for (const e of importEdges) {
  const s = e.source.startsWith('file:') ? e.source.slice(5) : e.source;
  const t = e.target.startsWith('file:') ? e.target.slice(5) : e.target;
  if (!expectedPairs.has(`${s}\u0000${t}`)) {
    extra.push({ source: e.source, target: e.target });
  }
}

console.log(JSON.stringify({ actualImportCount: Object.values(actual).reduce((a, v) => a + v.length, 0), missing, extra, missingCount: missing.length, extraCount: extra.length }, null, 2));
