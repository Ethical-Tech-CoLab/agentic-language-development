#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const receiptPath = 'reports/research/e00-integrity-qualification-receipt.json';
const registrationPath = 'protocols/e00-registration.v5.json';
const bindingPath = 'protocols/e00-registration-binding.v4.json';
const executionCommit = '6a3faa8e85cb9f7a9fe7847445897c6e98ee56cb';
const mutationCases = [
  'event-content',
  'deleted-middle-event',
  'inserted-event',
  'reordered-events',
  'foreign-writer-signature',
  'modified-merkle-proof',
  'wrong-chain',
  'simulated-class-relabel',
  'false-receipt-payload',
  'unanchored-tail',
  'inconsistent-checkpoint-prefix',
];
const read = (path: string): string => readFileSync(path, 'utf8');
const registration = JSON.parse(read(registrationPath)) as {
  preRegistrationHash: string;
  artifact: { bindings: Array<{ key: string; content: unknown }> };
};
const binding = JSON.parse(read(bindingPath)) as { preRegistrationHash: string };
const receipt = JSON.parse(read(receiptPath)) as {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  experimentId: string;
  registrationHash: string;
  registrationBinding: string;
  executionCommit: string;
  fixture: { slots: number; turnsPerSlot: number; minimumBabyLedgerEventsPerSlot: number; minimumCheckpointsPerSlot: number };
  slots: Array<{
    slot: number;
    scenarioSeed: string;
    runId: string;
    eventCount: number;
    checkpointCount: number;
    babyLedgerEvents: { babyA: number; babyB: number };
    anchored: boolean;
    commitmentPayloadsOnly32ByteHashes: boolean;
    cases: Array<{ case: string; expectedPass: boolean; verifierPass: boolean; auditorPass: boolean }>;
    allDispositionsMatched: boolean;
    retainedBundle: string;
  }>;
  restoreExtensionQualification: { passed: boolean };
  allDispositionsMatched: boolean;
};

if (
  receipt.schemaVersion !== 2 ||
  receipt.classification !== 'prospectively-registered-software-qualification' ||
  receipt.researchFinding ||
  receipt.experimentId !== 'E00'
) {
  throw new Error('E00 receipt identity or claim class is invalid');
}
if (
  receipt.registrationHash !== registration.preRegistrationHash ||
  binding.preRegistrationHash !== registration.preRegistrationHash ||
  receipt.registrationBinding !== bindingPath ||
  receipt.executionCommit !== executionCommit
) {
  throw new Error('E00 receipt does not bind the registered packet, commitment, and execution commit');
}
execFileSync('git', ['cat-file', '-e', `${executionCommit}^{commit}`]);
const selectedSeeds = registration.artifact.bindings.find(
  (entry) => entry.key === 'selectedSeedPrefix',
)?.content as { primary?: Array<{ slot: number; scenario: string }> } | undefined;
const registeredSeeds = selectedSeeds?.primary;
if (
  receipt.fixture.slots !== 5 ||
  receipt.fixture.turnsPerSlot !== 100 ||
  receipt.fixture.minimumBabyLedgerEventsPerSlot !== 100 ||
  receipt.fixture.minimumCheckpointsPerSlot !== 3 ||
  receipt.slots.length !== 5 ||
  registeredSeeds?.length !== 5
) {
  throw new Error('E00 receipt does not contain the registered five-slot fixture');
}
for (const [index, slot] of receipt.slots.entries()) {
  const registered = registeredSeeds[index];
  const expectedCases = ['unchanged-export', ...mutationCases];
  if (
    registered === undefined ||
    slot.slot !== index + 1 ||
    registered.slot !== slot.slot ||
    registered.scenario !== slot.scenarioSeed ||
    slot.runId !== `run-e00-qualified-${String(slot.slot).padStart(2, '0')}` ||
    slot.eventCount < 200 ||
    slot.checkpointCount < 3 ||
    slot.babyLedgerEvents.babyA !== 100 ||
    slot.babyLedgerEvents.babyB !== 100 ||
    !slot.anchored ||
    !slot.commitmentPayloadsOnly32ByteHashes ||
    !slot.allDispositionsMatched ||
    JSON.stringify(slot.cases.map((entry) => entry.case)) !== JSON.stringify(expectedCases) ||
    slot.cases[0]?.expectedPass !== true ||
    slot.cases[0]?.verifierPass !== true ||
    slot.cases[0]?.auditorPass !== true ||
    slot.cases.slice(1).some((entry) => entry.expectedPass || entry.verifierPass || entry.auditorPass)
  ) {
    throw new Error(`E00 slot ${String(index + 1)} contradicts its registration or acceptance rules`);
  }
  const manifest = JSON.parse(read(`${slot.retainedBundle}/run-manifest.json`)) as { runId?: string };
  if (manifest.runId !== slot.runId) throw new Error(`retained bundle mismatch for ${slot.runId}`);
}
if (!receipt.restoreExtensionQualification.passed || !receipt.allDispositionsMatched) {
  throw new Error('E00 recovery or aggregate disposition failed');
}

console.log('E00 qualification valid: 5/5 unchanged accepted, 55/55 mutations rejected by both verifiers');
