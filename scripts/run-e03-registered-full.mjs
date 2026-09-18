import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { analyzeE03FullQualification } from '@ald/analysis';
import { verifyBundle } from '@ald/verifier';
import { validateE03FullAdmission } from './check-e03-full-admission.mjs';
import { deriveE03FullAnalysisSeed,
  nextE03FullCollectorBatch } from './e03-full-collector-state.mjs';
import { reconcileE03OriginalPilotData } from './e03-original-pilot-data.mjs';
import { reconcileE03PilotAttemptResources } from './e03-pilot-resource-accounting.mjs';

const mode = process.argv[2];
assert.ok(['--run', '--audit'].includes(mode) && process.argv.length === 3,
  'usage: node scripts/run-e03-registered-full.mjs --run|--audit');
const root = 'evidence/qualification/e03-full-v1';
const project = 'ald-e03-full-v1';
const packetPath = 'protocols/e03-full-registration.v1.json';
const bindingPath = 'protocols/e03-full-registration-binding.v1.json';
const allocationPath = 'protocols/e03-full-resource-allocation.v1.json';
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

async function auditValidSlot(registered, executionCommit, registrationHash, auditorPath) {
  const { config, condition, slot, use } = registered;
  const runId = config.runId;
  const slotPath = join(root, runId, 'slot.json');
  const record = read(slotPath);
  assert.equal(record.experimentId, 'E03');
  assert.equal(record.stage, 'full-qualification');
  assert.equal(record.classification, 'original-registered-full-qualification-slot');
  assert.equal(record.researchFinding, false);
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.externalSpend, 0);
  assert.equal(record.publicChainTransaction, false);
  assert.equal(record.softwareCommit, executionCommit);
  assert.equal(record.registrationHash, registrationHash);
  assert.equal(record.runId, runId);
  assert.equal(record.condition, condition);
  assert.equal(record.slot, slot);
  assert.equal(record.passed, true, `${runId}: ${record.failure ?? record.resourceMeasurementFailure}`);
  assert.equal(record.observations.state, 'sealed');
  assert.equal(record.observations.evaluationTurns, 200);
  assert.equal(record.observations.scenarioStateHashes.length, 200);
  assert.ok(record.observations.agreements >= 0 && record.observations.agreements <= 200);
  assert.ok(record.observations.acceptedChannelEvents > 0);
  assert.equal(record.observations.anchorReceiptCount, 1);
  assert.equal(record.observations.verifierExitCode, 0);
  assert.equal(record.observations.scenarioSeed, config.randomSeed);
  assert.deepEqual(record.observations.seedBindings, config.seedBindings);
  assert.equal(record.observations.externalLearnerContainerCount, 0);
  assert.match(record.observations.nurseryContainerId, /^[a-f0-9]{12}$/u);
  assert.deepEqual(record.observations.roleProcessIds,
    { 'baby-a': record.observations.nurseryProcessId,
      'baby-b': record.observations.nurseryProcessId });
  const bundle = bundleFor(runId);
  const verification = await verifyBundle(bundle, {
    verifierVersion: 'e03-original-full-audit', now: () => new Date().toISOString(),
    writeReport: false,
  });
  assert.equal(verification.exitCode, 0);
  const manifest = read(join(bundle, 'run-manifest.json'));
  assert.equal(manifest.deploymentMode, 'prototype');
  assert.equal(manifest.softwareCommit, executionCommit);
  assert.equal(manifest.runId, runId);
  assert.deepEqual(read(join(bundle, 'configuration', 'run-config.json')), config,
    `${runId}: retained configuration differs from registered packet`);
  const rust = JSON.parse(execFileSync(auditorPath, [bundle],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }));
  assert.equal(rust.integrityPass, true);
  assert.equal(rust.anchored, true);
  const original = reconcileE03OriginalPilotData(bundle, record, condition, runId);
  return {
    runId, condition, slot, use, valid: true, bundleVerified: true,
    agreements: original.agreements, scenarioStateHashes: original.scenarioStateHashes,
    slotPath, slotSha256: sha256(slotPath), logSha256: sha256(join(root, `${runId}.log`)),
    nurseryContainerId: record.observations.nurseryContainerId,
    nurseryProcessId: record.observations.nurseryProcessId,
    roleProcessIds: record.observations.roleProcessIds,
    wallMilliseconds: record.wallMilliseconds,
    nurseryResourceUsage: record.nurseryResourceUsage,
    originalEvidenceBytes: originalBytes(join(root, runId)),
    bundleManifestHash: verification.bundleManifestHash,
    leakageChecks: {
      registeredConfigurationMatched: true, gatewayAndOriginRulesMatched: true,
      deliverySemanticsMatched: true, originalSummaryReconciled: true,
    },
    rust,
  };
}

