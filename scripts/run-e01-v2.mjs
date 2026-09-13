import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditE01Slot } from '../deploy/mode-r/audit-e01-v2-slot.mjs';

const evidenceRoot = 'evidence/qualification/e01-v2';
const receiptPath = 'reports/research/e01-v2-qualification-receipt.json';
const bindingPath = 'protocols/e01-registration-binding.v2.json';
const packetPath = 'protocols/e01-registration.v2.json';
const rust = resolve('.artifacts/cargo-target/release/ald-integrity-auditor');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (name, args, env = {}) => spawnSync(name, args, { encoding: 'utf8',
  env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
const requireSuccess = (name, args, env) => {
  const result = run(name, args, env);
  assert.equal(result.status, 0, `${name} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--audit'));
requireSuccess(process.execPath, ['scripts/register-e01-v2.mjs', '--check']);
const packet = read(packetPath);
const binding = read(bindingPath);
const bindings = Object.fromEntries(packet.artifact.bindings.map((b) => [b.key, b.content]));
const expectedSlots = bindings.selectedSeedPrefix.primary;
assert.equal(expectedSlots.length, 5);
assert.ok(existsSync(rust), 'build the release Rust integrity auditor before execution');

async function validateSlot(directory, expected, executionCommit) {
  const checked = await auditE01Slot(directory);
  assert.equal(checked.slot.classification, 'prospectively-registered-software-qualification');
  assert.equal(checked.slot.slot, expected.slot);
  assert.equal(checked.slot.scenarioSeed, expected.scenario);
  assert.equal(checked.slot.softwareCommit, executionCommit);
  assert.equal(checked.slot.registrationHash, packet.preRegistrationHash);
  const manifest = read(join(directory, 'bundle/run-manifest.json'));
  assert.deepEqual(manifest.preRegistration, binding);
  const independent = JSON.parse(requireSuccess(rust, [join(directory, 'bundle')]));
  assert.equal(independent.integrityPass, true);
  assert.equal(independent.anchored, true);
  return { slot: expected.slot, scenarioSeed: expected.scenario, runId: checked.slot.runId,
    passed: checked.passed, decision: checked.decision, containerIds: checked.slot.topology.containerIds,
    slotSha256: sha256(readFileSync(join(directory, 'slot.json'))),
    bundleManifestHash: checked.verification.bundleManifestHash, rust: independent };
}

if (process.argv[2] === '--audit') {
  const receipt = read(receiptPath);
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registrationHash, packet.preRegistrationHash);
  git('merge-base', '--is-ancestor', binding.repositoryRegistration.commit, receipt.executionCommit);
  for (const source of bindings.analysisVersions) {
    assert.equal(sha256(execFileSync('git', ['show', `${receipt.executionCommit}:${source.path}`])), source.sha256);
  }
  const slots = [];
  for (const expected of expectedSlots) slots.push(await validateSlot(join(evidenceRoot, `registered-e01-v2-${expected.slot}`), expected, receipt.executionCommit));
  assert.deepEqual(receipt.slots, slots);
  assert.equal(receipt.passed, slots.every((s) => s.passed) && receipt.failure === null);
  assert.equal(receipt.passed, true);
  assert.equal(new Set(slots.flatMap((s) => s.containerIds)).size, 10);
  console.log('E01 v2: five original slots and both verifier implementations pass');
} else {
  assert.equal(git('status', '--porcelain'), '', 'registered execution requires a clean commit');
  assert.equal(existsSync(evidenceRoot), false, 'refusing to overwrite an attempted qualification');
  assert.equal(existsSync(receiptPath), false, 'refusing to overwrite a receipt');
  for (const source of bindings.analysisVersions) assert.equal(sha256(readFileSync(source.path)), source.sha256, `source changed: ${source.path}`);
  const executionCommit = git('rev-parse', 'HEAD');
  const bindingCommit = git('log', '-1', '--format=%H', '--', bindingPath);
  git('merge-base', '--is-ancestor', bindingCommit, executionCommit);
  mkdirSync(evidenceRoot, { recursive: true });
  copyFileSync(bindingPath, join(evidenceRoot, 'registration-binding.json'));
  const environment = { ALD_LEARNER_TRACK: 'no-learning', ALD_MODE_R_NURSERY_UID: String(process.getuid()),
    ALD_MODE_R_NURSERY_GID: String(process.getgid()), ALD_MODE_R_EVIDENCE_DIR: resolve(evidenceRoot) };
  const compose = ['compose', '--project-name', 'ald-e01-v2-qualified', '--file', 'deploy/mode-r/docker-compose.yml'];
  const slots = [];
  const started = performance.now();
  let failure = null;
  try {
    requireSuccess('docker', [...compose, 'build', 'baby-a', 'baby-b', 'nursery-study'], environment);
    const baseDigests = JSON.parse(requireSuccess('docker', ['image', 'inspect', 'node:24.20.0-alpine', '--format', '{{json .RepoDigests}}']));
    assert.ok(baseDigests.some((digest) => digest.endsWith('@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf')));
    for (const expected of expectedSlots) {
      requireSuccess('docker', [...compose, 'up', '--detach', '--force-recreate', 'baby-a', 'baby-b'], environment);
      const result = run('docker', [...compose, 'run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/node',
        'nursery-study', '/app/deploy/mode-r/run-e01-v2-slot.mjs', String(expected.slot), expected.scenario,
        '/evidence', executionCommit, '/evidence/registration-binding.json'], environment);
      writeFileSync(join(evidenceRoot, `slot-${expected.slot}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const directory = join(evidenceRoot, `registered-e01-v2-${expected.slot}`);
      if (!existsSync(join(directory, 'slot.json'))) throw new Error(`slot ${expected.slot} infrastructure failure; log retained`);
      const checked = await validateSlot(directory, expected, executionCommit);
      slots.push(checked);
      console.log(`E01 v2 slot ${expected.slot}: ${checked.passed ? 'pass' : 'fail'}`);
      assert.ok(result.status === 0 || !checked.passed, 'process failure contradicts passing slot');
    }
    assert.equal(new Set(slots.flatMap((s) => s.containerIds)).size, 10);
  } catch (error) { failure = `${error.name}: ${error.message}`; }
  finally {
    const cleanup = run('docker', [...compose, 'down', '--remove-orphans'], environment);
    if (cleanup.status !== 0) failure = `${failure ?? ''} topology cleanup failed: ${cleanup.stderr}`;
  }
  const receipt = { schemaVersion: 2, experimentId: 'E01', researchFinding: false,
    classification: 'prospectively-registered-software-qualification', registrationHash: packet.preRegistrationHash,
    executionCommit, externalSpend: 0, publicChainTransaction: false, slots, failure,
    wallMilliseconds: performance.now() - started, passed: failure === null && slots.length === 5 && slots.every((s) => s.passed),
    claimBoundary: 'Tested local topology and enumerated corpus only; no behavioral result, public timestamp, independent operator review, or universal side-channel-resistance claim.' };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  assert.equal(receipt.passed, true, `qualification failed; all available evidence retained: ${failure}`);
}
