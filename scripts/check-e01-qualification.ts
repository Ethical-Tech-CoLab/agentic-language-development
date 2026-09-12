#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const receiptPath = 'reports/research/e01-isolation-qualification-receipt.json';
const registrationPath = 'protocols/e01-registration.v1.json';
const bindingPath = 'protocols/e01-registration-binding.v1.json';
const executionCommit = '8d3a9f67257ad8c53bc5438926ff8dc23743ed0d';
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
  gateway: { attackMarkerRetained: boolean; attempts: Array<{ blocked: boolean; extractedByRecipient: boolean; auditRecorded: boolean }>; passed: boolean };
  host: { attempts: Array<{ blocked: boolean; extractedByRecipient: boolean }>; passed: boolean };
  transport: {
    samplesPerCondition: number;
    timing: { totalSamples: number; pairs: Array<{ absoluteMeanDifference: number }> };
    timingDecision: { withinTolerance: boolean };
    size: { pairs: Array<{ absoluteMeanDifference: number }> };
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
  receipt.researchFinding ||
  receipt.experimentId !== 'E01' ||
  receipt.registrationHash !== registration.preRegistrationHash ||
  receipt.registrationBinding !== bindingPath ||
  binding.preRegistrationHash !== registration.preRegistrationHash ||
  receipt.executionCommit !== executionCommit ||
  receipt.externalSpend !== 0 ||
  receipt.publicChainTransaction ||
  receipt.topologySlotsAttempted !== 5 ||
  receipt.plannedTopologySlots !== 5 ||
  receipt.wallMilliseconds <= 0 ||
  receipt.slots.length !== 5 ||
  !receipt.passed ||
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
  const retained = readJson<Slot>(
    `${receipt.retainedEvidenceRoot}/slot-${String(index + 1).padStart(2, '0')}.json`,
  );
  if (
    registered === undefined ||
    slot.slot !== index + 1 ||
    slot.slot !== registered.slot ||
    slot.scenarioSeed !== registered.scenario ||
    slot.runId !== `run-e01-qualified-${String(index + 1).padStart(2, '0')}` ||
    JSON.stringify(retained) !== JSON.stringify(slot) ||
    slot.topology.boundary !== 'separate-container' ||
    slot.topology.containerIds.length !== 2 ||
    !slot.topology.distinctLearnerContainers ||
    slot.topology.directPeerRoutes.some((route) => route !== 'refused') ||
    slot.primaryAttackAttempts !== 100 ||
    slot.hostCapabilityAttempts !== 5 ||
    JSON.stringify(slot.registeredCategories) !== JSON.stringify(categories) ||
    Object.keys(slot.categoryDecisions).length !== 12 ||
    Object.values(slot.categoryDecisions).some((decision) => !decision) ||
    slot.gateway.attackMarkerRetained ||
    slot.gateway.attempts.length !== 6 ||
    slot.gateway.attempts.some((attempt) => !attempt.blocked || attempt.extractedByRecipient || !attempt.auditRecorded) ||
    !slot.gateway.passed ||
    slot.host.attempts.length !== 5 ||
    slot.host.attempts.some((attempt) => !attempt.blocked || attempt.extractedByRecipient) ||
    !slot.host.passed ||
    slot.transport.samplesPerCondition !== 47 ||
    slot.transport.timing.totalSamples !== 94 ||
    slot.transport.timing.pairs.some((pair) => pair.absoluteMeanDifference > 100) ||
    !slot.transport.timingDecision.withinTolerance ||
    slot.transport.size.pairs.some((pair) => pair.absoluteMeanDifference !== 0) ||
    !slot.transport.sizeDecision.withinTolerance ||
    slot.transport.errorShape.totalResponses !== 94 ||
    slot.transport.errorShape.distinctBodies !== 1 ||
    !slot.transport.errorShape.identical ||
    !slot.transport.errorShape.constantLength ||
    slot.transport.errorShape.bodiesDistinguishLabels ||
    !slot.transport.errorDecision.withinTolerance ||
    !slot.transport.passed ||
    slot.correlationDetector.attempts !== 64 ||
    !slot.correlationDetector.suspectedLeakage ||
    !slot.correlationDetector.detectedBeforeClaim ||
    slot.correlationDetector.observedCmiBits <= slot.correlationDetector.boundBits ||
    Object.keys(slot.positiveControls).length !== 4 ||
    Object.values(slot.positiveControls).some((detected) => !detected) ||
    !slot.allPositiveControlsDetected ||
    !slot.passed
  ) {
    throw new Error(`E01 slot ${String(index + 1)} contradicts its registration or acceptance rules`);
  }
  slot.topology.containerIds.forEach((id) => containerIds.add(id));
}
if (containerIds.size !== 10) throw new Error('E01 did not recreate both learner containers for every slot');

console.log('E01 v1 qualification valid: 5/5 topologies, 500 observations, 60/60 category decisions, all positive controls detected');