function invalidReason(error, childStatus) {
  if (childStatus !== 0) return 'infrastructure-failure';
  const message = `${error?.message ?? error}`;
  if (/configuration|registered packet|registration/u.test(message)) return 'configuration-mismatch';
  if (/gateway|channel|delivery|origin/u.test(message)) return 'gateway-control-mismatch';
  return 'verifier-failure';
}

function invalidAttempt(registered, reason, diagnostic, childStatus) {
  const runId = registered.config.runId;
  const slotPath = join(root, runId, 'slot.json');
  const logPath = join(root, `${runId}.log`);
  return {
    runId, condition: registered.condition, slot: registered.slot, use: registered.use,
    valid: false, invalidReason: reason, diagnostic, childExitStatus: childStatus,
    logSha256: sha256(logPath),
    slotPath: existsSync(slotPath) ? slotPath : null,
    slotSha256: existsSync(slotPath) ? sha256(slotPath) : null,
  };
}

function analysisAttempt(attempt) {
  return attempt.valid ? {
    runId: attempt.runId, condition: attempt.condition, slot: attempt.slot,
    use: attempt.use, valid: true, bundleVerified: true,
    agreements: attempt.agreements, scenarioStateHashes: attempt.scenarioStateHashes,
  } : {
    runId: attempt.runId, condition: attempt.condition, slot: attempt.slot,
    use: attempt.use, valid: false, invalidReason: attempt.invalidReason,
  };
}

function resolveLeakageReviews(analysis, validSlots) {
  const byId = new Map(validSlots.map((slot) => [slot.runId, slot]));
  return analysis.leakageReviewRunIds.map((runId) => {
    const slot = byId.get(runId);
    assert.ok(slot, `${runId}: high-seed leakage review lacks a verified original bundle`);
    assert.ok(Object.values(slot.leakageChecks).every(Boolean));
    return {
      runId, resolved: true, observedRate: slot.agreements / 200,
      bundleVerified: true, registeredConfigurationMatched: true,
      gatewayAndOriginRulesMatched: true, deliverySemanticsMatched: true,
      originalSummaryReconciled: true, unplannedLeakageDetected: false,
      basis: 'Individually re-read signed original turns and channel events after both bundle verifiers passed; registered configuration, Gateway origin, delivery semantics, and paired scenario hashes matched.',
    };
  });
}

function replaySchedule(packet, attempts) {
  const replayed = [];
  let cursor = 0;
  while (true) {
    const next = nextE03FullCollectorBatch(packet.runs, replayed.map(analysisAttempt));
    if (next.state === 'done') {
      assert.equal(cursor, attempts.length, 'terminal receipt contains unneeded attempts');
      return next;
    }
    const observed = attempts.slice(cursor, cursor + next.runs.length);
    assert.deepEqual(observed.map((attempt) => attempt.runId),
      next.runs.map((run) => run.config.runId), 'attempt order differs from registered scheduler');
    replayed.push(...observed);
    cursor += observed.length;
  }
}

