import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const terminalPath = 'evidence/pilots/e03-blinded-v1/receipt.json';
const attemptPath = 'evidence/pilots/e03-blinded-v1/attempt.json';
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function checkE03LocalPilotState(entry) {
  if (entry?.executionReadiness.stage !== 'pilot') return;
  const packetPath = entry.evidence.find((item) =>
    item.kind === 'prospective-registration-packet')?.path;
  const isAuthority = (path) => entry.evidence.some((item) =>
    item.path === path && item.statusAuthority);

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
    if (entry.attempt.status === 'running') {
      throw new Error('E03 pilot running status has no original start evidence');
    }
    return;
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
