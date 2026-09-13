import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The qualification auditor is a directly executable ESM script.
import { validateE01V2Receipt } from '../check-e01-v2-receipt.mjs';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const packet = read('protocols/e01-registration.v2.json');
const original = read('reports/research/e01-v2-qualification-receipt.json');

describe('E01 v2 portable receipt boundary', () => {
  it('accepts the retained registered summary', () => {
    expect(() => validateE01V2Receipt(original, packet)).not.toThrow();
  });

  const mutations = [
    ['public claim', (r: typeof original) => { r.publicChainTransaction = true; }],
    ['research claim', (r: typeof original) => { r.researchFinding = true; }],
    ['false pass', (r: typeof original) => { r.passed = 'true'; }],
    ['failure', (r: typeof original) => { r.failure = 'failed'; }],
    ['execution source', (r: typeof original) => { r.executionCommit = '0'.repeat(40); }],
    ['missing slot', (r: typeof original) => { r.slots.pop(); }],
    ['reordered slots', (r: typeof original) => { r.slots.reverse(); }],
    ['wrong seed', (r: typeof original) => { r.slots[0].scenarioSeed = '0'.repeat(64); }],
    ['duplicate container', (r: typeof original) => { r.slots[1].containerIds[0] = r.slots[0].containerIds[0]; }],
    ['missing attempt', (r: typeof original) => { r.slots[0].decision.attempts = 111; }],
    ['unbounded timing', (r: typeof original) => { r.slots[0].decision.timingDifferenceMs = 101; }],
    ['missing timing', (r: typeof original) => { r.slots[0].decision.timingDifferenceMs = null; }],
    ['negative timing', (r: typeof original) => { r.slots[0].decision.timingDifferenceMs = -1; }],
    ['string timing', (r: typeof original) => { r.slots[0].decision.timingDifferenceMs = '0'; }],
    ['unresolved issue', (r: typeof original) => { r.slots[0].decision.issues.push('unresolved'); }],
    ['invalid slot digest', (r: typeof original) => { r.slots[0].slotSha256 = ''; }],
    ['invalid manifest digest', (r: typeof original) => { r.slots[0].bundleManifestHash = ''; }],
    ['missing attachment', (r: typeof original) => { r.slots[0].rust.attachmentCount = 111; }],
    ['missing checkpoint', (r: typeof original) => { r.slots[0].rust.checkpointCount = 1; }],
    ['unverified bundle', (r: typeof original) => { r.slots[0].rust.integrityPass = false; }],
    ['no anchor', (r: typeof original) => { r.slots[0].rust.anchored = false; }],
    ['missing limitation', (r: typeof original) => { r.claimBoundary = ''; }],
  ] as const;
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const changed = structuredClone(original);
    mutate(changed);
    expect(() => validateE01V2Receipt(changed, packet)).toThrow();
  });
});
