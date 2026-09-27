/** LV01 fixed-cadence snapshots and order-permutation carryover checks. */
import { describe, expect, it } from 'vitest';

import { checkLv01BranchOrderStability } from '../../src/experiments/lv01-order-check.js';
import { extractLv01PolicySnapshots } from '../../src/experiments/lv01-snapshots.js';

const V16_POLICIES = [
  'baby-a-latest.json',
  'baby-a-policy-63.json',
  'baby-a-policy-88.json',
  'baby-a-policy-initial.json',
  'baby-b-latest.json',
  'baby-b-policy-63.json',
  'baby-b-policy-88.json',
  'baby-b-policy-initial.json',
];

describe('LV01 fixed-cadence snapshots', () => {
  it('extracts initial, cadence, and final points per role', () => {
    const files = [
      'baby-a-policy-initial.json',
      'baby-a-policy-25.json',
      'baby-a-policy-50.json',
      'baby-a-policy-60.json',
      'baby-b-policy-initial.json',
      'baby-b-policy-25.json',
      'baby-b-policy-50.json',
      'baby-b-policy-60.json',
    ];
    const snapshots = extractLv01PolicySnapshots(files, 25, 60);
    expect(snapshots.babyA.map((entry) => entry.turn)).toEqual(['initial', 25, 50, 60]);
    expect(snapshots.babyB.map((entry) => entry.fileName)).toEqual([
      'baby-b-policy-initial.json',
      'baby-b-policy-25.json',
      'baby-b-policy-50.json',
      'baby-b-policy-60.json',
    ]);
  });

  it('fails closed on a missing cadence point', () => {
    expect(() => extractLv01PolicySnapshots(V16_POLICIES, 25, 88))
      .toThrow(/missing snapshots at 25/u);
    expect(() => extractLv01PolicySnapshots(V16_POLICIES, 0, 88)).toThrow(/positive integer/u);
  });
});

describe('LV01 order-permutation carryover', () => {
  const digest = (branch: 'normal' | 'disabled', selected: string) => ({
    branch,
    scenarioHash: 'sha256:scenario',
    drawCommitment: 'sha256:draw',
    predictionCommitmentV2: 'sha256:prediction',
    selectedCandidateRef: selected,
  });

  it('passes identical digests in any order', () => {
    const first = [digest('normal', 'ref-a'), digest('disabled', 'ref-b')];
    const second = [digest('disabled', 'ref-b'), digest('normal', 'ref-a')];
    expect(() => checkLv01BranchOrderStability(first, second)).not.toThrow();
  });

  it('quarantines branch-divergent sampling', () => {
    const first = [digest('normal', 'ref-a'), digest('disabled', 'ref-b')];
    const second = [digest('normal', 'ref-a'), digest('disabled', 'ref-c')];
    expect(() => checkLv01BranchOrderStability(first, second))
      .toThrow(/order quarantine: disabled diverges in selectedCandidateRef/u);
  });

  it('rejects mismatched branch sets', () => {
    expect(() => checkLv01BranchOrderStability([digest('normal', 'ref-a')], []))
      .toThrow(/branch sets differ/u);
  });
});
