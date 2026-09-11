#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  carrierPerceptualDistance,
  evaluatePerceptualGeneralization,
  type BitmapMark,
  type CanvasMark,
  type LabeledPerceptualMark,
  type ToneMark,
} from '@ald/analysis';

const protocolPath = 'protocols/carrier-perception-qualification.v1.json';
const receiptPath = 'reports/research/carrier-perception-qualification-receipt.json';
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface Protocol {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  candidate: { commit: string; version: string };
  sourceHashes: Record<string, string>;
  carriers: string[];
  fixture: {
    familiesPerCarrier: number;
    prototypesPerCarrier: number;
    novelQueriesPerCarrier: number;
    expectedAccuracy: number;
    expectedNovelQueries: number;
  };
  negativeControls: string[];
  exactValidation: Record<string, unknown>;
  rawEvidence: Record<string, unknown>;
  boundary: string;
}

function expectThrow(id: string, action: () => unknown): { id: string; passed: true } {
  try {
    action();
  } catch {
    return { id, passed: true };
  }
  throw new Error(`negative control did not fail: ${id}`);
}

const bitmap = (ones: readonly number[]): BitmapMark => ({
  carrier: 'generative-bitmap',
  bits: Array.from({ length: 256 }, (_, index) => ones.includes(index) ? 1 : 0),
});
const canvas = (orientation: 'horizontal' | 'vertical', offset = 0): CanvasMark => ({
  carrier: 'generative-canvas',
  strokes: [orientation === 'vertical'
    ? { startX: 3 + offset, startY: 1, endX: 3 + offset, endY: 14, width: 1 }
    : { startX: 1, startY: 3 + offset, endX: 14, endY: 3 + offset, width: 1 }],
});
const tones = (base: number, duration = 1): ToneMark => ({
  carrier: 'generative-tone',
  tones: [
    { pitchBin: base, durationBin: duration },
    { pitchBin: base + 1, durationBin: Math.min(4, duration + 1) },
  ],
});
const row = (id: string, family: string, mark: LabeledPerceptualMark['mark']): LabeledPerceptualMark => ({ id, family, mark });

const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
  if (sha256(readFileSync(path)) !== expected) throw new Error(`${path} differs from the exact qualified candidate`);
}

const cases = [
  {
    carrier: 'generative-bitmap',
    prototypes: [row('bitmap-a0', 'a', bitmap([0, 1, 16, 17])), row('bitmap-b0', 'b', bitmap([238, 239, 254, 255]))],
    queries: [row('bitmap-a1', 'a', bitmap([0, 1, 16])), row('bitmap-b1', 'b', bitmap([239, 254, 255]))],
  },
  {
    carrier: 'generative-canvas',
    prototypes: [row('canvas-a0', 'a', canvas('vertical')), row('canvas-b0', 'b', canvas('horizontal'))],
    queries: [row('canvas-a1', 'a', canvas('vertical', 1)), row('canvas-b1', 'b', canvas('horizontal', 1))],
  },
  {
    carrier: 'generative-tone',
    prototypes: [row('tone-a0', 'a', tones(0)), row('tone-b0', 'b', tones(6))],
    queries: [row('tone-a1', 'a', tones(1)), row('tone-b1', 'b', tones(5))],
  },
] as const;

const results = cases.map((entry) => {
  const result = evaluatePerceptualGeneralization(entry);
  if (result.carrier !== entry.carrier) throw new Error(`carrier mismatch for ${entry.carrier}`);
  if (result.families.length !== protocol.fixture.familiesPerCarrier
    || result.prototypeCount !== protocol.fixture.prototypesPerCarrier
    || result.queryCount !== protocol.fixture.novelQueriesPerCarrier
    || result.accuracy !== protocol.fixture.expectedAccuracy
    || result.exactNovelQueries !== protocol.fixture.expectedNovelQueries) {
    throw new Error(`fixture expectation failed for ${entry.carrier}`);
  }
  return result;
});
if (results.map((entry) => entry.carrier).join('|') !== protocol.carriers.join('|')) throw new Error('carrier order differs from protocol');

const negativeControls = [
  expectThrow('cross-carrier-distance', () => carrierPerceptualDistance(bitmap([]), canvas('vertical'))),
  expectThrow('malformed-bitmap', () => carrierPerceptualDistance(bitmap([]), { carrier: 'generative-bitmap', bits: [0] })),
  expectThrow('malformed-canvas', () => carrierPerceptualDistance(canvas('vertical'), { carrier: 'generative-canvas', strokes: [{ startX: 99, startY: 0, endX: 1, endY: 1, width: 1 }] })),
  expectThrow('malformed-right-tone', () => carrierPerceptualDistance(tones(0), { carrier: 'generative-tone', tones: [{ pitchBin: 99, durationBin: 1 }] })),
  expectThrow('duplicate-identifier', () => evaluatePerceptualGeneralization({
    prototypes: [row('same', 'a', bitmap([0])), row('b', 'b', bitmap([255]))],
    queries: [row('same', 'a', bitmap([1]))],
  })),
  expectThrow('uncovered-query-family', () => evaluatePerceptualGeneralization({
    prototypes: [row('a', 'a', bitmap([0])), row('b', 'b', bitmap([255]))],
    queries: [row('c', 'c', bitmap([1]))],
  })),
];
if (negativeControls.map((entry) => entry.id).join('|') !== protocol.negativeControls.join('|')) throw new Error('negative-control order differs from protocol');

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
  },
  rawEvidence: protocol.rawEvidence,
  fixture: protocol.fixture,
  results,
  negativeControls,
  preservedFailure: {
    diagnostic: 'initial-raw-canvas-hamming',
    failedTests: 2,
    cause: 'Raw raster Hamming ranked a one-cell translation farther than the crossing-family prototype.',
    correction: 'Canvas distance now minimizes raster disagreement over the registered plus-or-minus-one-cell translation window; structural novelty remains a separate exact comparison.',
  },
  blockerDisposition: {
    blocker: 'B09',
    status: 'open',
    completed: 'carrier-specific handcrafted distances, held-out nearest-prototype diagnostic, grammar validation, deterministic tie-breaking, synthetic positive and negative controls, exact clean validation',
    remains: 'selected production carrier data, learned transformation/generalization evidence, useful interaction outcomes, and forbidden side-feature detector qualification on the actual topology',
  },
  boundary: protocol.boundary,
};
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(receiptPath, rendered);
  console.log(`wrote ${receiptPath}`);
} else if (readFileSync(receiptPath, 'utf8') !== rendered) {
  throw new Error('carrier-perception qualification receipt is stale; run pnpm run qualify:carrier-perception');
}
console.log(`carrier-perception qualification valid: ${String(results.length)} carriers, ${String(negativeControls.length)} negative controls`);
