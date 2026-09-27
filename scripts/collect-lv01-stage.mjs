#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { collectLv01Stage } from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const partitions = new Set(['dev', 'within-support', 'novel-composition']);
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    version: { type: 'string' },
    run: { type: 'boolean', default: false },
    'parent-bundle': { type: 'string' },
    'evidence-dir': { type: 'string' },
    partition: { type: 'string' },
    'ordinary-id': { type: 'string', default: 'uniform' },
    'store-root': { type: 'string' },
    'database-path': { type: 'string' },
    owner: { type: 'string' },
  },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values.run, true, 'collect runs only with --run');
assert.ok(values['parent-bundle'], 'collect requires --parent-bundle');
assert.ok(values['evidence-dir'], 'collect requires --evidence-dir');
assert.ok(values.partition && partitions.has(values.partition), 'partition must be dev, within-support, or novel-composition');
assert.ok(values['store-root'], 'collect requires --store-root');
assert.ok(values.owner, 'collect requires --owner');
const stage = values.stage;
const version = Number(values.version);
const ordinaryId = values['ordinary-id'] ?? 'uniform';
assert.equal(
  ordinaryId,
  'uniform',
  `ordinary predictor '${ordinaryId}' is not constructible pre-analysis; ordinary selection is analysis-time`,
);

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
const bindingPath = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
assert.equal(existsSync(registration), true, `missing prospective registration ${registration}`);
assert.equal(existsSync(bindingPath), true, `missing prospective binding ${bindingPath}`);
assert.equal(existsSync(values['parent-bundle']), true, `missing parent bundle ${values['parent-bundle']}`);
const packet = JSON.parse(readFileSync(registration, 'utf8'));
const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');

const collection = await collectLv01Stage({
  packet,
  binding,
  parentBundleDir: values['parent-bundle'],
  evidenceDir: values['evidence-dir'],
  softwareCommit: head,
  partition: values.partition,
  ordinary: { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
  store:
    values['database-path'] === undefined
      ? { root: values['store-root'] }
      : { root: values['store-root'], databasePath: values['database-path'] },
  owner: values.owner,
});
console.log(`LV01 ${stage} v${version} collected: ${collection.cases.length} cases, journal ${collection.journalPath}`);
