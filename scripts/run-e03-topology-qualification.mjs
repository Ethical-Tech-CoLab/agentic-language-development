import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBundle } from '@ald/verifier';
import { deriveE03OriginalControlData } from './e03-original-pilot-data.mjs';

const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
const mode = process.argv[2];
assert.ok(process.argv.length === 3 &&
  ['--run', '--audit', '--run-prototype-v2', '--audit-prototype-v2'].includes(mode));
const profile = mode.endsWith('prototype-v2') ? 'prototype-v2' : 'v1';
const evidenceRoot = profile === 'v1'
  ? 'evidence/qualification/e03-topology-development-v1'
  : 'evidence/qualification/e03-topology-prototype-v2';
const projectName = profile === 'v1'
  ? 'ald-e03-topology-development-v1'
  : 'ald-e03-topology-prototype-v2';
const slotName = (condition) => profile === 'v1'
  ? `e03-topology-development-${condition}`
  : `e03-topology-prototype-v2-${condition}`;
const deploymentMode = profile === 'v1' ? 'research-grade' : 'prototype';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const resourcePath = (condition) => join(evidenceRoot,
  slotName(condition), 'learner-resources.json');

function captureLearnerResources(condition) {
  const slot = read(join(evidenceRoot, slotName(condition), 'slot.json'));
  const resources = {};
  let failure = null;
  try {
    for (const role of ['baby-a', 'baby-b']) {
      const containerId = slot.observations.containerIds[role];
      assert.match(containerId, /^[a-f0-9]{12,64}$/u);
      const cpuStat = execFileSync('docker', ['exec', containerId, 'cat', '/sys/fs/cgroup/cpu.stat'],
        { encoding: 'utf8', timeout: 30_000 });
      const peakBytes = Number(execFileSync('docker', ['exec', containerId, 'cat',
        '/sys/fs/cgroup/memory.peak'], { encoding: 'utf8', timeout: 30_000 }).trim());
      const usage = Number(/^usage_usec (\d+)$/mu.exec(cpuStat)?.[1]);
      assert.ok(Number.isSafeInteger(usage) && usage > 0);
      assert.ok(Number.isSafeInteger(peakBytes) && peakBytes > 0);
      resources[role] = { containerId, cpuUsageMicroseconds: usage, peakBytes,
        scope: 'learner-container-cgroup' };
    }
  } catch (error) {
    failure = `${error.name}: ${error.message}`;
  }
  writeFileSync(resourcePath(condition), `${JSON.stringify({ condition, resources, failure,
    measuredAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  assert.equal(failure, null, `${condition}: learner resource measurement failed`);
}

async function auditSlot(condition, executionCommit) {
  const path = join(evidenceRoot, slotName(condition), 'slot.json');
  const slot = read(path);
  assert.equal(slot.experimentId, 'E03');
  assert.equal(slot.classification, 'development-only-topology-qualification');
  assert.equal(slot.researchFinding, false);
  assert.equal(slot.externalSpend, 0);
  assert.equal(slot.publicChainTransaction, false);
  assert.equal(slot.softwareCommit, executionCommit);
  if (profile !== 'v1') assert.equal(slot.profile, profile);
  assert.equal(slot.condition, condition);
  assert.equal(slot.passed, true, `${condition}: ${slot.failure ?? slot.resourceMeasurementFailure}`);
  assert.equal(slot.observations.condition, condition);
  assert.equal(slot.observations.state, 'sealed');
  assert.equal(slot.observations.evaluationTurns, 200);
  assert.equal(slot.observations.scenarioStateHashes.length, 200);
  assert.equal(slot.observations.anchorReceiptCount, 1);
  assert.equal(slot.observations.verifierExitCode, 0);
  const learnerResources = read(resourcePath(condition));
  assert.equal(learnerResources.condition, condition);
  assert.equal(learnerResources.failure, null);
  assert.deepEqual(Object.keys(learnerResources.resources).sort(), ['baby-a', 'baby-b']);
  for (const role of ['baby-a', 'baby-b']) {
    assert.equal(learnerResources.resources[role].containerId, slot.observations.containerIds[role]);
    assert.ok(learnerResources.resources[role].cpuUsageMicroseconds > 0);
    assert.ok(learnerResources.resources[role].peakBytes > 0);
  }
  const bundle = join(evidenceRoot, slotName(condition), 'bundles', 'runs', slot.observations.runId);
  const verification = await verifyBundle(bundle, {
    verifierVersion: 'e03-topology-development-audit',
    now: () => new Date().toISOString(), writeReport: false,
  });
  assert.equal(verification.exitCode, 0);
  const manifest = read(join(bundle, 'run-manifest.json'));
  assert.equal(manifest.deploymentMode, deploymentMode);
  assert.equal(manifest.softwareCommit, executionCommit);
  assert.equal(manifest.runId, slot.observations.runId);
  const config = read(join(bundle, 'configuration', 'run-config.json'));
  assert.equal(config.deploymentMode, deploymentMode);
  assert.equal(config.communicationCondition, condition);
  assert.deepEqual(config.seedBindings, slot.observations.seedBindings);
  const rustPath = join(evidenceRoot, 'ald-integrity-auditor');
  const rust = JSON.parse(execFileSync(rustPath, [bundle], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  }));
  assert.equal(rust.integrityPass, true);
  assert.equal(rust.anchored, true);
  const original = deriveE03OriginalControlData(bundle, condition, slot.observations.runId);
  assert.deepEqual(slot.observations.scenarioStateHashes, original.scenarioStateHashes,
    `${condition}: operational scenario hashes differ from signed originals`);
  assert.equal(slot.observations.successes, original.agreements,
    `${condition}: operational success tally differs from signed originals`);
  assert.equal(slot.observations.acceptedChannelEvents, original.acceptedChannelEvents);
  assert.equal(slot.observations.rejectedChannelEvents, original.rejectedChannelEvents);
  return {
    condition, slotPath: path, slotSha256: sha256(path),
    scenarioStateHashes: original.scenarioStateHashes,
    signedOriginalDataReconciled: true,
    containerIds: Object.values(slot.observations.containerIds),
    wallMilliseconds: slot.wallMilliseconds,
    containerResourceUsage: slot.containerResourceUsage,
    learnerContainerResourceUsage: learnerResources.resources,
    learnerResourceSha256: sha256(resourcePath(condition)),
    bundleManifestHash: verification.bundleManifestHash,
    rust,
    passed: true,
  };
}

async function auditMatrix(executionCommit) {
  const slots = [];
  for (const condition of conditions) slots.push(await auditSlot(condition, executionCommit));
  for (const slot of slots.slice(1)) {
    assert.deepEqual(slot.scenarioStateHashes, slots[0].scenarioStateHashes,
      `${slot.condition}: paired scenarios diverged`);
  }
  assert.equal(new Set(slots.flatMap((slot) => slot.containerIds)).size, 12,
    'every condition needs fresh role containers');
  return slots;
}

if (mode.startsWith('--audit')) {
  const receipt = read(join(evidenceRoot, 'receipt.json'));
  assert.equal(receipt.classification, 'development-only-topology-qualification');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.ok(receipt.hostResourceUsage.userCPUTime > 0);
  assert.ok(receipt.hostResourceUsage.maxRSS > 0);
  assert.deepEqual(receipt.conditions, conditions);
  assert.equal(receipt.failure, null);
  assert.equal(receipt.passed, true);
  if (profile !== 'v1') assert.equal(receipt.profile, profile);
  assert.equal(receipt.auditorSha256, sha256(join(evidenceRoot, 'ald-integrity-auditor')));
  const slots = await auditMatrix(receipt.executionCommit);
  assert.deepEqual(receipt.slots, slots);
  console.log(`E03 six-condition ${profile} development topology audit passed; no research finding`);
} else {
  assert.equal(git('status', '--porcelain'), '', 'development topology execution requires a clean source commit');
  assert.equal(existsSync(evidenceRoot), false, 'development evidence is single-use');
  const auditorPath = '.artifacts/cargo-target/release/ald-integrity-auditor';
  assert.equal(existsSync(auditorPath), true, 'build the Rust integrity auditor before collection');
  const executionCommit = git('rev-parse', 'HEAD');
  mkdirSync(evidenceRoot, { recursive: true });
  copyFileSync(auditorPath, join(evidenceRoot, 'ald-integrity-auditor'));
  const auditorSha256 = sha256(join(evidenceRoot, 'ald-integrity-auditor'));
  writeFileSync(join(evidenceRoot, 'attempt.json'), `${JSON.stringify({
    experimentId: 'E03', classification: 'development-only-topology-qualification',
    ...(profile === 'v1' ? {} : { profile }),
    executionCommit, conditions, startedAt: new Date().toISOString(),
    noPilotSeedsUsed: true, externalSpend: 0, publicChainTransaction: false,
    auditorSha256,
  }, null, 2)}\n`, { flag: 'wx' });
  const environment = {
    ...process.env, ALD_SOFTWARE_COMMIT: executionCommit, ALD_LEARNER_TRACK: 'no-learning',
    ALD_MODE_R_NURSERY_UID: String(process.getuid()), ALD_MODE_R_NURSERY_GID: String(process.getgid()),
    ALD_MODE_R_EVIDENCE_DIR: resolve(evidenceRoot),
  };
  const compose = ['compose', '--project-name', projectName,
    '--file', 'deploy/mode-r/docker-compose.yml', '--file', 'deploy/mode-r/docker-compose.e02.yml'];
  const command = (args) => {
    const result = spawnSync('docker', args, {
      env: environment, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  const started = performance.now();
  let failure = null;
  let slots = [];
  try {
    command([...compose, 'build', 'baby-a', 'baby-b', 'nursery-study']);
    for (const condition of conditions) {
      command([...compose, 'up', '--detach', '--force-recreate', 'baby-a', 'baby-b']);
      const log = createWriteStream(join(evidenceRoot, `slot-${condition}.log`), { flags: 'wx' });
      const status = await new Promise((resolveStatus, reject) => {
        const child = spawn('docker', [...compose, 'run', '--rm', '--no-deps',
          '--name', `${projectName}-nursery`, '--entrypoint', '/usr/local/bin/node',
          'nursery-study', '/app/deploy/mode-r/run-e03-topology-slot.mjs', condition, executionCommit,
          ...(profile === 'v1' ? [] : [profile])],
        { env: environment, timeout: 2 * 60 * 60 * 1_000 });
        for (const stream of [child.stdout, child.stderr]) {
          stream.on('data', (chunk) => { log.write(chunk); process.stdout.write(chunk); });
        }
        child.once('error', reject);
        child.once('close', (code) => log.end(() => resolveStatus(code)));
        log.once('error', reject);
      });
      captureLearnerResources(condition);
      assert.equal(status, 0, `${condition}: slot failed; retained log and evidence need diagnosis`);
      slots.push(await auditSlot(condition, executionCommit));
      command([...compose, 'down', '--remove-orphans']);
      console.log(`E03 development topology ${condition}: pass; original evidence retained`);
    }
    slots = await auditMatrix(executionCommit);
  } catch (error) {
    failure = `${error.name}: ${error.message}`;
  } finally {
    if (spawnSync('docker', ['inspect', `${projectName}-nursery`],
      { stdio: 'ignore' }).status === 0) {
      try { command(['stop', '--time', '30', `${projectName}-nursery`]); }
      catch (error) { failure = `${failure ?? ''} stop failed: ${error.message}`; }
    }
    try { command([...compose, 'down', '--remove-orphans']); }
    catch (error) { failure = `${failure ?? ''} cleanup failed: ${error.message}`; }
  }
  const passed = failure === null && slots.length === conditions.length;
  writeFileSync(join(evidenceRoot, 'receipt.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', classification: 'development-only-topology-qualification',
    researchFinding: false, externalSpend: 0, publicChainTransaction: false,
    executionCommit, auditorSha256, ...(profile === 'v1' ? {} : { profile }),
    conditions, slots, failure, wallMilliseconds: performance.now() - started,
    hostResourceUsage: process.resourceUsage(),
    passed,
    claimBoundary: profile === 'v1'
      ? 'Control, oracle, learner-transport, simulated-anchor, and verifier mechanics only; not full Research-Grade writer/signer isolation, a registered pilot, or a research finding.'
      : 'Prototype-Mode control, oracle, learner-transport, simulated-anchor, and verifier mechanics only; no Research-Grade isolation claim, registered pilot, or research finding.',
  }, null, 2)}\n`, { flag: 'wx' });
  if (!passed) process.exitCode = 1;
}
