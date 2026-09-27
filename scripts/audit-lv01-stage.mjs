#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { auditLv01Stage } from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    version: { type: 'string' },
    'live-evidence': { type: 'boolean', default: false },
    'parent-bundle': { type: 'string' },
    'evidence-dir': { type: 'string' },
  },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values['live-evidence'], true, 'audit requires --live-evidence');
assert.ok(values['parent-bundle'], 'audit requires --parent-bundle');
assert.ok(values['evidence-dir'], 'audit requires --evidence-dir');
const stage = values.stage;
const version = Number(values.version);

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
const stageDir = join(values['evidence-dir'], 'lv01', `${stage}-v${version}`);
assert.equal(existsSync(registration), true, `missing prospective registration ${registration}`);
assert.equal(existsSync(values['parent-bundle']), true, `missing parent bundle ${values['parent-bundle']}`);
assert.equal(existsSync(stageDir), true, `missing collected stage ${stageDir}`);
const packet = JSON.parse(readFileSync(registration, 'utf8'));

const { receipt, reportPath } = await auditLv01Stage({
  packet,
  parentBundleDir: values['parent-bundle'],
  stageDir,
});
console.log(`LV01 ${stage} v${version} audit: ${receipt.status} ${reportPath}`);
if (receipt.status !== 'verified') {
  for (const reason of receipt.reasons) console.log(`blocked: ${reason}`);
  process.exitCode = 1;
}
