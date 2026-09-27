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
// Stage and version come from packet/binding contents, never from filenames:
// misplaced files are misuse, not a blockable state.
assert.equal(packet.stage, stage, `packet stage ${packet.stage} disagrees with requested ${stage}`);
assert.equal(packet.version, version, `packet version ${packet.version} disagrees with requested ${version}`);
assert.equal(binding.stage, stage, `binding stage ${binding.stage} disagrees with requested ${stage}`);
assert.equal(binding.version, version, `binding version ${binding.version} disagrees with requested ${version}`);

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
const isAncestorOrEqual = (older, newer) =>
  older === newer || spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const closureUnchanged = (older, newer) =>
  older === newer ||
  spawnSync('git', ['diff', '--quiet', older, newer, '--', 'packages', 'scripts', 'deploy', 'pnpm-lock.yaml']).status === 0;
const noUntrackedRuntime = () =>
  git('status', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((path) => path.startsWith('packages/') || path.startsWith('scripts/') || path.startsWith('deploy/')).length === 0;

const designVerified = check('scripts/check-lv01-design.mjs', ['--version', String(designVersion)]);
const numericalQualificationVerified = check('scripts/check-lv01-power-qualification.mjs', [
  '--design-version',
  String(designVersion),
]);
let topologyQualificationVerified = false;
try {
  const topologyPath = packet?.qualifications?.topology?.path ?? '';
  const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
  topologyQualificationVerified =
    topology.passed === true &&
    sha256(topologyPath) === packet.qualifications.topology.sha256 &&
    /^[0-9a-f]{40}$/u.test(topology.sourceCommit ?? '') &&
    topology.designVersion === packet.designVersion &&
    isAncestorOrEqual(topology.sourceCommit, packet.sourceCommit) &&
    closureUnchanged(topology.sourceCommit, packet.sourceCommit);
} catch {
  topologyQualificationVerified = false;
}
let sourceClean = false;
try {
  const head = git('rev-parse', 'HEAD');
  sourceClean =
    git('status', '--porcelain', '--untracked-files=no') === '' &&
    noUntrackedRuntime() &&
    isAncestorOrEqual(binding.sourceCommit, head) &&
    closureUnchanged(binding.sourceCommit, head);
} catch {
  sourceClean = false;
}
let resourcesSufficient = false;
try {
  const allocation = JSON.parse(readFileSync(packet?.allocation?.path ?? '', 'utf8'));
  const clearancePath = 'reports/research/r01b-collection-clearance.v1.json';
  const clearance = existsSync(clearancePath) ? JSON.parse(readFileSync(clearancePath, 'utf8')) : null;
  resourcesSufficient =
    sha256(packet.allocation.path) === packet.allocation.sha256 &&
    allocation.studyId === 'LV01' &&
    allocation.status === 'design-locked-not-executed' &&
    clearance?.studyId === 'LV01' &&
    clearance?.cleared === true;
} catch {
  resourcesSufficient = false;
}
let designHashesLive = false;
try {
  const live = {
    design: sha256(`protocols/lv01-study-design.v${packet.designVersion}.json`),
    analysis: sha256(`protocols/lv01-analysis-plan.v${packet.designVersion}.json`),
    policy: sha256(`protocols/lv01-seed-resource-policy.v${packet.designVersion}.json`),
  };
  designHashesLive =
    live.design === packet.designCommitmentHash &&
    live.analysis === packet.analysisCommitmentHash &&
    live.policy === packet.seedResourceCommitmentHash;
} catch {
  designHashesLive = false;
}
let hostReady = false;
try {
  const lease = JSON.parse(readFileSync('.artifacts/a0-leases/active.json', 'utf8'));
  const preflight = JSON.parse(readFileSync(lease.preflight, 'utf8'));
  const age = Date.now() - Date.parse(preflight.at);
  hostReady =
    typeof lease.owner === 'string' &&
    lease.owner.length > 0 &&
    preflight.admission === 'admit' &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 10 * 60 * 1000;
} catch {
  hostReady = false;
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
    designHashesLive,
    hostReady,
    stage,
  },
});
// Only a ready verdict takes the canonical immutable path. Blocked verdicts go
// to timestamped sidecars so a transient block never burns the version.
const outPath =
  receipt.status === 'ready'
    ? receiptPath
    : receiptPath.replace(/\.json$/u, `.blocked.${new Date().toISOString().replaceAll(':', '-')}.json`);
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`LV01 ${stage} v${version} admission: ${receipt.status}`);
if (receipt.status !== 'ready') {
  for (const reason of receipt.reasons) console.log(`blocked: ${reason}`);
  process.exitCode = 1;
}
