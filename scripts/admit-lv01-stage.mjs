#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { admitLv01Stage } from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const { values } = parseArgs({
  options: { stage: { type: 'string' }, version: { type: 'string' }, 'live-evidence': { type: 'boolean', default: false } },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values['live-evidence'], true, 'admit requires --live-evidence');
const stage = values.stage;
const version = Number(values.version);
const designVersion = version >= 2 ? 2 : 1;

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
const bindingPath = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
const receiptPath = `reports/research/lv01-${stage}-gate-receipt.v${version}.json`;
assert.equal(existsSync(registration), true, `missing prospective registration ${registration}`);
assert.equal(existsSync(bindingPath), true, `missing prospective binding ${bindingPath}`);
assert.equal(existsSync(receiptPath), false, `gate receipt is immutable; ${receiptPath} already exists`);
const packet = JSON.parse(readFileSync(registration, 'utf8'));
const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const check = (script, args = []) => {
  try {
    execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const designVerified = check('scripts/check-lv01-design.mjs', ['--version', String(designVersion)]);
const numericalQualificationVerified = check('scripts/check-lv01-power-qualification.mjs');
let topologyQualificationVerified = false;
if (existsSync(packet?.qualifications?.topology?.path ?? '')) {
  const topology = JSON.parse(readFileSync(packet.qualifications.topology.path, 'utf8'));
  topologyQualificationVerified =
    topology.passed === true && sha256(packet.qualifications.topology.path) === packet.qualifications.topology.sha256;
}
const sourceClean =
  git('status', '--porcelain', '--untracked-files=no') === '' &&
  spawnSync('git', ['merge-base', '--is-ancestor', binding.sourceCommit, git('rev-parse', 'HEAD')]).status === 0;
let resourcesSufficient = false;
if (existsSync(packet?.allocation?.path ?? '')) {
  const allocation = JSON.parse(readFileSync(packet.allocation.path, 'utf8'));
  resourcesSufficient =
    sha256(packet.allocation.path) === packet.allocation.sha256 &&
    allocation.studyId === 'LV01' &&
    allocation.status === 'design-locked-not-executed';
}

const receipt = admitLv01Stage({
  packet,
  binding,
  checks: {
    designVerified,
    numericalQualificationVerified,
    topologyQualificationVerified,
    sourceClean,
    resourcesSufficient,
    stage,
  },
});
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`LV01 ${stage} v${version} admission: ${receipt.status}`);
if (receipt.status !== 'ready') {
  for (const reason of receipt.reasons) console.log(`blocked: ${reason}`);
  process.exitCode = 1;
}
