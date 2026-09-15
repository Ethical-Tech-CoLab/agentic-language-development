import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function checkE03LocalPilotState(entry, completionSupplement, powerSupplement,
  decisionSupplement, fullAllocationSupplement) {
  if (entry?.executionReadiness.stage !== 'pilot') return;
  const packetPath = entry.evidence.find((item) =>
    item.kind === 'prospective-registration-packet')?.path;
  const attemptVersion = packetPath?.endsWith('.v3.json') ? 'v3' :
    packetPath?.endsWith('.v2.json') ? 'v2' : 'v1';
  const terminalPath = `evidence/pilots/e03-blinded-${attemptVersion}/receipt.json`;
  const attemptPath = `evidence/pilots/e03-blinded-${attemptVersion}/attempt.json`;
  const inputPath = `evidence/pilots/e03-blinded-${attemptVersion}/sample-size-input.json`;
  const portablePath = entry.evidence.find((item) =>
    item.kind === 'portable-terminal-summary')?.path;
  const isAuthority = (path) => entry.evidence.some((item) =>
    item.path === path && item.statusAuthority);

  if (entry.attempt.status === 'completed' &&
      (portablePath || !existsSync(terminalPath))) {
    if (!packetPath || !portablePath || !existsSync(portablePath) || !isAuthority(terminalPath)) {
      throw new Error('E03 completed pilot lacks its original authority or tracked portable summary');
    }
    const packetBytes = readFileSync(packetPath);
    const packet = JSON.parse(packetBytes.toString('utf8'));
    const portable = JSON.parse(readFileSync(portablePath, 'utf8'));
    if (portable.classification !== 'portable-original-pilot-status-summary' ||
        portable.experimentId !== 'E03' || portable.stage !== 'blinded-pilot' ||
        portable.version !== attemptVersion || portable.executionCommit !==
          '666402503a5ed21c8cc2a9eadf762af4199bffdb' ||
        portable.registrationHash !== packet.preRegistrationHash ||
        portable.packetSha256 !== sha256(packetBytes) ||
        portable.originalReceiptPath !== terminalPath ||
        portable.sampleSizeInputPath !== inputPath ||
        !/^sha256:[0-9a-f]{64}$/u.test(portable.originalReceiptSha256) ||
        !/^sha256:[0-9a-f]{64}$/u.test(portable.sampleSizeInputSha256) ||
        portable.plannedRuns !== 120 || portable.attemptedRuns !== 120 ||
        portable.completedRuns !== 120 || portable.validRuns !== 120 ||
        portable.invalidRuns !== 0 || portable.abortedRuns !== 0 ||
        portable.unattemptedRuns !== 0 || portable.replacedRuns !== 0 ||
        portable.passed !== true || portable.failure !== null ||
        portable.selectedPrimarySeeds !== 25 || portable.researchFinding !== false ||
        portable.scientificDisposition !== 'not-tested' || portable.externalSpend !== 0 ||
        portable.publicChainTransaction !== false || entry.attempt.planned !== 120 ||
        entry.attempt.attempted !== 120 || entry.attempt.completed !== 120 ||
        entry.executionReadiness.decision !== 'complete' ||
        entry.scientificDisposition !== 'not-tested') {
      throw new Error('E03 portable pilot status contradicts its packet or campaign state');
    }
    if (completionSupplement &&
        (completionSupplement.terminalSha256 !== portable.originalReceiptSha256 ||
         completionSupplement.sampleSizeInputSha256 !== portable.sampleSizeInputSha256 ||
         completionSupplement.selectedPrimarySeeds !== portable.selectedPrimarySeeds)) {
      throw new Error('E03 portable pilot status contradicts the dated completion supplement');
    }
    if (existsSync(terminalPath) &&
        sha256(readFileSync(terminalPath)) !== portable.originalReceiptSha256) {
      throw new Error('E03 retained original terminal receipt contradicts the portable digest');
    }
    if (existsSync(inputPath) && !existsSync(terminalPath)) {
      throw new Error('E03 retained reduction exists without its original terminal receipt');
    }
    if (existsSync(inputPath)) {
      if (sha256(readFileSync(inputPath)) !== portable.sampleSizeInputSha256 ||
          JSON.parse(readFileSync(inputPath, 'utf8')).selectedPrimarySeeds !== 25) {
        throw new Error('E03 retained reduction contradicts the portable digest or selected row');
      }
    } else if (existsSync(terminalPath)) {
      throw new Error('E03 retained original terminal receipt lacks its audited reduction');
    }
    if (powerSupplement && attemptVersion === 'v3') {
      if (powerSupplement.originalPath !==
          'evidence/pilots/e03-blinded-v3/power-selection.json' ||
          !/^sha256:[0-9a-f]{64}$/u.test(powerSupplement.originalSha256) ||
          powerSupplement.primarySeeds !== 25 ||
          powerSupplement.repetitions !== 30000 ||
          powerSupplement.invalidAsFailureSensitivitySuccesses !== 0) {
        throw new Error('E03 power supplement has an invalid evidence identity or boundary');
      }
      if (existsSync(powerSupplement.originalPath)) {
        const powerBytes = readFileSync(powerSupplement.originalPath);
        const power = JSON.parse(powerBytes.toString('utf8'));
        if (sha256(powerBytes) !== powerSupplement.originalSha256 ||
            power.experimentId !== 'E03' || power.selectedPrimarySeeds !== 25 ||
            power.monteCarloRepetitions !== 30000 ||
            power.numericRule?.lower95 !== powerSupplement.nominalCompleteRuleLower95 ||
            power.invalidAsFailureSensitivity?.successes !== 0 ||
            power.researchFinding !== false || power.scientificDisposition !== 'not-tested') {
          throw new Error('E03 retained power calculation contradicts its dated supplement');
        }
      } else if (existsSync(terminalPath)) {
        throw new Error('E03 retained original pilot lacks its separately recorded power calculation');
      }
      if (decisionSupplement) {
        const decisionPath = entry.evidence.find((item) =>
          item.kind === 'outcome-blind-sample-size-decision')?.path;
        if (decisionPath !== decisionSupplement.path ||
            decisionPath !== 'protocols/e03-sample-size-decision.v1.json' ||
            !existsSync(decisionPath)) {
          throw new Error('E03 selected design decision lacks its tracked evidence path');
        }
        const decisionBytes = readFileSync(decisionPath);
        const decision = JSON.parse(decisionBytes.toString('utf8'));
        if (sha256(decisionBytes) !== decisionSupplement.sha256 ||
            decision.version !== 1 ||
            decision.classification !== 'outcome-blind-pilot-sample-size-selection' ||
            decision.pilotRegistrationHash !== packet.preRegistrationHash ||
            decision.pilotReceiptSha256 !== portable.originalReceiptSha256 ||
            decision.pilotReductionSha256 !== portable.sampleSizeInputSha256 ||
            decision.powerReceiptSha256 !== powerSupplement.originalSha256 ||
            decision.selectedPrimarySeeds !== decisionSupplement.selectedPrimarySeeds ||
            decision.selectedPrimarySeeds !== 25 ||
            decision.monteCarloRepetitions !== 30000 ||
            decision.monteCarloLower95 !== powerSupplement.nominalCompleteRuleLower95 ||
            decision.invalidAsFailureSensitivity?.forcedFailuresPerCondition !== 2 ||
            decision.invalidAsFailureSensitivity?.successes !== 0) {
          throw new Error('E03 tracked design decision contradicts its source digests or limitation');
        }
        if (fullAllocationSupplement) {
          const allocationPath = entry.evidence.find((item) =>
            item.kind === 'prospective-full-stage-allocation')?.path;
          if (allocationPath !== fullAllocationSupplement.path ||
              allocationPath !== 'protocols/e03-full-resource-allocation.v1.json' ||
              !existsSync(allocationPath)) {
            throw new Error('E03 full-stage allocation lacks its tracked evidence path');
          }
          const allocationBytes = readFileSync(allocationPath);
          const allocation = JSON.parse(allocationBytes.toString('utf8'));
          if (sha256(allocationBytes) !== fullAllocationSupplement.sha256 ||
              allocation.experimentId !== 'E03' ||
              allocation.classification !== 'prospective-local-stage-allocation' ||
              allocation.stage !== 'full-qualification' ||
              allocation.plannedRuns !== fullAllocationSupplement.plannedRuns ||
              allocation.plannedRuns !== 168 ||
              allocation.primarySlotsPerCondition !== 25 ||
              allocation.reserveSlotsPerCondition !== 3 ||
              allocation.maximumParallelRuns !== 1 ||
              allocation.priorRetainedStorageGiB !==
                fullAllocationSupplement.priorRetainedStorageGiB ||
              allocation.sampleSizeDecisionSha256 !== decisionSupplement.sha256 ||
              allocation.pilotMeasurementSourceSha256 !==
                portable.originalReceiptSha256 ||
              allocation.policySourceSha256 !==
                sha256(readFileSync('protocols/seed-and-resource-allocation.v1.json')) ||
              allocation.externalSpend !== 0 ||
              allocation.publicChainTransaction !== false ||
              allocation.researchFinding !== false) {
            throw new Error('E03 tracked full allocation contradicts its pilot or decision identity');
          }
        }
      }
    }
  }

  if (existsSync(terminalPath)) {
    if (!packetPath || !isAuthority(terminalPath)) {
      throw new Error('E03 pilot terminal receipt exists but is not the status authority');
    }
    const packetBytes = readFileSync(packetPath);
    const packet = JSON.parse(packetBytes.toString('utf8'));
    const terminal = JSON.parse(readFileSync(terminalPath, 'utf8'));
    if (terminal.experimentId !== 'E03' || terminal.stage !== 'blinded-pilot' ||
        terminal.registrationHash !== packet.preRegistrationHash ||
        terminal.packetSha256 !== sha256(packetBytes) || terminal.plannedRuns !== 120 ||
        terminal.researchFinding !== false || terminal.scientificDisposition !== 'not-tested' ||
        terminal.externalSpend !== 0 || terminal.publicChainTransaction !== false) {
      throw new Error('E03 pilot terminal receipt contradicts its prospective packet or zero-spend scope');
    }
    if (entry.attempt.planned !== 120 ||
        entry.attempt.attempted !== terminal.attemptedRuns ||
        entry.attempt.completed !== terminal.completedRuns ||
        !Array.isArray(terminal.slots) || terminal.slots.length !== terminal.completedRuns) {
      throw new Error('E03 accounting contradicts its status-authority receipt');
    }
    const complete = terminal.passed === true && terminal.failure === null &&
      terminal.attemptedRuns === 120 && terminal.completedRuns === 120 &&
      entry.attempt.status === 'completed' && entry.executionReadiness.decision === 'complete';
    const failed = terminal.passed === false &&
      typeof terminal.failure === 'string' && terminal.failure.length > 0 &&
      entry.attempt.status === 'failed' && entry.executionReadiness.decision === 'blocked';
    if (!complete && !failed) {
      throw new Error('E03 pilot terminal disposition contradicts current progress');
    }
    return;
  }

  if (!existsSync(attemptPath)) {
    if (entry.attempt.status === 'completed') return;
    if (entry.attempt.status === 'running') {
      throw new Error('E03 pilot running status has no original start evidence');
    }
    return;
  }
  if (entry.attempt.status === 'completed') {
    throw new Error('E03 completed pilot has start evidence but no original terminal receipt');
  }
  if (entry.attempt.status !== 'running' || !packetPath || !isAuthority(attemptPath)) {
    throw new Error('E03 pilot attempt exists but is not an evidence-backed running state');
  }
  const packetBytes = readFileSync(packetPath);
  const packet = JSON.parse(packetBytes.toString('utf8'));
  const attempt = JSON.parse(readFileSync(attemptPath, 'utf8'));
  if (attempt.experimentId !== 'E03' || attempt.stage !== 'blinded-pilot' ||
      attempt.classification !== 'registered-original-pilot-attempt' ||
      attempt.attemptStatus !== 'running' || attempt.plannedSlots !== 120 ||
      attempt.attemptedSlots !== 0 || attempt.completedSlots !== 0 ||
      attempt.registrationHash !== packet.preRegistrationHash ||
      attempt.packetSha256 !== sha256(packetBytes) || attempt.plannedRuns !== 120 ||
      attempt.researchFinding !== false || attempt.scientificDisposition !== 'not-tested' ||
      attempt.externalSpend !== 0 || attempt.publicChainTransaction !== false ||
      entry.attempt.planned !== 120 || entry.attempt.attempted !== 0 ||
      entry.attempt.completed !== 0 || !Number.isSafeInteger(attempt.controllerPid) ||
      attempt.controllerPid <= 0 || typeof attempt.controllerStartTicks !== 'string' ||
      !/^[0-9]+$/u.test(attempt.controllerStartTicks)) {
    throw new Error('E03 pilot running receipt contradicts its prospective packet or controller identity');
  }
  const statPath = `/proc/${attempt.controllerPid}/stat`;
  const commandPath = `/proc/${attempt.controllerPid}/cmdline`;
  if (!existsSync(statPath) || !existsSync(commandPath)) {
    throw new Error('E03 pilot running attempt has no live controller');
  }
  const stat = readFileSync(statPath, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (fields[0] === 'Z' || fields[19] !== attempt.controllerStartTicks ||
      !readFileSync(commandPath, 'utf8').includes('run-e03-registered-pilot.mjs')) {
    throw new Error('E03 pilot running attempt has no live controller');
  }
}
