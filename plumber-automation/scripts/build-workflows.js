#!/usr/bin/env node
'use strict';

/**
 * Generates workflows/*.json from workflows/src/*.js.
 *
 *   npm run build:workflows
 *
 * The JSON files are committed — those are what you import into n8n
 * (Workflows -> Import from File). Edit the .js, re-run this, commit both.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'workflows', 'src');
const OUT = path.join(__dirname, '..', 'workflows');

const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .sort();

let failed = 0;

for (const file of files) {
  const outName = file.replace(/\.js$/, '.json');
  try {
    delete require.cache[path.join(SRC, file)];
    const wf = require(path.join(SRC, file));

    if (!wf.name || !Array.isArray(wf.nodes)) {
      throw new Error('module did not export a workflow object');
    }

    // Every wire must point at a node that exists — a typo here imports into
    // n8n as a silently disconnected node, which is miserable to debug.
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, targets] of Object.entries(wf.connections)) {
      if (!names.has(from)) throw new Error(`connection from unknown node "${from}"`);
      for (const output of targets.main) {
        for (const t of output) {
          if (!names.has(t.node)) throw new Error(`connection to unknown node "${t.node}"`);
        }
      }
    }

    // n8n only evaluates {{ }} in a parameter whose value starts with "=".
    // Without the prefix the placeholder is sent to Postgres verbatim, which
    // fails at runtime in a way that is genuinely hard to spot in the editor.
    for (const n of wf.nodes) {
      for (const [param, value] of Object.entries(n.parameters || {})) {
        if (typeof value === 'string' && value.includes('{{') && !value.startsWith('=')) {
          throw new Error(
            `node "${n.name}" has an unevaluated expression in "${param}" — it needs an "=" prefix`
          );
        }
      }
    }

    fs.writeFileSync(path.join(OUT, outName), JSON.stringify(wf, null, 2) + '\n');
    console.log(`  ✓ ${outName.padEnd(34)} ${String(wf.nodes.length).padStart(2)} nodes`);
  } catch (err) {
    console.error(`  ✗ ${outName}: ${err.message}`);
    failed += 1;
  }
}

console.log(failed ? `\n${failed} workflow(s) failed to build` : `\n${files.length} workflows built`);
process.exit(failed ? 1 : 0);
