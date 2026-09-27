/** LV01 shared action draw: derivation, commitment, disclosure audit. */
import { drawIndexFromUnit, unitBitsHex } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  commitLv01ActionDraw,
  deriveLv01ActionDrawSeed,
  drawLv01SharedUnit,
  verifyLv01ActionDraw,
  type Lv01ActionDrawScope,
} from '../../src/experiments/lv01-action-draw.js';

const scope: Lv01ActionDrawScope = {
  stage: 'development',
  slotKind: 'primary',
  slotIndex: '0007',
  partition: 'dev',
  receiverRole: 'baby-b',
  caseId: 'case-0',
};
const refs = ['ref-a', 'ref-b', 'ref-c', 'ref-d'];

describe('LV01 shared action draw', () => {
  it('derives a branch-free seed deterministically', () => {
    const first = deriveLv01ActionDrawSeed('root-seed', scope);
    const second = deriveLv01ActionDrawSeed('root-seed', { ...scope });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveLv01ActionDrawSeed('other-root', scope)).not.toBe(first);
    expect(deriveLv01ActionDrawSeed('root-seed', { ...scope, caseId: 'case-1' })).not.toBe(first);
    expect(() => deriveLv01ActionDrawSeed('root-seed', { ...scope, slotIndex: '7' }))
      .toThrow(/zero-padded/u);
  });

  it('draws a stable unit value per turn', () => {
    const seed = deriveLv01ActionDrawSeed('root-seed', scope);
    const u0 = drawLv01SharedUnit(seed, 0);
    expect(u0).toBe(drawLv01SharedUnit(seed, 0));
    expect(u0).toBeGreaterThanOrEqual(0);
    expect(u0).toBeLessThan(1);
    expect(drawLv01SharedUnit(seed, 1)).not.toBe(u0);
  });

  it('commits hiding digests and audits the disclosed selection', () => {
    const seed = deriveLv01ActionDrawSeed('root-seed', scope);
    const committed = commitLv01ActionDraw({
      drawSeed: seed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: refs,
      preStateCommitment: 'sha256:prestate',
    });
    expect(committed.uBitsHex).toBe(unitBitsHex(committed.u));
    expect(JSON.stringify(committed)).not.toContain(seed);
    expect(committed.drawCommitment).toMatch(/^sha256:/u);
    const probs = [0.1, 0.2, 0.3, 0.4];
    const selected = drawIndex(committed.u, probs);
    verifyLv01ActionDraw({
      drawSeed: seed,
      turn: 0,
      disclosure: {
        uBitsHex: committed.uBitsHex,
        probs,
        candidateRefs: refs,
        selectedCandidateRef: refs[selected] as string,
      },
    });
  });

  it('rejects a wrong unit value, swapped vector, or moved selection', () => {
    const seed = deriveLv01ActionDrawSeed('root-seed', scope);
    const committed = commitLv01ActionDraw({
      drawSeed: seed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: refs,
      preStateCommitment: 'sha256:prestate',
    });
    const probs = [0.1, 0.2, 0.3, 0.4];
    const selected = drawIndex(committed.u, probs);
    const good = {
      uBitsHex: committed.uBitsHex,
      probs,
      candidateRefs: refs,
      selectedCandidateRef: refs[selected] as string,
    };
    expect(() => verifyLv01ActionDraw({
      drawSeed: seed, turn: 0,
      disclosure: { ...good, uBitsHex: '00'.repeat(8) },
    })).toThrow(/unit value/u);
    expect(() => verifyLv01ActionDraw({
      drawSeed: seed, turn: 0,
      disclosure: { ...good, probs: [...probs].reverse() },
    })).toThrow(/selection/u);
    expect(() => verifyLv01ActionDraw({
      drawSeed: seed, turn: 0,
      disclosure: { ...good, selectedCandidateRef: refs[(selected + 1) % 4] as string },
    })).toThrow(/selection/u);
  });
});

function drawIndex(u: number, probs: readonly number[]): number {
  return drawIndexFromUnit(probs, u);
}
