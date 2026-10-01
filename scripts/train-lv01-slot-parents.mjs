#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { InMemorySignerRegistry } from '@ald/hashing';
import {
  createProductionRuntime,
  lv01SlotSeeds,
  trainLv01SlotParent,
  verifyLv01StageBinding,
  verifyLv01StagePacket,
} from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    version: { type: 'string' },
    run: { type: 'boolean', default: false },
    slots: { type: 'string' },
    'parents-dir': { type: 'string' },
    'store-root': { type: 'string' },
    'database-path': { type: 'string' },
    track: { type: 'string' },
    'model-ref': { type: 'string' },
    'learning-signal': { type: 'string' },
    'max-turns': { type: 'string' },
    'evaluation-turns': { type: 'string' },
    'ledger-value-plan': { type: 'string' },
    'deployment-mode': { type: 'string' },
    'protocol-commit': { type: 'string' },
  },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values.run, true, 'train runs only with --run');
assert.ok(values.slots, 'train requires --slots');
assert.ok(values['parents-dir'], 'train requires --parents-dir');
assert.ok(values['store-root'], 'train requires --store-root');
assert.ok(values.track, 'train requires --track');
assert.ok(values['model-ref'], 'train requires --model-ref');
assert.ok(values['learning-signal'], 'train requires --learning-signal');
assert.ok(values['ledger-value-plan'], 'train requires --ledger-value-plan');
assert.ok(
  values['deployment-mode'] === 'prototype' || values['deployment-mode'] === 'research-grade',
  'deployment-mode must be prototype or research-grade',
);
assert.ok(values['protocol-commit'], 'train requires --protocol-commit');
const stage = values.stage;
const version = Number(values.version);
const slots = values.slots.split(',').map((entry) => Number(entry.trim()));
assert.ok(
  slots.length > 0 && slots.every((slot) => Number.isInteger(slot) && slot >= 1) && new Set(slots).size === slots.length,
  'slots must be a non-empty list of unique positive integers',
);
const maxTurns = Number(values['max-turns']);
const evaluationTurns = Number(values['evaluation-turns']);
assert.ok(Number.isInteger(maxTurns) && maxTurns >= 1, 'max-turns must be a positive integer');
assert.ok(Number.isInteger(evaluationTurns) && evaluationTurns >= 0, 'evaluation-turns must be a non-negative integer');

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
const bindingPath = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
assert.equal(existsSync(registration), true, `missing prospective registration ${registration}`);
assert.equal(existsSync(bindingPath), true, `missing prospective binding ${bindingPath}`);
assert.equal(existsSync(values['ledger-value-plan']), true, `missing ledger value plan ${values['ledger-value-plan']}`);
const packet = verifyLv01StagePacket(JSON.parse(readFileSync(registration, 'utf8')));
verifyLv01StageBinding(JSON.parse(readFileSync(bindingPath, 'utf8')), packet);
const plannedSlots = packet.slotPlan.primaries + packet.slotPlan.reserves;
for (const slot of slots) {
  assert.ok(slot <= plannedSlots, `slot ${slot} exceeds the ${plannedSlots} planned stage slots`);
}
const ledgerValuePlan = JSON.parse(readFileSync(values['ledger-value-plan'], 'utf8'));

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');

mkdirSync(values['parents-dir'], { recursive: true });
const databasePath = values['database-path'] ?? join(values['store-root'], 'evidence.sqlite');
const production = createProductionRuntime({
  databasePath,
  bundleRoot: values['store-root'],
  softwareCommit: head,
  anchorPolicy: 'skip',
});
const { runtime, database } = production;
const registries = new Map();
const signerProvider = (runId) => {
  const existing = registries.get(runId);
  if (existing) return existing;
  const created = InMemorySignerRegistry.generate(runId);
  registries.set(runId, created);
  return created;
};

const receipts = [];
try {
  for (const slot of slots) {
    const seeds = lv01SlotSeeds(packet.packetCommitment, slot);
    const bundleDir = join(values['parents-dir'], `slot-${String(slot).padStart(4, '0')}`);
    const trained = await trainLv01SlotParent({
      runtime,
      database,
      signerProvider,
      runId: `lv01-${stage}-v${version}-parent-${String(slot).padStart(4, '0')}`,
      seeds: {
        scenario: seeds.scenario,
        babyA: seeds.babyA,
        babyB: seeds.babyB,
        gateway: seeds.gateway,
        analysis: seeds.analysis,
      },
      training: {
        track: values.track,
        modelRef: values['model-ref'],
        learningSignal: values['learning-signal'],
        maxTurnsPerRun: maxTurns,
        evaluationTurns,
      },
      ledgerValuePlan,
      runsRoot: values['store-root'],
      bundleDir,
      softwareCommit: head,
      deploymentMode: values['deployment-mode'],
      protocolGitCommit: values['protocol-commit'],
    });
    receipts.push(trained.receipt);
    console.log(`LV01 ${stage} v${version} parent trained: slot ${slot} ${trained.receipt.parentSeedsDigest}`);
  }
} finally {
  production.close();
}
writeFileSync(
  join(values['parents-dir'], 'training-receipts.json'),
  `${JSON.stringify({ stage, version, slots, receipts }, null, 2)}\n`,
);
console.log(`LV01 ${stage} v${version} parents trained: ${receipts.length} slots under ${values['parents-dir']}`);
