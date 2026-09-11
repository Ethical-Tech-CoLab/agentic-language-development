#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { REGISTRATION_BINDING_KEYS } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';

const cardsPath = 'protocols/research-protocol-cards.v1.json';
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

const packets = source.cards.map((card) => ({
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
          ? 'No experiment-specific authorized public-chain execution and verification policy is bound.'
          : `No final experiment-specific ${key} artifact is bound.`,
  })),
  compileAttempt: 'blocked-before-compiler',
  preRegistrationHash: null,
}));

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
  externalStepsNotRepresentedAsBindings: [
    'authentic governance approval',
    'external registration receipt for the compiled packet hash',
    'independently verified matching pre-run public anchor',
    'independent methods review',
  ],
  boundary: 'This inventory is deliberately incomplete. It is not a registration, an anchor, governance approval, or permission to collect outcomes.',
};

if (report.totals.registrationReady !== 0 || report.totals.compiledPackets !== 0) throw new Error('inventory fabricates a ready or compiled packet');
if (report.totals.resolvedBindings !== 19 || report.totals.unresolvedBindings !== 190) throw new Error('binding totals do not reconcile');
if (report.packets.some((packet) => packet.preRegistrationHash !== null || packet.unresolvedBindings.length !== 10)) throw new Error('incomplete packet escaped fail-closed inventory');

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
} else if (readFileSync(outputPath, 'utf8') !== rendered) {
  throw new Error('registration-packet readiness inventory is stale; run pnpm run build:registration-readiness');
}
console.log(`registration readiness valid: ${String(report.totals.experiments)} experiments, ${String(report.totals.compiledPackets)} compiled, ${String(report.totals.unresolvedBindings)} unresolved bindings`);
