import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { verifyBundle } from '@ald/verifier';
import { validateE03PilotAdmission } from './check-e03-pilot-admission.mjs';
import { reconcileE03OriginalPilotData } from './e03-original-pilot-data.mjs';
import { reconcileE03PilotAttemptResources } from './e03-pilot-resource-accounting.mjs';

const mode = process.argv[2];
assert.ok(['--run', '--audit'].includes(mode) &&
  (process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === '--v2')));
const attemptVersion = process.argv[3] === '--v2' ? 'v2' : 'v1';
const root = `evidence/pilots/e03-blinded-${attemptVersion}`;
const project = `ald-e03-pilot-${attemptVersion}`;
const packetPath = `protocols/e03-pilot-registration.${attemptVersion}.json`;
const bindingPath = `protocols/e03-pilot-registration-binding.${attemptVersion}.json`;
const allocationPath = 'protocols/e03-pilot-resource-allocation.v1.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gib = 1024 ** 3;
const bundleFor = (runId) => join(root, runId, 'bundles', 'runs', runId);

function controllerStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  assert.match(fields[19], /^[0-9]+$/u);
  return fields[19];
}

function originalBytes(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path}: original evidence must not be a symlink`);
  if (stat.isFile()) return stat.size;
  assert.equal(stat.isDirectory(), true);
  return readdirSync(path).reduce((total, entry) => total + originalBytes(join(path, entry)), 0);
}

async function auditSlot(registered, executionCommit, registrationHash) {
  const { config, condition, slot: slotNumber } = registered;
  const runId = config.runId;
  const path = join(root, runId, 'slot.json');
  const record = read(path);
  assert.equal(record.experimentId, 'E03');
  assert.equal(record.stage, 'blinded-pilot');
  assert.equal(record.classification, 'original-registered-pilot-slot');
  assert.equal(record.researchFinding, false);
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.externalSpend, 0);
  assert.equal(record.publicChainTransaction, false);
  assert.equal(record.softwareCommit, executionCommit);
  assert.equal(record.registrationHash, registrationHash);
  assert.equal(record.runId, runId);
  assert.equal(record.condition, condition);
  assert.equal(record.slot, slotNumber);
  assert.equal(record.passed, true, `${runId}: ${record.failure ?? record.resourceMeasurementFailure}`);
  assert.equal(record.observations.state, 'sealed');
  assert.equal(record.observations.evaluationTurns, 200);
  assert.ok(record.observations.acceptedChannelEvents > 0);
  assert.equal(record.observations.scenarioStateHashes.length, 200);
  assert.ok(record.observations.agreements >= 0 && record.observations.agreements <= 200);
  assert.equal(record.observations.anchorReceiptCount, 1);
  assert.equal(record.observations.verifierExitCode, 0);
  assert.equal(record.observations.scenarioSeed, config.randomSeed);
  assert.deepEqual(record.observations.seedBindings, config.seedBindings);
  assert.equal(existsSync(join(root, runId, 'learner-resources.json')), false);
  assert.equal(record.observations.externalLearnerContainerCount, 0);
  assert.match(record.observations.nurseryContainerId, /^[a-f0-9]{12}$/u);
  assert.ok(Number.isSafeInteger(record.observations.nurseryProcessId));
  assert.deepEqual(record.observations.roleProcessIds,
    { 'baby-a': record.observations.nurseryProcessId,
      'baby-b': record.observations.nurseryProcessId });
  const bundle = bundleFor(runId);
  const verification = await verifyBundle(bundle, {
    verifierVersion: 'e03-original-pilot-audit',
    now: () => new Date().toISOString(), writeReport: false,
  });
  assert.equal(verification.exitCode, 0);
  const manifest = read(join(bundle, 'run-manifest.json'));
  assert.equal(manifest.deploymentMode, 'prototype');
  assert.equal(manifest.softwareCommit, executionCommit);
  assert.equal(manifest.runId, runId);
  const bundleConfig = read(join(bundle, 'configuration', 'run-config.json'));
  assert.deepEqual(bundleConfig, config, `${runId}: retained configuration differs from registered packet`);
  const rust = JSON.parse(execFileSync(join(root, 'ald-integrity-auditor'), [bundle],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }));
  assert.equal(rust.integrityPass, true);
  assert.equal(rust.anchored, true);
  const original = reconcileE03OriginalPilotData(bundle, record, condition, runId);
  return {
    runId, condition, slot: slotNumber,
    slotPath: path, slotSha256: sha256(path),
    learnerResourceSha256: null,
    scenarioStateHashes: original.scenarioStateHashes,
    agreements: original.agreements,
    containerIds: [],
    nurseryContainerId: record.observations.nurseryContainerId,
    nurseryProcessId: record.observations.nurseryProcessId,
    roleProcessIds: record.observations.roleProcessIds,
    wallMilliseconds: record.wallMilliseconds,
    nurseryResourceUsage: record.nurseryResourceUsage,
    learnerContainerResourceUsage: {},
    originalEvidenceBytes: originalBytes(join(root, runId)),
    bundleManifestHash: verification.bundleManifestHash,
    rust, passed: true,
  };
}

function checkPairedScenarios(slots, slotNumber) {
  const paired = slots.filter((slot) => slot.slot === slotNumber);
  assert.equal(paired.length, 6, `pilot scenario slot ${slotNumber} lacks six conditions`);
  for (const slot of paired.slice(1)) assert.deepEqual(slot.scenarioStateHashes,
    paired[0].scenarioStateHashes, `${slot.runId}: paired scenarios diverged`);
  assert.ok(paired.every((slot) => slot.containerIds.length === 0));
  assert.equal(new Set(paired.map((slot) => slot.nurseryContainerId)).size, 6,
    `pilot scenario slot ${slotNumber} reused a Nursery container`);
}

if (mode === '--audit') {
  const receipt = read(join(root, 'receipt.json'));
  assert.equal(receipt.experimentId, 'E03');
  assert.equal(receipt.stage, 'blinded-pilot');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.failure, null);
  assert.equal(receipt.plannedRuns, 120);
  assert.equal(receipt.attemptedRuns, 120);
  assert.equal(receipt.completedRuns, 120);
  assert.equal(receipt.validRuns, 120);
  assert.equal(receipt.incompleteAttemptedRuns, 0);
  assert.equal(receipt.invalidRuns, 0);
  assert.equal(receipt.abortedRuns, 0);
  assert.equal(receipt.replacedRuns, 0);
  assert.equal(receipt.sampleSizeEligible, true);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.equal(sha256(join(root, 'registration.json')), receipt.packetSha256);
  assert.equal(sha256(join(root, 'binding.json')), receipt.bindingSha256);
  assert.equal(sha256(join(root, 'admission.json')), receipt.admissionSha256);
  assert.equal(sha256(join(root, 'ald-integrity-auditor')), receipt.auditorSha256);
  const packet = read(join(root, 'registration.json'));
  const slots = [];
  for (const registered of packet.runs) slots.push(await auditSlot(registered,
    receipt.executionCommit, receipt.registrationHash));
  for (let slot = 1; slot <= 20; slot += 1) checkPairedScenarios(slots, slot);
  assert.equal(new Set(slots.map((slot) => slot.nurseryContainerId)).size, 120,
    'every original pilot run needs a fresh Nursery container');
  assert.deepEqual(receipt.slots, slots);
  console.log('E03 120-run original blinded-pilot audit passed; no confirmatory result');
} else {
  const admission = validateE03PilotAdmission();
  assert.equal(existsSync(root), false, 'pilot original evidence is single-use');
  const auditorPath = '.artifacts/cargo-target/release/ald-integrity-auditor';
  assert.equal(existsSync(auditorPath), true, 'build the retained Rust auditor before pilot collection');
  const executionCommit = git('rev-parse', 'HEAD');
  const packet = read(packetPath);
  const allocation = read(allocationPath);
  const policy = read('protocols/seed-and-resource-allocation.v1.json');
  const controllerTicks = controllerStartTicks(process.pid);
  const started = performance.now();
  mkdirSync(root, { recursive: true });
  copyFileSync(packetPath, join(root, 'registration.json'));
  copyFileSync(bindingPath, join(root, 'binding.json'));
  copyFileSync(allocationPath, join(root, 'allocation.json'));
  copyFileSync(auditorPath, join(root, 'ald-integrity-auditor'));
  writeFileSync(join(root, 'admission.json'), `${JSON.stringify(admission, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(root, 'attempt.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', stage: 'blinded-pilot',
    classification: 'registered-original-pilot-attempt',
    attemptStatus: 'running', plannedSlots: 120, attemptedSlots: 0, completedSlots: 0,
    controllerPid: process.pid, controllerStartTicks: controllerTicks,
    executionCommit, registrationHash: packet.preRegistrationHash,
    packetSha256: sha256(join(root, 'registration.json')),
    admissionSha256: sha256(join(root, 'admission.json')),
    plannedRuns: 120, primarySlotsPerCondition: 20, reserves: 0,
    startedAt: new Date().toISOString(), researchFinding: false,
    scientificDisposition: 'not-tested',
    externalSpend: 0, publicChainTransaction: false,
  }, null, 2)}\n`, { flag: 'wx' });
  const environment = {
    ...process.env, ALD_SOFTWARE_COMMIT: executionCommit, ALD_LEARNER_TRACK: 'no-learning',
    ALD_MODE_R_NURSERY_UID: String(process.getuid()),
    ALD_MODE_R_NURSERY_GID: String(process.getgid()),
    ALD_MODE_R_EVIDENCE_DIR: resolve(root),
  };
  const compose = ['compose', '--project-name', project,
    '--file', 'deploy/mode-r/docker-compose.yml',
    '--file', 'deploy/mode-r/docker-compose.e02.yml'];
  const command = (args) => {
    const result = spawnSync('docker', args, {
      env: environment, encoding: 'utf8', timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  let attemptedRuns = 0;
  let slots = [];
  let failure = null;
  let failureStage = 'container-build';
  let failedRunId = null;
  let lastChildExitStatus = null;
  try {
    command([...compose, 'build', 'nursery-study']);
    for (const registered of packet.runs) {
      const runId = registered.config.runId;
      failureStage = 'slot-nursery-start';
      attemptedRuns += 1;
      failedRunId = runId;
      const log = createWriteStream(join(root, `${runId}.log`), { flags: 'wx' });
      failureStage = 'slot-collection';
      const status = await new Promise((resolveStatus, reject) => {
        const child = spawn('docker', [...compose, 'run', '--rm', '--no-deps',
          '--name', `${project}-nursery`, '--entrypoint', '/usr/local/bin/node',
          'nursery-study', '/app/deploy/mode-r/run-e03-pilot-slot.mjs', runId, executionCommit],
        { env: environment, timeout: 2 * 60 * 60 * 1_000 });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
          log.write(chunk); process.stdout.write(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => log.end(() => resolveStatus(code)));
        log.once('error', reject);
      });
      lastChildExitStatus = status;
      assert.equal(status, 0, `${runId}: collector failed; original evidence retained`);
      failureStage = 'original-slot-audit';
      const audited = await auditSlot(registered, executionCommit, packet.preRegistrationHash);
      assert.equal(slots.some((slot) => slot.nurseryContainerId === audited.nurseryContainerId), false,
        `${runId}: original pilot Nursery container was reused`);
      slots.push(audited);
      if (registered.condition === 'oracle') checkPairedScenarios(slots, registered.slot);
      const measuredCpuHours = slots.reduce((total, slot) => total +
        slot.nurseryResourceUsage.cpuUsageMicroseconds, 0) / 3_600_000_000 +
        (process.resourceUsage().userCPUTime + process.resourceUsage().systemCPUTime) / 3_600_000_000;
      assert.ok(measuredCpuHours <= allocation.reservedCpuHours,
        `${runId}: pilot measured CPU exceeded its prospective reserve`);
      const measuredEvidenceGiB = originalBytes(root) / gib;
      assert.ok(measuredEvidenceGiB <= allocation.reservedWorkingStorageGiB,
        `${runId}: pilot evidence exceeded its prospective working-storage reserve`);
      assert.ok(allocation.priorCpuHoursCharged + measuredCpuHours <= policy.localCeiling.cpuHours,
        `${runId}: total charged CPU exceeded the local ceiling`);
      assert.ok(allocation.priorRetainedStorageGiB + measuredEvidenceGiB <=
        policy.localCeiling.workingStorageGiB,
      `${runId}: total retained working evidence exceeded the local ceiling`);
      const observedPeakBytes = slots.at(-1).nurseryResourceUsage.peakBytes +
        process.resourceUsage().maxRSS * 1024;
      assert.ok(observedPeakBytes / gib <= allocation.maximumResidentGiB,
        `${runId}: pilot resident-memory peak exceeded its prospective reserve`);
      writeFileSync(join(root, `progress-${String(slots.length).padStart(3, '0')}.json`),
        `${JSON.stringify({ attemptedRuns, completedRuns: slots.length,
          lastRunId: runId, measuredCpuHours,
          evidenceBytesBeforeProgressReceipt: originalBytes(root),
          remainingCpuHours: policy.localCeiling.cpuHours -
            allocation.priorCpuHoursCharged - measuredCpuHours,
          remainingWorkingStorageGiB: policy.localCeiling.workingStorageGiB -
            allocation.priorRetainedStorageGiB - measuredEvidenceGiB,
          capturedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
      failureStage = 'slot-cleanup';
      command([...compose, 'down', '--remove-orphans']);
      failedRunId = null;
      lastChildExitStatus = null;
      console.log(`E03 original pilot ${slots.length}/120: ${runId} verified; no research claim`);
    }
  } catch (error) {
    failure = `${error.name}: ${error.message}`;
  } finally {
    if (spawnSync('docker', ['inspect', `${project}-nursery`],
      { stdio: 'ignore' }).status === 0) {
      try { command(['stop', '--time', '30', `${project}-nursery`]); }
      catch (error) { failure = `${failure ?? ''} stop failed: ${error.message}`; }
    }
    try { command([...compose, 'down', '--remove-orphans']); }
    catch (error) { failure = `${failure ?? ''} cleanup failed: ${error.message}`; }
  }
  const passed = failure === null && attemptedRuns === 120 && slots.length === 120;
  const attemptedResourceAccounting = reconcileE03PilotAttemptResources(root,
    packet.runs.slice(0, attemptedRuns).map((run) => run.config.runId),
    slots, process.resourceUsage());
  const measuredCpuHours = attemptedResourceAccounting.measuredCpuHoursLowerBound;
  const evidenceBytesBeforeTerminalReceipt = originalBytes(root);
  writeFileSync(join(root, 'receipt.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', stage: 'blinded-pilot',
    classification: 'registered-original-pilot-terminal',
    researchFinding: false, scientificDisposition: 'not-tested',
    executionCommit, registrationHash: packet.preRegistrationHash,
    packetSha256: sha256(join(root, 'registration.json')),
    bindingSha256: sha256(join(root, 'binding.json')),
    admissionSha256: sha256(join(root, 'admission.json')),
    allocationSha256: sha256(join(root, 'allocation.json')),
    auditorSha256: sha256(join(root, 'ald-integrity-auditor')),
    plannedRuns: 120, attemptedRuns, completedRuns: slots.length,
    validRuns: slots.length,
    incompleteAttemptedRuns: attemptedRuns - slots.length,
    invalidRuns: passed ? 0 : null, abortedRuns: passed ? 0 : null,
    replacedRuns: 0,
    unattemptedRuns: 120 - attemptedRuns,
    sampleSizeEligible: passed, slots, failure, failureStage, failedRunId,
    lastChildExitStatus,
    attemptedResourceAccounting,
    wallMilliseconds: performance.now() - started,
    measuredCpuHours,
    evidenceBytesBeforeTerminalReceipt,
    remainingCpuHours: attemptedResourceAccounting.completeMeasurement
      ? policy.localCeiling.cpuHours - allocation.priorCpuHoursCharged - measuredCpuHours
      : null,
    remainingWorkingStorageGiB: policy.localCeiling.workingStorageGiB -
      allocation.priorRetainedStorageGiB - evidenceBytesBeforeTerminalReceipt / gib,
    hostResourceUsage: process.resourceUsage(),
    externalSpend: 0, publicChainTransaction: false, passed,
    claimBoundary: 'Original E03 blinded-pilot feasibility and outcome-blind variance input only; no chance-control or language-emergence hypothesis is tested here.',
  }, null, 2)}\n`, { flag: 'wx' });
  if (!passed) process.exitCode = 1;
}
