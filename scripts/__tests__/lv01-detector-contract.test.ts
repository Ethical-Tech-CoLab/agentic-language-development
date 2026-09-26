import { describe, expect, it } from 'vitest';

import { RECURRENT_ARCHITECTURE } from '@ald/learners';
import { LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE, validateLv01DetectorConfig, validateLv01DetectorObservation } from '../../deploy/mode-r/lv01-detector-contract.mjs';

describe('LV01 detector contract', () => {
  it('requires the full recurrent selected-topology collection shape', () => {
    expect(() => validateLv01DetectorConfig({
      experimentId: 'LV01', deploymentMode: 'research-grade',
      babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
      babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
      maxTurnsPerRun: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
      evaluationTurns: 0, turnResponseBudgetMs: 1_000, ledgerValuePlan: {},
    })).not.toThrow();
    expect(() => validateLv01DetectorConfig({
      experimentId: 'LV01', deploymentMode: 'research-grade',
      babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
      maxTurnsPerRun: 4, evaluationTurns: 0, turnResponseBudgetMs: 1_000, ledgerValuePlan: {},
    })).toThrow();
  });

  it('requires the sealed capture-only detector observation shape', () => {
    const valid = {
      classification: 'lv01-selected-detector-observation-stage',
      researchFinding: false,
      learnerArchitecture: RECURRENT_ARCHITECTURE,
      state: 'sealed',
      turnCount: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
      captured: Array.from(
        { length: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE * 2 },
        () => ({ delivered: true }),
      ),
    };
    expect(() => validateLv01DetectorObservation(valid)).not.toThrow();
    expect(() => validateLv01DetectorObservation({
      ...valid,
      captured: valid.captured.slice(1),
    })).toThrow();
    expect(() => validateLv01DetectorObservation({
      ...valid,
      captured: valid.captured.map(() => ({ delivered: false })),
    })).toThrow();
  });
});
