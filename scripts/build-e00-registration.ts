#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { compileRegistrationPacket } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';

const outputPath = 'protocols/e00-registration.v2.json';
const protocolBaseCommit = '59cd60d26937e1b595d645c95c8155758b091312';
const read = (path: string): Buffer => readFileSync(path);
const sha256 = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');
const derive = (...parts: Array<string | number>): string =>
  sha256(parts.map(String).join('\0'));

const cardsPath = 'protocols/research-protocol-cards.v1.json';
const allocationPath = 'protocols/seed-and-resource-allocation.v1.json';
const governancePath = 'protocols/research-governance-and-funding.v1.json';
const cardsBytes = read(cardsPath);
const allocationBytes = read(allocationPath);
const governanceBytes = read(governancePath);
const cards = JSON.parse(cardsBytes.toString('utf8')) as {
  cards: Array<Record<string, unknown> & { id: string }>;
};
const allocation = JSON.parse(allocationBytes.toString('utf8')) as {
  seedDerivation: { root: string };
  allocations: Array<Record<string, unknown> & { experiment: string }>;
  localCeiling: Record<string, unknown>;
};
const card = cards.cards.find((entry) => entry.id === 'E00');
const allocationRow = allocation.allocations.find((entry) => entry.experiment === 'E00');
if (card === undefined || allocationRow === undefined) {
  throw new Error('E00 protocol card or allocation is missing');
}

const seedRoot = allocation.seedDerivation.root;
const primary = Array.from({ length: 5 }, (_, index) => {
  const slot = index + 1;
  return {
    slot,
    scenario: derive(seedRoot, 'software-qualification', 'E00', slot, 'scenario'),
    babyA: derive(seedRoot, 'software-qualification', 'E00', 'integrity-suite', slot, 'baby-a', 'learner'),
    babyB: derive(seedRoot, 'software-qualification', 'E00', 'integrity-suite', slot, 'baby-b', 'learner'),
    gateway: derive(seedRoot, 'software-qualification', 'E00', 'integrity-suite', slot, 'gateway'),
    analysis: derive(seedRoot, 'software-qualification', 'E00', 'integrity-suite', slot, 'analysis'),
  };
});
const environmentManifest = {
  pnpmLockSha256: sha256(read('pnpm-lock.yaml')),
  rustLockSha256: sha256(read('tools/integrity-auditor/Cargo.lock')),
  nodeMajor: Number(process.versions.node.split('.')[0]),
  platform: process.platform,
  architecture: process.arch,
};
const bindings = {
  protocolCard: {
    source: cardsPath,
    sourceSha256: sha256(cardsBytes),
    cardSha256: hashCanonical('dtsf-registration-card-v1', card),
    id: card.id,
    class: card['class'],
    question: card['question'],
    unit: card['unit'],
    exposure: card['exposure'],
    comparator: card['comparator'],
    primaryOutcome: card['primaryOutcome'],
    estimand: card['estimand'],
    secondary: card['secondary'],
    exploratory: 'none registered',
    dependencies: 'none',
    nextDesignOwner: card['nextDesignOwner'],
  },
  runConfigurations: [{
    protocolBaseCommit,
    supersededRegistration: {
      path: 'protocols/e00-registration.v1.json',
      preRegistrationHash: 'sha256:be3c156fe34abb19b9adc71f7cccfc8237d813b37cd09033dffceb80c391bc36',
      reason: 'The v1 environment manifest bound mutable package metadata, creating a registration/execution commit cycle; no outcomes were collected.',
    },
    experimentId: 'E00',
    stage: 'software-qualification',
    deploymentMode: 'prototype',
    communicationCondition: 'normal',
    learnerTrack: 'no-learning',
    turnsPerRun: 100,
    slots: 5,
  }],
  practicalMargins: {
    unchangedBundleAcceptance: 1,
    mutationDetectionByClass: 1,
    simulatedReceiptVerification: 1,
    permittedPrivateContentInCommitment: 0,
  },
  analysisVersions: [
    'typescript-production-verifier@integrity-challenge-v2',
    'rust-independent-integrity-auditor@0.1.0',
  ],
  modelAssets: [{
    role: 'both-agents',
    model: 'no-learning deterministic fixture',
    contractPath: 'contracts/learner-contract.no-learning.v1.md',
    contractSha256: sha256(read('contracts/learner-contract.no-learning.v1.md')),
  }],
  selectedSeedPrefix: {
    derivation: allocation.seedDerivation,
    stage: 'software-qualification',
    condition: 'integrity-suite',
    primary,
    reserves: 'zero-reserve qualification allocation',
  },
  executionHost: {
    topology: 'single-host isolated temporary evidence stores',
    environmentManifest,
    environmentManifestSha256: hashCanonical('dtsf-e00-environment-v1', environmentManifest),
    localCeiling: allocation.localCeiling,
    externalSpend: 0,
  },
  scenarioBundle: {
    generator: 'signed-evidence-fixture-v2',
    turnsPerRun: 100,
    minimumBabyLedgerEvents: 100,
    minimumCheckpoints: 3,
    syntheticOnly: true,
  },
  exclusionRules: [
    'retain every attempted slot and disposition; no outcome-dependent exclusion',
    'infrastructure aborts remain indexed and do not become replacement successes',
  ],
  stoppingRules: {
    outcomeDependent: false,
    plannedSlots: 5,
    turnsPerSlot: 100,
    stopOnlyAfterAllRegisteredCasesOrInfrastructureAbort: true,
  },
  evidenceAndAnchorPolicy: {
    governancePath,
    governanceSha256: sha256(governanceBytes),
    anchorClass: 'simulated',
    transport: 'deterministic in-memory chain',
    compatibilityNetwork: 'base-sepolia',
    compatibilityChainId: 84532,
    requiredConfirmations: 3,
    verifierImplementations: ['typescript-production-verifier', 'rust-independent-integrity-auditor'],
    mutationCases: [
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
    ],
    privateContentPermittedInCommitment: false,
  },
} as const;

const compiled = compileRegistrationPacket({
  experimentId: 'E00',
  registrationClass: 'qualification',
  bindings,
});
const report = {
  artifact: compiled.artifact,
  preRegistrationHash: compiled.preRegistrationHash,
  claimBoundary: compiled.claimBoundary,
  registrationProfile: 'repository-native',
  protocolBaseCommit,
  registrationState: 'compiled-for-repository-registration',
  researchFinding: false,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
} else if (readFileSync(outputPath, 'utf8') !== rendered) {
  throw new Error('E00 registration is stale; run pnpm run build:registration-e00');
}
console.log(`E00 registration compiled: ${compiled.preRegistrationHash}`);
