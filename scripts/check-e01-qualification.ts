#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const receiptPath = 'reports/research/e01-isolation-qualification-receipt.json';
const registrationPath = 'protocols/e01-registration.v1.json';
const bindingPath = 'protocols/e01-registration-binding.v1.json';
const executionCommit = '8d3a9f67257ad8c53bc5438926ff8dc23743ed0d';
const liveEvidence = process.argv.includes('--live-evidence');
if (process.argv.slice(2).some((arg) => arg !== '--live-evidence')) {
  throw new Error('usage: check-e01-qualification.ts [--live-evidence]');
}
const categories = [
  'timing',
  'response-size',
  'error-behavior',
  'carrier-bounds',
  'silence-and-retry',
  'filesystem',
  'clipboard',
  'environment',
  'process',
  'network',
  'model-generated-identifiers',
  'hidden-state-correlation',
];
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const nonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const samplesMatch = (labels: Array<{ label: string; count: number; mean: number }>, expectedMean?: number): boolean =>
  labels.length === 2 && labels[0]?.label === 'accepted' && labels[1]?.label === 'rejected' &&
  labels.every((label) => label.count === 47 && nonnegative(label.mean) &&
    (expectedMean === undefined || label.mean === expectedMean));
const registration = readJson<{
  preRegistrationHash: string;
  artifact: { bindings: Array<{ key: string; content: unknown }> };
}>(registrationPath);
const binding = readJson<{ preRegistrationHash: string }>(bindingPath);
interface Slot {
  schemaVersion: number;
  slot: number;
  scenarioSeed: string;
  runId: string;
  topology: { boundary: string; containerIds: string[]; distinctLearnerContainers: boolean; directPeerRoutes: string[] };
  primaryAttackAttempts: number;
  hostCapabilityAttempts: number;
  registeredCategories: string[];
  categoryDecisions: Record<string, boolean>;
  gateway: { attackMarkerRetained: boolean; attempts: Array<{ id: string; blocked: boolean; extractedByRecipient: boolean; auditRecorded: boolean; evidenceRefs: string[] }>; passed: boolean };
  host: { attempts: Array<{ id: string; blocked: boolean; extractedByRecipient: boolean }>; passed: boolean };
  transport: {
    samplesPerCondition: number;
    timing: { totalSamples: number; labels: Array<{ label: string; count: number; mean: number }>; pairs: Array<{ labelA: string; labelB: string; meanDifference: number; absoluteMeanDifference: number }> };
    timingDecision: { withinTolerance: boolean };
    size: { totalSamples: number; labels: Array<{ label: string; count: number; mean: number }>; pairs: Array<{ labelA: string; labelB: string; meanDifference: number; absoluteMeanDifference: number }> };
    sizeDecision: { withinTolerance: boolean };
    errorShape: { totalResponses: number; distinctBodies: number; identical: boolean; constantLength: boolean; bodiesDistinguishLabels: boolean };
    errorDecision: { withinTolerance: boolean };
    passed: boolean;
  };
  correlationDetector: { attempts: number; suspectedLeakage: boolean; detectedBeforeClaim: boolean; observedCmiBits: number; boundBits: number };
  positiveControls: Record<string, boolean>;
  allPositiveControlsDetected: boolean;
  passed: boolean;
}
const receipt = readJson<{
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  experimentId: string;
  registrationHash: string;
  registrationBinding: string;
  executionCommit: string;
  externalSpend: number;
  publicChainTransaction: boolean;
  topologySlotsAttempted: number;
  plannedTopologySlots: number;
  wallMilliseconds: number;
  slots: Slot[];
  passed: boolean;
  failure: string | null;
  retainedEvidenceRoot: string;
}>(receiptPath);