async function auditTerminal() {
  const receipt = read(join(root, 'receipt.json'));
  assert.equal(receipt.experimentId, 'E03');
  assert.equal(receipt.stage, 'full-qualification');
  assert.equal(receipt.classification, 'registered-original-full-qualification-terminal');
  assert.equal(receipt.attemptStatus, 'completed');
  assert.equal(receipt.controllerFailure, null);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.equal(sha256(join(root, 'registration.json')), receipt.packetSha256);
  assert.equal(sha256(join(root, 'binding.json')), receipt.bindingSha256);
  assert.equal(sha256(join(root, 'admission.json')), receipt.admissionSha256);
  assert.equal(sha256(join(root, 'ald-integrity-auditor')), receipt.auditorSha256);
  const packet = read(join(root, 'registration.json'));
  const validSlots = [];
  const attempts = [];
  for (const recorded of receipt.attempts) {
    const registered = packet.runs.find((run) => run.config.runId === recorded.runId);
    assert.ok(registered, `${recorded.runId}: terminal attempt is not registered`);
    if (recorded.valid) {
      const audited = await auditValidSlot(registered, receipt.executionCommit,
        receipt.registrationHash, join(root, 'ald-integrity-auditor'));
      assert.deepEqual(recorded, audited);
      validSlots.push(audited);
      attempts.push(audited);
    } else {
      assert.ok(['verifier-failure', 'configuration-mismatch',
        'gateway-control-mismatch', 'infrastructure-failure'].includes(recorded.invalidReason));
      assert.equal(sha256(join(root, `${recorded.runId}.log`)), recorded.logSha256);
      assert.equal(recorded.slotPath === null, recorded.slotSha256 === null);
      if (recorded.slotPath !== null) assert.equal(sha256(recorded.slotPath), recorded.slotSha256);
      attempts.push(recorded);
    }
  }
  const terminalSchedule = replaySchedule(packet, attempts);
  assert.deepEqual(receipt.schedulerTerminal, terminalSchedule);
  const analysis = analyzeE03FullQualification({ registered: packet.runs,
    attempted: attempts.map(analysisAttempt),
    analysisSeed: deriveE03FullAnalysisSeed(packet.runs) });
  assert.deepEqual(receipt.analysis, analysis);
  const leakageReviews = resolveLeakageReviews(analysis, validSlots);
  assert.deepEqual(receipt.leakageReviews, leakageReviews);
  assert.equal(receipt.allIncludedEvidenceVerified, true);
  assert.equal(receipt.unplannedLeakageDetected, false);
  assert.equal(receipt.attemptedRuns, attempts.length);
  assert.equal(receipt.validRuns, validSlots.length);
  assert.equal(receipt.invalidRuns, attempts.length - validSlots.length);
  assert.equal(receipt.primaryAttempts, 150);
  assert.equal(receipt.reserveAttempts, attempts.length - 150);
  assert.equal(receipt.attemptedResourceAccounting.completeMeasurement, true);
  assert.deepEqual(receipt.attemptedResourceAccounting.missingComponents, []);
  console.log(`E03 full original audit passed: ${receipt.qualificationDisposition}; no language-emergence finding`);
}

