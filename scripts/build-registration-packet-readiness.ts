#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { REGISTRATION_BINDING_KEYS, compileRegistrationPacket } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';

const cardsPath = 'protocols/research-protocol-cards.v1.json';
const e00Path = 'protocols/e00-registration.v2.json';
const outputPath = 'reports/research/registration-packet-readiness.json';
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface Card {
  id: string;
  class: string;
  question: string;
  unit: string;
  exposure: string;
  comparator: string;
  primaryOutcome: string;
  estimand: string;
  secondary: string[];
  exploratory: string[];
  dependencies: string[];
  nextDesignOwner: string;
}

const cardsBytes = readFileSync(cardsPath);
const source = JSON.parse(cardsBytes.toString('utf8')) as { schemaVersion: number; cards: Card[] };
if (source.schemaVersion !== 1 || source.cards.length !== 19) throw new Error('protocol-card source must contain 19 version-1 cards');
const e00 = JSON.parse(readFileSync(e00Path, 'utf8')) as {
  artifact: { experimentId: string; registrationClass: string; bindings: Array<{ key: string; sha256: string; content: unknown }> };
  preRegistrationHash: string;
};
const e00Bindings = Object.fromEntries(
  e00.artifact.bindings.map((binding) => [binding.key, binding.content]),
) as Record<(typeof REGISTRATION_BINDING_KEYS)[number], unknown>;
const verifiedE00 = compileRegistrationPacket({
  experimentId: e00.artifact.experimentId,
  registrationClass: e00.artifact.registrationClass,
  bindings: e00Bindings,
});
if (
  verifiedE00.preRegistrationHash !== e00.preRegistrationHash ||
  JSON.stringify(verifiedE00.artifact) !== JSON.stringify(e00.artifact)
) {
  throw new Error('E00 registration packet does not reproduce from its bound content');
}

const packets = source.cards.map((card) => {
  if (card.id === 'E00') {
    return {
      experimentId: card.id,
      registrationClass: card.class,
      registrationReady: true,
      resolvedBindings: e00.artifact.bindings.map((binding) => ({
        key: binding.key,
        sha256: binding.sha256,
        source: e00Path,
      })),
      unresolvedBindings: [],
      compileAttempt: 'compiled-and-hash-reproduced',
      preRegistrationHash: e00.preRegistrationHash,
    };
  }
  return {
    experimentId: card.id,
    registrationClass: card.class,
    registrationReady: false,
    resolvedBindings: [{
      key: 'protocolCard',
      sha256: hashCanonical('dtsf-registration-card-v1', card),
      source: cardsPath,
    }],
    unresolvedBindings: REGISTRATION_BINDING_KEYS.filter((key) => key !== 'protocolCard').map((key) => ({
      key,
      reason: key === 'selectedSeedPrefix'
        ? 'Blinded pilot and complete-family power simulation have not selected a primary/reserve prefix.'
        : key === 'executionHost'
          ? 'No approved study execution host and exact environment-manifest hash are bound.'
          : key === 'evidenceAndAnchorPolicy'
            ? 'No experiment-specific simulated commitment and verification policy is bound.'
            : `No final experiment-specific ${key} artifact is bound.`,
    })),
    compileAttempt: 'blocked-before-compiler',
    preRegistrationHash: null,
  };
});

const report = {
  schemaVersion: 1,
  classification: 'registration-readiness-inventory',
  researchFinding: false,
  capturedAt: '2026-09-11',
  compilerVersion: 1,
  sourceCardsSha256: hash(cardsBytes),
  requiredBindings: REGISTRATION_BINDING_KEYS,
  totals: {
    experiments: packets.length,
    registrationReady: packets.filter((packet) => packet.registrationReady).length,
    resolvedBindings: packets.reduce((sum, packet) => sum + packet.resolvedBindings.length, 0),
    unresolvedBindings: packets.reduce((sum, packet) => sum + packet.unresolvedBindings.length, 0),
    compiledPackets: packets.filter((packet) => packet.preRegistrationHash !== null).length,
  },
  packets,
  activationStepsNotRepresentedAsBindings: [
    'authentic governance approval',
    'immutable repository registration of the compiled packet hash',
    'matching pre-run simulated commitment verified offline',
  ],
  optionalExternalEnhancements: [
    'third-party registration or archival timestamp',
    'independent methods and reproduction review',
  ],
  boundary: 'This inventory is deliberately incomplete. It is not a repository registration, a completed simulated commitment, governance approval, or permission to collect outcomes.',
};

if (report.totals.registrationReady !== 1 || report.totals.compiledPackets !== 1) throw new Error('inventory must contain exactly the verified E00 packet');
if (report.totals.resolvedBindings !== 29 || report.totals.unresolvedBindings !== 180) throw new Error('binding totals do not reconcile');
if (report.packets.some((packet) => packet.experimentId !== 'E00' && (packet.preRegistrationHash !== null || packet.unresolvedBindings.length !== 10))) throw new Error('an incomplete packet escaped fail-closed inventory');

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
} else if (readFileSync(outputPath, 'utf8') !== rendered) {
  throw new Error('registration-packet readiness inventory is stale; run pnpm run build:registration-readiness');
}
console.log(`registration readiness valid: ${String(report.totals.experiments)} experiments, ${String(report.totals.compiledPackets)} compiled, ${String(report.totals.unresolvedBindings)} unresolved bindings`);