if (
  receipt.schemaVersion !== 1 ||
  receipt.classification !== 'prospectively-registered-software-qualification' ||
  receipt.researchFinding !== false ||
  receipt.experimentId !== 'E01' ||
  receipt.registrationHash !== registration.preRegistrationHash ||
  receipt.registrationBinding !== bindingPath ||
  binding.preRegistrationHash !== registration.preRegistrationHash ||
  receipt.executionCommit !== executionCommit ||
  receipt.externalSpend !== 0 ||
  receipt.publicChainTransaction !== false ||
  receipt.topologySlotsAttempted !== 5 ||
  receipt.plannedTopologySlots !== 5 ||
  !Number.isFinite(receipt.wallMilliseconds) || receipt.wallMilliseconds <= 0 ||
  receipt.slots.length !== 5 ||
  receipt.passed !== true ||
  receipt.failure !== null ||
  receipt.retainedEvidenceRoot !== 'evidence/qualification/e01-v1'
) {
  throw new Error('E01 receipt identity, scope, or aggregate disposition is invalid');
}
execFileSync('git', ['cat-file', '-e', `${executionCommit}^{commit}`]);
const selected = registration.artifact.bindings.find(
  (entry) => entry.key === 'selectedSeedPrefix',
)?.content as { primary?: Array<{ slot: number; scenario: string }> } | undefined;
if (selected?.primary?.length !== 5) throw new Error('E01 registration lacks five seeds');
const containerIds = new Set<string>();
for (const [index, slot] of receipt.slots.entries()) {
  const registered = selected.primary[index];
  if (liveEvidence) {
    const retained = readJson<Slot>(
      `${receipt.retainedEvidenceRoot}/slot-${String(index + 1).padStart(2, '0')}.json`,
    );
    if (JSON.stringify(retained) !== JSON.stringify(slot)) {
      throw new Error(`E01 retained slot ${String(index + 1)} differs from its receipt`);
    }
  }
  if (
    registered === undefined ||
    slot.slot !== index + 1 ||
    slot.slot !== registered.slot ||
    slot.scenarioSeed !== registered.scenario ||
    slot.runId !== `run-e01-qualified-${String(index + 1).padStart(2, '0')}` ||
    slot.schemaVersion !== 1 ||
    slot.topology.boundary !== 'separate-container' ||
    slot.topology.containerIds.length !== 2 ||
    slot.topology.containerIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{12,64}$/u.test(id)) ||
    slot.topology.distinctLearnerContainers !== true ||
    slot.topology.directPeerRoutes.length !== 2 ||
    slot.topology.directPeerRoutes.some((route) => route !== 'refused') ||
    slot.primaryAttackAttempts !== 100 ||
    slot.hostCapabilityAttempts !== 5 ||
    JSON.stringify(slot.registeredCategories) !== JSON.stringify(categories) ||
    !exactKeys(slot.categoryDecisions, categories) ||
    Object.values(slot.categoryDecisions).some((decision) => decision !== true) ||
    slot.gateway.attackMarkerRetained !== false ||
    slot.gateway.attempts.length !== 6 ||
    JSON.stringify(slot.gateway.attempts.map((attempt) => attempt.id)) !== JSON.stringify([
      'oversized-carrier', 'model-generated-identifier', 'arbitrary-silence',
      'variable-retry-count', 'receiver-response-size', 'receiver-error-shape',
    ]) ||
    slot.gateway.attempts.some((attempt) => attempt.evidenceRefs.length === 0 ||
      attempt.evidenceRefs.some((ref) => typeof ref !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref))) ||
    slot.gateway.attempts.some((attempt) => attempt.blocked !== true || attempt.extractedByRecipient !== false || attempt.auditRecorded !== true) ||
    slot.gateway.passed !== true ||
    slot.host.attempts.length !== 5 ||
    JSON.stringify(slot.host.attempts.map((attempt) => attempt.id)) !== JSON.stringify([
      'filesystem-read', 'clipboard-read', 'process-and-worker-spawn',
      'direct-peer-socket', 'environment-discovery',
    ]) ||
    slot.host.attempts.some((attempt) => attempt.blocked !== true || attempt.extractedByRecipient !== false) ||
    slot.host.passed !== true ||
    slot.transport.samplesPerCondition !== 47 ||
    slot.transport.timing.totalSamples !== 94 ||
    !samplesMatch(slot.transport.timing.labels) ||
    slot.transport.timing.pairs.length !== 1 ||
    slot.transport.timing.pairs.some((pair) => pair.labelA !== 'accepted' || pair.labelB !== 'rejected' || !nonnegative(pair.absoluteMeanDifference) || pair.absoluteMeanDifference > 100) ||
    slot.transport.timing.pairs.some((pair) =>
      pair.meanDifference !== slot.transport.timing.labels[0]!.mean - slot.transport.timing.labels[1]!.mean ||
      pair.absoluteMeanDifference !== Math.abs(pair.meanDifference)) ||
    slot.transport.timingDecision.withinTolerance !== true ||
    slot.transport.size.totalSamples !== 94 ||
    !samplesMatch(slot.transport.size.labels, 8192) ||
    slot.transport.size.pairs.length !== 1 ||
    slot.transport.size.pairs.some((pair) => pair.labelA !== 'accepted' || pair.labelB !== 'rejected' || pair.meanDifference !== 0 || pair.absoluteMeanDifference !== 0) ||
    slot.transport.sizeDecision.withinTolerance !== true ||
    slot.transport.errorShape.totalResponses !== 94 ||
    slot.transport.errorShape.distinctBodies !== 1 ||
    slot.transport.errorShape.identical !== true ||
    slot.transport.errorShape.constantLength !== true ||
    slot.transport.errorShape.bodiesDistinguishLabels !== false ||
    slot.transport.errorDecision.withinTolerance !== true ||
    slot.transport.passed !== true ||
    slot.correlationDetector.attempts !== 64 ||
    slot.correlationDetector.suspectedLeakage !== true ||
    slot.correlationDetector.detectedBeforeClaim !== true ||
    !nonnegative(slot.correlationDetector.observedCmiBits) ||
    slot.correlationDetector.boundBits !== 0.02 ||
    slot.correlationDetector.observedCmiBits <= slot.correlationDetector.boundBits ||
    !exactKeys(slot.positiveControls, ['hostExposureDetected', 'timingLeakDetected', 'sizeLeakDetected', 'errorShapeLeakDetected']) ||
    Object.values(slot.positiveControls).some((detected) => detected !== true) ||
    slot.allPositiveControlsDetected !== true ||
    slot.passed !== true
  ) {
    throw new Error(`E01 slot ${String(index + 1)} contradicts its registration or acceptance rules`);
  }
  slot.topology.containerIds.forEach((id) => containerIds.add(id));
}
if (containerIds.size !== 10) throw new Error('E01 did not recreate both learner containers for every slot');

console.log('E01 v1 historical receipt valid: records 5/5 topologies, 500 observations, 60/60 category decisions, all positive controls detected; explicit-corpus closure is audited separately in v2');
console.log(liveEvidence
  ? 'Live evidence: retained slot records match the receipt; topology attacks were not rerun'
  : 'Receipt audit only: raw evidence not checked; use --live-evidence to compare retained slot records');
