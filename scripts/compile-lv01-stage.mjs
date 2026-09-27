#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { compileLv01StagePacket, lv01SlotPlanForStage } from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const { values } = parseArgs({
  options: { stage: { type: 'string' }, version: { type: 'string' }, write: { type: 'boolean', default: false } },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values.write, true, 'compile writes only with --write');
const stage = values.stage;
const version = Number(values.version);
const designVersion = version >= 2 ? 2 : 1;

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
assert.equal(existsSync(registration), false, `registration is immutable; ${registration} already exists`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'compile requires a clean tracked tree');
const head = git('rev-parse', 'HEAD');
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

const allocation = `protocols/lv01-${stage}-resource-allocation.v${version}.json`;
assert.equal(existsSync(allocation), true, `missing resource allocation ${allocation}`);
if (stage === 'confirmatory' || stage === 'replication') {
  const lock = `reports/research/lv01-design-lock.v${version}.json`;
  assert.equal(existsSync(lock), true, `main stages require a locked design receipt ${lock}`);
}
execFileSync(process.execPath, ['scripts/check-lv01-design.mjs', '--version', String(designVersion)], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/check-lv01-power-qualification.mjs'], { stdio: 'inherit' });

const designPath = `protocols/lv01-study-design.v${designVersion}.json`;
const analysisPath = `protocols/lv01-analysis-plan.v${designVersion}.json`;
const policyPath = `protocols/lv01-seed-resource-policy.v${designVersion}.json`;
const design = JSON.parse(readFileSync(designPath, 'utf8'));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const topologyPath = `reports/research/lv01-topology-qualification.v${version}.json`;
assert.equal(existsSync(topologyPath), true, `missing topology qualification ${topologyPath}`);
const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
assert.equal(topology.passed, true, `topology qualification ${topologyPath} did not pass`);

const packet = compileLv01StagePacket({
  stage,
  version,
  designVersion,
  designCommitmentHash: sha256(designPath),
  analysisCommitmentHash: sha256(analysisPath),
  seedResourceCommitmentHash: sha256(policyPath),
  sourceCommit: head,
  modelIdentity: {
    architecture: design.learner.architecture,
    track: design.learner.track,
    parameterCountPerAgent: design.learner.parameterCountPerAgent,
    inputSize: design.learner.inputSize,
    hiddenSize: design.learner.hiddenSize,
  },
  allocation: { path: allocation, sha256: sha256(allocation) },
  qualifications: {
    designCheck: 'passed',
    powerCheck: 'passed',
    topology: { path: topologyPath, sha256: sha256(topologyPath), passed: true },
  },
  slotPlan: lv01SlotPlanForStage(stage, {
    pilot: policy.stages.pilot,
    development: policy.stages.development,
    qualification: policy.stages.qualification,
  }),
});
writeFileSync(registration, `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`LV01 ${stage} v${version} registered: ${packet.packetCommitment}`);
