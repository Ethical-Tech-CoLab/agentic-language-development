import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function checkE03FullState(entry) {
  const fullEvidence = entry?.evidence?.some((item) =>
    item.kind === 'portable-full-terminal-summary' ||
    item.path === 'evidence/qualification/e03-full-v1/receipt.json');
  if (entry?.executionReadiness.stage !== 'qualification' ||
      entry.executionReadiness.decision !== 'complete') {
    if (fullEvidence) {
      throw new Error('E03 full terminal receipt exists but is not the completed status authority');
    }
    return;
  }

  const evidencePath = (kind) => entry.evidence.find((item) => item.kind === kind)?.path;
  const packetPath = evidencePath('prospective-registration-packet');
  const bindingPath = evidencePath('simulated-registration-binding');
  const allocationPath = evidencePath('prospective-full-stage-allocation');
  const reservePath = evidencePath('prospective-paired-reserve-amendment');
  const originalPath = evidencePath('terminal-receipt');
  const portablePath = evidencePath('portable-full-terminal-summary');
  if (!packetPath || !bindingPath || !allocationPath || !reservePath ||
      !originalPath || !portablePath ||
      !entry.evidence.some((item) => item.path === originalPath && item.statusAuthority) ||
      !existsSync(portablePath)) {
    throw new Error('E03 completed full qualification lacks packet, binding, original authority, or portable summary');
  }

  const packetBytes = readFileSync(packetPath);
  const bindingBytes = readFileSync(bindingPath);
  const allocationBytes = readFileSync(allocationPath);
  const reserveBytes = readFileSync(reservePath);
  const packet = JSON.parse(packetBytes.toString('utf8'));
  const portable = JSON.parse(readFileSync(portablePath, 'utf8'));
  if (portable.classification !== 'portable-original-full-qualification-status-summary' ||
      portable.experimentId !== 'E03' || portable.attemptVersion !== 'v1' ||
      portable.stage !== 'full-qualification' || portable.attemptStatus !== 'completed' ||
      portable.qualificationDisposition !== 'thresholds-met' || portable.passed !== true ||
      portable.failure !== null || portable.registrationHash !== packet.preRegistrationHash ||
      portable.packetPath !== packetPath || portable.packetSha256 !== sha256(packetBytes) ||
      portable.bindingPath !== bindingPath || portable.bindingSha256 !== sha256(bindingBytes) ||
      portable.allocationPath !== allocationPath ||
      portable.allocationSha256 !== sha256(allocationBytes) ||
      packet.artifact?.parameters?.executionBinding?.reserveDesignAmendment?.sha256 !==
        sha256(reserveBytes) ||
      portable.originalReceiptPath !== originalPath ||
      !/^sha256:[0-9a-f]{64}$/u.test(portable.originalReceiptSha256) ||
      portable.auditCommand !== 'pnpm run audit:e03-full:live' ||
      portable.auditExitStatus !== 0 || portable.originalBundlesRecomputed !== 150 ||
      portable.typescriptVerifierPassed !== true || portable.retainedRustAuditorPassed !== true ||
      portable.registeredAnalysisRecomputed !== true || portable.plannedRuns !== 168 ||
      portable.primaryRuns !== 150 || portable.maximumReserveRuns !== 18 ||
      portable.attemptedRuns !== 150 || portable.completedRuns !== 150 ||
      portable.validRuns !== 150 || portable.invalidRuns !== 0 ||
      portable.reserveRunsAttempted !== 0 || portable.unattemptedRuns !== 18 ||
      portable.unattemptedReserveRuns !== 18 || portable.includedPairedSlots !== 25 ||
      portable.criteria?.allControlsEquivalent !== true ||
      portable.criteria?.oracleAdequate !== true ||
      portable.criteria?.allSeparationsMeet !== true || portable.unmetCriteria?.length !== 0 ||
      portable.caseAuditTriggers?.length !== 0 || portable.leakageReviewRunIds?.length !== 0 ||
      portable.oracle?.seeds !== 25 || portable.oracle?.meetsAdequacy !== true ||
      portable.controls?.length !== 5 || portable.controls.some((control) =>
        control.seeds !== 25 || control.equivalenceDecision !== 'equivalent' ||
        control.separationMeets !== true || control.highSeedCount !== 0) ||
      portable.resources?.completeMeasurement !== true ||
      portable.allIncludedEvidenceVerified !== true ||
      portable.unplannedLeakageDetected !== false || portable.researchFinding !== false ||
      portable.scientificDisposition !== 'not-tested' || portable.externalSpend !== 0 ||
      portable.publicChainTransaction !== false || entry.attempt.status !== 'completed' ||
      entry.attempt.planned !== 168 || entry.attempt.attempted !== 150 ||
      entry.attempt.completed !== 150 || entry.scientificDisposition !== 'not-tested') {
    throw new Error('E03 portable full-stage status contradicts its packet or campaign state');
  }
  if (existsSync(originalPath)) {
    const originalBytes = readFileSync(originalPath);
    const original = JSON.parse(originalBytes.toString('utf8'));
    if (sha256(originalBytes) !== portable.originalReceiptSha256 ||
        original.executionCommit !== portable.executionCommit ||
        original.registrationHash !== portable.registrationHash ||
        original.qualificationDisposition !== 'thresholds-met' ||
        original.qualificationPassed !== true || original.attemptedRuns !== 150 ||
        original.validRuns !== 150 || original.invalidRuns !== 0 ||
        original.unattemptedRuns !== 18 || original.researchFinding !== false ||
        original.scientificDisposition !== 'not-tested') {
      throw new Error('E03 retained original full-stage receipt contradicts the portable summary');
    }
  }
}
