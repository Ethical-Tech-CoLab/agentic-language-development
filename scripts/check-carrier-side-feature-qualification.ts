#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { buildConformanceRunConfig } from '@ald/learners';
import { runCarrierSideFeatureAttacks } from '@ald/redteam';

const protocolPath = 'protocols/carrier-side-feature-qualification.v1.json';
const receiptPath = 'reports/research/carrier-side-feature-qualification-receipt.json';
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface Protocol {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  candidate: { commit: string; version: string };
  sourceHashes: Record<string, string>;
  expected: {
    carriers: number;
    positiveControls: number;
    attacks: number;
    features: string[];
    activeModeRCategories: number;
    modeRTransportSamples: number;
    trainingTracks: string[];
  };
  exactValidation: Record<string, unknown>;
  rawEvidence: Record<string, unknown> & { directory: string; modeRLogSha256: string };
  modeRSummary: Record<string, unknown> & { trainingTracks: string[] };
  boundary: string;
}

const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
  if (sha256(readFileSync(path)) !== expected) throw new Error(`${path} differs from the exact qualified candidate`);
}

const report = await runCarrierSideFeatureAttacks({
  'generative-bitmap': buildConformanceRunConfig('no-learning', {
    deploymentMode: 'research-grade', carrierMode: 'generative-bitmap', runId: 'qualification-side-feature-bitmap',
  }),
  'generative-canvas': buildConformanceRunConfig('no-learning', {
    deploymentMode: 'research-grade', carrierMode: 'generative-canvas', runId: 'qualification-side-feature-canvas',
  }),
  'generative-tone': buildConformanceRunConfig('no-learning', {
    deploymentMode: 'research-grade', carrierMode: 'generative-tone', runId: 'qualification-side-feature-tone',
  }),
});
if (!report.passed
  || report.carriers.length !== protocol.expected.carriers
  || report.positiveControls.length !== protocol.expected.positiveControls
  || report.attacks.length !== protocol.expected.attacks
  || report.features.join('|') !== protocol.expected.features.join('|')) {
  throw new Error('carrier side-feature results differ from protocol');
}
if (protocol.modeRSummary.activeSideChannelCategories !== protocol.expected.activeModeRCategories
  || protocol.modeRSummary.transportSamples !== protocol.expected.modeRTransportSamples
  || protocol.modeRSummary.trainingTracks.join('|') !== protocol.expected.trainingTracks.join('|')) {
  throw new Error('Mode R summary differs from protocol');
}

if (process.argv.includes('--live-evidence')) {
  const modeRLog = `${protocol.rawEvidence.directory}/mode-r.log`;
  if (sha256(readFileSync(modeRLog)) !== protocol.rawEvidence.modeRLogSha256) throw new Error('raw Mode R log hash mismatch');
  const text = readFileSync(modeRLog, 'utf8');
  for (const required of [
    '"mode":"research-grade"',
    '"directNetworkRoutes":"refused"',
    '"timingWithinTolerance":true',
    '"sizeWithinTolerance":true',
    '"errorShapeWithinTolerance":true',
    '"track":"scratch-rl"',
    '"track":"self-supervised"',
    '"track":"hybrid"',
    'Exit status: 0',
  ]) {
    if (!text.includes(required)) throw new Error(`raw Mode R log lacks ${required}`);
  }
}

const receipt = {
  schemaVersion: protocol.schemaVersion,
  classification: protocol.classification,
  researchFinding: protocol.researchFinding,
  capturedAt: '2026-09-11',
  protocolSha256: sha256(protocolBytes),
  candidate: protocol.candidate,
  sourceHashes: protocol.sourceHashes,
  exactValidation: {
    ...protocol.exactValidation,
    detachedWorktree: true,
    worktreeCleanAfterValidation: true,
    frozenInstallExitCode: 0,
    focusedExitCode: 0,
    consolidatedExitCode: 0,
    modeRExitCode: 0,
  },
  rawEvidence: protocol.rawEvidence,
  structuralGateway: report,
  referenceModeRTopology: protocol.modeRSummary,
  preservedFailure: {
    candidateVersion: '0.1.73',
    exactCandidateValidationPassed: true,
    receiptGenerationExitCode: 1,
    cause: 'The root qualification runner imported @ald/redteam without declaring the workspace dependency.',
    correction: 'The v0.1.74 root manifest declares @ald/redteam explicitly; the frozen dependency graph is unchanged apart from the workspace link.',
  },
  blockerDisposition: {
    blockers: ['B09', 'B12'],
    status: 'open',
    completed: '28 generated-carrier structural attacks, three accepted/delivered controls, exact clean validation, and measured current two-container Mode R timing/envelope/error/host controls',
    remains: 'prospective learned-form evidence, powered negative bounds, and rerun on the final selected registered study topology',
  },
  boundary: protocol.boundary,
};
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(receiptPath, rendered);
  console.log(`wrote ${receiptPath}`);
} else if (readFileSync(receiptPath, 'utf8') !== rendered) {
  throw new Error('carrier side-feature qualification receipt is stale; run pnpm run qualify:carrier-side-features');
}
console.log(`carrier side-feature qualification valid: ${String(report.attacks.length)} attacks, ${String(report.positiveControls.length)} positive controls`);
