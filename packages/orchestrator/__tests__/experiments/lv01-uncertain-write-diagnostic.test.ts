/**
 * H07 LV01 uncertain-write contract: one LV01-scope commit-without-
 * confirmation case through the mode-r uncertain-write v6 single path —
 * commit, lost reply, live quarantine, restarted recovery refusal, no retry.
 * In-process only (real evidence store and durable write-intent journal, no
 * Docker); the learner track is out of scope because the fault sits in the
 * evidence path, matching the v6 development runner's no-learning config.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  auditLv01UncertainWriteDiagnostic,
  injectLv01UncertainWrite,
  recoverLv01UncertainWrite,
} from '../../src/experiments/lv01-uncertain-write-diagnostic.js';

import {
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from '../helpers.js';

describe('LV01 uncertain-write diagnostic (H07)', () => {
  let harness: Harness | undefined;
  let restarted: Harness | undefined;

  afterEach(async () => {
    await restarted?.cleanup();
    await harness?.cleanup();
    harness = undefined;
    restarted = undefined;
  });

  it('fails closed on a committed write with no confirmation, across restart', async () => {
    harness = await createHarness();
    const runId = 'lv01-uncertain-write-diagnostic';
    // Synthetic scope binding: the LV01 experiment id requires its
    // ledgerValuePlan, but this diagnostic exercises the evidence path, not
    // the ledger-value predictor, so the hashes are placeholders.
    await harness.runtime.createRun(testConfig(noLearningOverrides({
      runId,
      experimentId: 'LV01',
      randomSeed: 'lv01-uncertain-write-diagnostic',
      maxTurnsPerRun: 3,
      evaluationTurns: 1,
      ledgerValuePlan: {
        version: 1,
        designCommitmentHash: `sha256:${'a'.repeat(64)}`,
        analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
        seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
        predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
        partitionContractVersion: 'lv01-within-support/v1',
      },
    })));

    const inject = await injectLv01UncertainWrite(harness.runtime, runId);

    restarted = harness.restart();
    const recovery = await recoverLv01UncertainWrite(restarted.runtime, runId);

    expect(() => auditLv01UncertainWriteDiagnostic({ inject, recovery })).not.toThrow();
  });
});
