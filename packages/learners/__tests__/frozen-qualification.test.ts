import { describe, expect, it } from 'vitest';

import { ScriptedModelClient } from '../src/llm-scripted-client.js';
import {
  FROZEN_MODEL_QUALIFICATION_LABEL,
  runFrozenModelQualification,
} from '../src/frozen-qualification.js';

describe('frozen-model qualification report', () => {
  it('exercises both roles and emits only bounded provenance and counts', async () => {
    const report = await runFrozenModelQualification({
      client: new ScriptedModelClient(),
      softwareCommit: '1'.repeat(40),
      executedAt: '2026-09-09T00:00:00.000Z',
      episodes: 2,
    });
    expect(report.claimBoundary).toBe(FROZEN_MODEL_QUALIFICATION_LABEL);
    expect(report.proposals).toBe(4);
    expect(report.roles['baby-a'].intentions).toBeGreaterThan(0);
    expect(report.roles['baby-a'].interpretations).toBeGreaterThan(0);
    expect(report.roles['baby-b'].intentions).toBeGreaterThan(0);
    expect(report.roles['baby-b'].interpretations).toBeGreaterThan(0);
    expect(report.policyUpdatesObserved).toBe(false);

    const json = JSON.stringify(report);
    for (const prohibited of [
      'systemPrompt',
      'observation',
      'privateLedgerDraft',
      'rawOutput',
      'candidateRefs',
      'deliveredSymbols',
    ]) {
      expect(json).not.toContain(prohibited);
    }
  });

  it('requires enough episodes for both roles to send and receive', async () => {
    await expect(
      runFrozenModelQualification({
        client: new ScriptedModelClient(),
        softwareCommit: '1'.repeat(40),
        executedAt: '2026-09-09T00:00:00.000Z',
        episodes: 1,
      }),
    ).rejects.toThrow(/at least two episodes/u);
  });
});