if (mode === '--audit') {
  await auditTerminal();
} else {
  const admission = validateE03FullAdmission();
  assert.equal(existsSync(root), false, 'E03 full original evidence is single-use');
  const auditorPath = '.artifacts/cargo-target/release/ald-integrity-auditor';
  assert.equal(existsSync(auditorPath), true, 'build the retained Rust auditor before collection');
  const executionCommit = git('rev-parse', 'HEAD');
  const packet = read(packetPath);
  const allocation = read(allocationPath);
  const policy = read('protocols/seed-and-resource-allocation.v1.json');
  const started = performance.now();
  mkdirSync(root, { recursive: true });
  copyFileSync(packetPath, join(root, 'registration.json'));
  copyFileSync(bindingPath, join(root, 'binding.json'));
  copyFileSync(allocationPath, join(root, 'allocation.json'));
  copyFileSync(auditorPath, join(root, 'ald-integrity-auditor'));
  writeFileSync(join(root, 'admission.json'), `${JSON.stringify(admission, null, 2)}\n`,
    { flag: 'wx' });
  writeFileSync(join(root, 'attempt.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', stage: 'full-qualification',
    classification: 'registered-original-full-qualification-attempt',
    attemptStatus: 'running', plannedRuns: 168, primaryRuns: 150,
    maximumReserveRuns: 18, attemptedRuns: 0, completedValidRuns: 0,
    controllerPid: process.pid, controllerStartTicks: controllerStartTicks(process.pid),
    executionCommit, registrationHash: packet.preRegistrationHash,
    packetSha256: sha256(join(root, 'registration.json')),
    admissionSha256: sha256(join(root, 'admission.json')),
    startedAt: new Date().toISOString(), researchFinding: false,
    scientificDisposition: 'not-tested', externalSpend: 0,
    publicChainTransaction: false,
  }, null, 2)}\n`, { flag: 'wx' });
  const environment = { ...process.env, ALD_SOFTWARE_COMMIT: executionCommit,
    ALD_LEARNER_TRACK: 'no-learning', ALD_MODE_R_NURSERY_UID: String(process.getuid()),
    ALD_MODE_R_NURSERY_GID: String(process.getgid()),
    ALD_MODE_R_EVIDENCE_DIR: resolve(root) };
  const compose = ['compose', '--project-name', project,
    '--file', 'deploy/mode-r/docker-compose.yml',
    '--file', 'deploy/mode-r/docker-compose.e02.yml'];
  const command = (args) => {
    const result = spawnSync('docker', args, { env: environment, encoding: 'utf8',
      timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  const attempts = [];
  const validSlots = [];
  let controllerFailure = null;
  let failureStage = 'container-build';
  try {
    command([...compose, 'build', 'nursery-study']);
    while (true) {
      const next = nextE03FullCollectorBatch(packet.runs, attempts.map(analysisAttempt));
      if (next.state === 'done') break;
      for (const registered of next.runs) {
        const runId = registered.config.runId;
        failureStage = 'slot-collection';
        const log = createWriteStream(join(root, `${runId}.log`), { flags: 'wx' });
        const status = await new Promise((resolveStatus, reject) => {
          const child = spawn('docker', [...compose, 'run', '--rm', '--no-deps',
            '--name', `${project}-nursery`, '--entrypoint', '/usr/local/bin/node',
            'nursery-study', '/app/deploy/mode-r/run-e03-pilot-slot.mjs', runId,
            executionCommit], { env: environment, timeout: 2 * 60 * 60 * 1_000 });
          for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
            log.write(chunk); process.stdout.write(chunk);
          });
          child.once('error', reject);
          child.once('close', (code) => log.end(() => resolveStatus(code)));
          log.once('error', reject);
        });
        let attempt;
        if (status === 0) {
          try {
            failureStage = 'original-slot-audit';
            attempt = await auditValidSlot(registered, executionCommit,
              packet.preRegistrationHash, join(root, 'ald-integrity-auditor'));
            assert.equal(validSlots.some((slot) =>
              slot.nurseryContainerId === attempt.nurseryContainerId), false,
            `${runId}: original full-stage Nursery container was reused`);
            validSlots.push(attempt);
          } catch (error) {
            attempt = invalidAttempt(registered, invalidReason(error, status),
              `${error.name}: ${error.message}`, status);
          }
        } else {
          attempt = invalidAttempt(registered, 'infrastructure-failure',
            `collector exited with status ${String(status)}`, status);
        }
        attempts.push(attempt);
        failureStage = 'resource-accounting';
        const resources = reconcileE03PilotAttemptResources(root,
          attempts.map((row) => row.runId), validSlots, process.resourceUsage());
        assert.equal(resources.completeMeasurement, true,
          `${runId}: resource usage is incomplete; safe continuation is not established`);
        assert.ok(resources.measuredCpuHoursLowerBound <= allocation.reservedCpuHours,
          `${runId}: full-stage CPU exceeded its prospective reserve`);
        const evidenceGiB = originalBytes(root) / gib;
        assert.ok(evidenceGiB <= allocation.reservedWorkingStorageGiB,
          `${runId}: full-stage evidence exceeded its prospective reserve`);
        assert.ok(allocation.priorCpuHoursCharged + resources.measuredCpuHoursLowerBound <=
          policy.localCeiling.cpuHours, `${runId}: total charged CPU exceeded the local ceiling`);
        assert.ok(allocation.priorRetainedStorageGiB + evidenceGiB <=
          policy.localCeiling.workingStorageGiB,
        `${runId}: total retained evidence exceeded the local ceiling`);
        const operational = read(join(root, runId, 'slot.json'));
        assert.ok((operational.nurseryResourceUsage.peakBytes +
          process.resourceUsage().maxRSS * 1024) / gib <= allocation.maximumResidentGiB,
        `${runId}: resident-memory peak exceeded its prospective reserve`);
        writeFileSync(join(root, `progress-${String(attempts.length).padStart(3, '0')}.json`),
          `${JSON.stringify({ attemptedRuns: attempts.length, validRuns: validSlots.length,
            invalidRuns: attempts.length - validSlots.length, lastRunId: runId,
            lastRunValid: attempt.valid, measuredCpuHours: resources.measuredCpuHoursLowerBound,
            evidenceBytesBeforeProgressReceipt: originalBytes(root),
            capturedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
        failureStage = 'slot-cleanup';
        command([...compose, 'down', '--remove-orphans']);
        console.log(`E03 full ${attempts.length}/168 maximum: ${runId} ${attempt.valid ? 'verified' : 'retained invalid'}; no language claim`);
      }
    }
  } catch (error) {
    controllerFailure = `${error.name}: ${error.message}`;
  } finally {
    if (spawnSync('docker', ['inspect', `${project}-nursery`], { stdio: 'ignore' }).status === 0) {
      try { command(['stop', '--time', '30', `${project}-nursery`]); }
      catch (error) { controllerFailure = `${controllerFailure ?? ''} stop failed: ${error.message}`; }
    }
    try { command([...compose, 'down', '--remove-orphans']); }
    catch (error) { controllerFailure = `${controllerFailure ?? ''} cleanup failed: ${error.message}`; }
  }
  const attemptedResourceAccounting = reconcileE03PilotAttemptResources(root,
    attempts.map((attempt) => attempt.runId), validSlots, process.resourceUsage());
  let schedulerTerminal = null;
  let analysis = null;
  let leakageReviews = [];
  if (controllerFailure === null) {
    schedulerTerminal = nextE03FullCollectorBatch(packet.runs, attempts.map(analysisAttempt));
    assert.equal(schedulerTerminal.state, 'done');
    analysis = analyzeE03FullQualification({ registered: packet.runs,
      attempted: attempts.map(analysisAttempt),
      analysisSeed: deriveE03FullAnalysisSeed(packet.runs) });
    leakageReviews = resolveLeakageReviews(analysis, validSlots);
  }
  const qualificationDisposition = analysis === null ? 'execution-failed' :
    analysis.numericDisposition === 'incomplete' ? 'incomplete' :
      analysis.numericDisposition;
  const evidenceBytesBeforeTerminalReceipt = originalBytes(root);
  writeFileSync(join(root, 'receipt.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', stage: 'full-qualification',
    classification: 'registered-original-full-qualification-terminal',
    attemptStatus: controllerFailure === null ? 'completed' : 'failed',
    researchFinding: false, scientificDisposition: 'not-tested',
    qualificationDisposition,
    qualificationPassed: qualificationDisposition === 'thresholds-met',
    executionCommit, registrationHash: packet.preRegistrationHash,
    packetSha256: sha256(join(root, 'registration.json')),
    bindingSha256: sha256(join(root, 'binding.json')),
    admissionSha256: sha256(join(root, 'admission.json')),
    allocationSha256: sha256(join(root, 'allocation.json')),
    auditorSha256: sha256(join(root, 'ald-integrity-auditor')),
    plannedRuns: 168, primaryAttempts: attempts.filter((row) => row.use === 'primary').length,
    reserveAttempts: attempts.filter((row) => row.use === 'reserve').length,
    attemptedRuns: attempts.length, validRuns: validSlots.length,
    invalidRuns: attempts.length - validSlots.length,
    unattemptedRuns: 168 - attempts.length, attempts, schedulerTerminal,
    analysis, leakageReviews,
    allIncludedEvidenceVerified: analysis !== null &&
      analysis.reconciliation.includedPairs.length * 6 ===
        analysis.reconciliation.includedPairs.flatMap((pair) => Object.values(pair.runIds))
          .filter((runId) => validSlots.some((slot) => slot.runId === runId)).length,
    unplannedLeakageDetected: false,
    controllerFailure, failureStage, attemptedResourceAccounting,
    wallMilliseconds: performance.now() - started,
    measuredCpuHours: attemptedResourceAccounting.measuredCpuHoursLowerBound,
    evidenceBytesBeforeTerminalReceipt,
    remainingCpuHours: attemptedResourceAccounting.completeMeasurement
      ? policy.localCeiling.cpuHours - allocation.priorCpuHoursCharged -
        attemptedResourceAccounting.measuredCpuHoursLowerBound : null,
    remainingWorkingStorageGiB: policy.localCeiling.workingStorageGiB -
      allocation.priorRetainedStorageGiB - evidenceBytesBeforeTerminalReceipt / gib,
    hostResourceUsage: process.resourceUsage(), externalSpend: 0,
    publicChainTransaction: false,
    claimBoundary: 'Registered E03 Prototype-Mode chance-control qualification only. A passing numeric disposition qualifies the downstream control baseline; it is not Research-Grade isolation or a language-emergence finding.',
  }, null, 2)}\n`, { flag: 'wx' });
  if (controllerFailure !== null) process.exitCode = 1;
}
