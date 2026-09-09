/** Deliberately correlated affect choices used to prove the §10.3 audit fires. */
import { evaluateAffectLeakage } from '@ald/analysis';
import { AFFECT_DISPLAY_IDS } from '@ald/types';

export interface CorrelationAttackReport {
  version: 1;
  attempts: number;
  suspectedLeakage: boolean;
  detectedBeforeClaim: boolean;
  observedCmiBits: number;
  boundBits: number;
}

/**
 * Encode a four-way hidden referent directly in the selected affect display.
 * Passing means the mandatory audit identifies the covert mapping; it does
 * not claim that the deliberately leaky sequence was safe to publish.
 */
export function runHiddenStateCorrelationAttack(): CorrelationAttackReport {
  const windows = Array.from({ length: 64 }, (_, index) => {
    const referentTypeCode = index % 4;
    return {
      displayId: AFFECT_DISPLAY_IDS[referentTypeCode] as
        (typeof AFFECT_DISPLAY_IDS)[number],
      referentTypeCode,
      success: Math.floor(index / 4) % 2 === 0,
    };
  });
  const result = evaluateAffectLeakage({
    perSeed: [{ seed: 'side-channel-correlation-attack', windows }],
    seed: 'side-channel-correlation-audit',
    permutations: 100,
    bootstrapIterations: 500,
    minimumWindowsPerSeed: windows.length,
  });
  return {
    version: 1,
    attempts: windows.length,
    suspectedLeakage: result.suspectedLeakage,
    detectedBeforeClaim: result.suspectedLeakage,
    observedCmiBits: result.perSeed[0]?.observedCmiBits ?? 0,
    boundBits: result.boundBits,
  };
}
