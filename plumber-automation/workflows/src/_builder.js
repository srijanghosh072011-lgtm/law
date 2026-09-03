'use strict';

/**
 * Small helpers for describing n8n workflows in readable JavaScript.
 *
 * WHY NOT HAND-WRITE THE JSON?
 * An n8n workflow file is a flat node list plus a separate connection map,
 * with JavaScript embedded as escaped strings. Hand-editing that is miserable
 * and easy to get subtly wrong. Here you write the nodes in order, list the
 * wires by name, and `npm run build:workflows` emits valid JSON.
 *
 * The generated .json files ARE committed — you import those into n8n
 * directly. This layer is for editing, not a runtime dependency.
 */

const crypto = require('node:crypto');

/** Stable id from the node name, so regenerating doesn't churn the diff. */
const idFor = (workflow, name) =>
  crypto.createHash('sha1').update(`${workflow}:${name}`).digest('hex').slice(0, 32);

/**
 * Lay nodes out left-to-right so the imported workflow is readable on the
 * canvas instead of a pile at the origin.
 */
const GRID_X = 260;
const GRID_Y = 190;

function node(name, type, parameters, opts = {}) {
  return { name, type, parameters, ...opts };
}

// --- node constructors ----------------------------------------------------

const webhook = (name, path, opts = {}) =>
  node(name, 'n8n-nodes-base.webhook', {
    httpMethod: opts.method || 'POST',
    path,
    responseMode: opts.responseMode || 'responseNode',
    options: {},
  }, { typeVersion: 2, webhookPath: path });

const schedule = (name, cronExpression) =>
  node(name, 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: cronExpression }] },
  }, { typeVersion: 1.2 });

const code = (name, jsCode) =>
  node(name, 'n8n-nodes-base.code', { jsCode }, { typeVersion: 2 });

/** Runs the code once per incoming item instead of once for the whole batch. */
const codeEachItem = (name, jsCode) =>
  node(name, 'n8n-nodes-base.code', { mode: 'runOnceForEachItem', jsCode }, { typeVersion: 2 });

/**
 * A raw SQL node.
 *
 * NOTE ON THE `=` PREFIX: n8n treats a parameter value as a literal string
 * unless it begins with "=", which marks it as an expression. Without that,
 * every `{{ $json.x }}` in a query would be sent to Postgres verbatim. So any
 * query containing an expression gets the prefix automatically.
 */
const postgres = (name, query, opts = {}) =>
  node(name, 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: query.includes('{{') ? `=${query}` : query,
    options: opts.alwaysOutputData ? { queryBatching: 'single' } : {},
  }, {
    typeVersion: 2.5,
    credentials: { postgres: { id: 'plumber-postgres', name: 'Plumber Postgres' } },
    alwaysOutputData: opts.alwaysOutputData ?? true,
  });

/**
 * A boolean branch. `condition` is an n8n expression string that evaluates
 * truthy/falsy; output 0 is true, output 1 is false.
 */
const ifNode = (name, condition) =>
  node(name, 'n8n-nodes-base.if', {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: `={{ ${condition} }}`,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  }, { typeVersion: 2.2 });

/**
 * Multi-way branch. `rules` is [{ label, condition }]; output N matches rule N,
 * with a fallback "extra" output last.
 */
const switchNode = (name, rules) =>
  node(name, 'n8n-nodes-base.switch', {
    rules: {
      values: rules.map((r) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: crypto.randomUUID(),
              leftValue: `={{ ${r.condition} }}`,
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: r.label,
      })),
    },
    looseTypeValidation: true,
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'unmatched' },
  }, { typeVersion: 3.2 });

const respond = (name, opts = {}) =>
  node(name, 'n8n-nodes-base.respondToWebhook', {
    respondWith: 'json',
    responseBody: opts.body || '={{ JSON.stringify($json) }}',
    options: opts.statusCode ? { responseCode: opts.statusCode } : {},
  }, { typeVersion: 1.1 });

/** Calls another workflow in this project (by its file name). */
const executeWorkflow = (name, workflowFile) =>
  node(name, 'n8n-nodes-base.executeWorkflow', {
    workflowId: { __rl: true, value: workflowFile, mode: 'list', cachedResultName: workflowFile },
    workflowInputs: { mappingMode: 'defineBelow', value: {} },
    options: { waitForSubWorkflow: true },
  }, { typeVersion: 1.2 });

const noOp = (name) => node(name, 'n8n-nodes-base.noOp', {}, { typeVersion: 1 });

/**
 * Assemble a workflow.
 *
 * @param {object} spec
 *   @param {string} spec.name
 *   @param {Array} spec.nodes
 *   @param {Array<[string, string, number?]>} spec.connections
 *          [from, to] or [from, to, outputIndex]
 *   @param {string} [spec.notes]  shown as a sticky note on the canvas
 */
function workflow(spec) {
  const positions = new Map();
  // Depth = longest path from a trigger, so branches fan out visually.
  const depth = new Map();
  spec.nodes.forEach((n) => depth.set(n.name, 0));
  for (let pass = 0; pass < spec.nodes.length; pass += 1) {
    for (const [from, to] of spec.connections) {
      const d = (depth.get(from) ?? 0) + 1;
      if (d > (depth.get(to) ?? 0)) depth.set(to, d);
    }
  }
  const perColumn = new Map();
  spec.nodes.forEach((n) => {
    const col = depth.get(n.name) ?? 0;
    const row = perColumn.get(col) ?? 0;
    perColumn.set(col, row + 1);
    positions.set(n.name, [col * GRID_X, row * GRID_Y]);
  });

  const nodes = spec.nodes.map((n) => {
    const { name, type, parameters, typeVersion = 1, ...rest } = n;
    delete rest.webhookPath;
    return {
      parameters,
      id: idFor(spec.name, name),
      name,
      type,
      typeVersion,
      position: positions.get(name),
      ...(n.webhookPath ? { webhookId: idFor(spec.name, `webhook:${name}`) } : {}),
      ...rest,
    };
  });

  // n8n stores connections as: { [fromNode]: { main: [ [targets for output 0], [output 1], ... ] } }
  const connections = {};
  for (const [from, to, outputIndex = 0] of spec.connections) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  }

  if (spec.notes) {
    nodes.push({
      parameters: { content: spec.notes, height: 260, width: 460, color: 4 },
      id: idFor(spec.name, 'sticky'),
      name: 'Overview',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-540, -60],
    });
  }

  return {
    name: spec.name,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    active: false,
    pinData: {},
    meta: { instanceId: 'plumber-automation' },
    tags: spec.tags || [],
  };
}

/**
 * Preamble injected at the top of every Code node.
 * n8n Code nodes cannot `require` a relative path, but docker-compose mounts
 * ./lib at /home/node/lib, so absolute requires work.
 */
const LIB = `const LIB = '/home/node/lib';
const env = $env;`;

module.exports = {
  workflow, node, webhook, schedule, code, codeEachItem,
  postgres, ifNode, switchNode, respond, executeWorkflow, noOp, LIB,
};
