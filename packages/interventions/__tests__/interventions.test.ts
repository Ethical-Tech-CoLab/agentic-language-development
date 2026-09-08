import { describe, expect, it } from 'vitest';
import { buildConformanceRunConfig } from '@ald/learners';
import type { RunConfig } from '@ald/types';

import {
  CurriculumExecutor,
  assertStagesSupported,
  buildInterventionRunPlan,
  evaluateInterventionSuite,
  evaluateRepair,
  planEvaluationProbes,
  validateCurriculumStages,
} from '../src/index.js';
import { claimEvent, messageEvent } from './fixtures.js';

describe('configuration-driven intervention planning', () => {
  it('assembles every enabled intervention from RunConfig alone', () => {
    const base = buildConformanceRunConfig('scratch-rl', {
      episodes: 12,
      messageLength: 2,
    });
    const config: RunConfig = {
      ...base,
      interventionPlan: {
        version: 1,
        evaluationSuite: {
          ablation: true,
          substitution: true,
          scramblingControl: true,
          probeShare: 0.5,
        },
        repair: { enabled: true, maxExtraTurns: 1 },
        heldOutTypeCodes: [3, 7],
        curriculum: {
          stages: [
            { stageIndex: 0, startTurn: 0, maxSymbolsPerMessage: 1 },
            { stageIndex: 1, startTurn: 6, maxSymbolsPerMessage: 2 },
          ],
        },
        driftEvaluationInterval: 4,
      },
    };

    const plan = buildInterventionRunPlan({
      config,
      evaluationTurns: [8, 9, 10, 11],
      ledgers: { babyA: [], babyB: [] },
      symbolInventory: ['s0', 's1', 's2', 's3'],
      seed: 'pre-registered-analysis-seed',
    });

    expect(plan.configurationBasis).toBe('run-config-intervention-plan');
    expect(plan.enabled).toEqual({
      evaluationSuite: true,
      ablation: true,
      substitution: true,
      scramblingControl: true,
      repair: true,
      heldOutTypeCodes: true,
      curriculum: true,
      driftEvaluation: true,
    });
    expect(plan.driftEvaluationTurns).toEqual([4, 8]);
    expect(plan.scramblingControl.appliesTo).toBe('offline-analysis-only');
    expect(plan.heldOutTypeCodes).toEqual([3, 7]);
  });

  it('produces an inert plan when the configuration has no intervention plan', () => {
    const config = buildConformanceRunConfig('scratch-rl', { episodes: 4 });
    const plan = buildInterventionRunPlan({
      config,
      evaluationTurns: [2, 3],
      ledgers: { babyA: [], babyB: [] },
      symbolInventory: ['s0', 's1'],
    });

    expect(plan.planPresent).toBe(false);
    expect(Object.values(plan.enabled)).toEqual(Array(8).fill(false));
    expect(plan.probeSchedule.probes).toEqual([]);
    expect(plan.curriculum).toBeNull();
  });
});

describe('causal intervention suite', () => {
  it('plans from prior ledger claims and scores the registered directions', () => {
    const ledger = [
      claimEvent({ sequence: 1, form: 'S01', typeCode: 0, confidence: 0.9 }),
      claimEvent({ sequence: 2, form: 'S02', typeCode: 1, confidence: 0.8 }),
      messageEvent({ sequence: 3, symbols: ['S01'] }),
      messageEvent({ sequence: 4, symbols: ['S02'] }),
    ];
    const schedule = planEvaluationProbes({
      plan: {
        version: 1,
        evaluationSuite: {
          ablation: true,
          substitution: true,
          scramblingControl: true,
          probeShare: 1,
        },
      },
      evaluationTurns: [20, 21, 22, 23],
      ledgers: { babyA: ledger, babyB: ledger },
      symbolInventory: ['S01', 'S02'],
      seed: 'probe-plan',
      roleReversalPeriod: 1,
      messageLength: 1,
    });

    expect(schedule.probes).toHaveLength(4);
    expect(schedule.baselineTurns).toEqual([]);
    expect(schedule.probes.map((probe) => probe.kind)).toEqual([
      'ablation',
      'substitution',
      'ablation',
      'substitution',
    ]);
    expect(schedule.probes.every((probe) => probe.predictedDirection.predictedBy === 'agent-native-ledger')).toBe(
      true,
    );

    const candidateRefs = ['object:zero', 'object:one'];
    const candidateTypeCodes = [0, 1];
    const observed = schedule.probes.map((planned) => {
      const shift = planned.predictedDirection.predictedCandidateShift;
      const predicted =
        planned.kind === 'ablation'
          ? (shift.awayFromTypeCode as number)
          : (shift.towardTypeCode as number);
      const other = predicted === 0 ? 1 : 0;
      return {
        turn: planned.turn,
        probeId: planned.probe.probeId,
        candidateRefs,
        candidateTypeCodes,
        receiverActionRef:
          candidateRefs[planned.kind === 'ablation' ? other : predicted] as string,
        unprobedBaselineActionRef:
          candidateRefs[planned.kind === 'ablation' ? predicted : other] as string,
        success: true,
      };
    });
    const result = evaluateInterventionSuite({
      schedule,
      observed,
      threshold: 0.7,
    });

    expect(result.descriptiveAgreement).toMatchObject({
      probes: 4,
      scored: 4,
      agreements: 4,
      agreementRate: 1,
    });
    expect(result.meetsDescriptiveReadinessThreshold).toBe(true);
    expect(result.readinessThresholdKind).toBe('descriptive-not-inferential');
    expect(result.confirmatory).toBeNull();
    expect(result.claimBoundary).toBe('software-readiness-only');
  });
});

describe('fixed curriculum execution', () => {
  const stages = [
    {
      stageIndex: 0,
      startTurn: 0,
      learnerOptions: { learningRate: 0.1 },
      maxSymbolsPerMessage: 1,
    },
    { stageIndex: 1, startTurn: 5, consolidation: true },
    {
      stageIndex: 2,
      startTurn: 9,
      learnerOptions: { explorationRate: 0.05 },
      maxSymbolsPerMessage: 2,
    },
  ] as const;

  it('selects stages and transitions solely by turn', () => {
    const executor = new CurriculumExecutor({
      stages,
      maxSymbolsPerMessage: 2,
      maxTurnsPerRun: 12,
    });

    expect(executor.stageForTurn(4).stageIndex).toBe(0);
    expect(executor.stageForTurn(5).stageIndex).toBe(1);
    expect(executor.consolidating(8)).toBe(true);
    expect(executor.maxSymbolsPerMessageAt(10)).toBe(2);
    expect(executor.transitionsBetween(-1, 9).map((entry) => entry.turn)).toEqual([
      0, 5, 9,
    ]);
  });

  it('rejects schedules that widen capacity or use unsupported knobs', () => {
    expect(() =>
      validateCurriculumStages({
        stages: [{ stageIndex: 0, startTurn: 0, maxSymbolsPerMessage: 3 }],
        maxSymbolsPerMessage: 2,
      }),
    ).toThrow(/above the run ceiling/u);

    expect(() =>
      assertStagesSupported(stages, {
        learningRate: true,
        maxSymbolsPerMessage: true,
        consolidation: true,
      }),
    ).toThrow(/explorationRate/u);
  });
});

describe('repair metrics', () => {
  it('measures bounded repair, role reversal, held-out success, and form reuse', () => {
    const result = evaluateRepair({
      maxExtraTurns: 1,
      maxSymbolsPerMessage: 2,
      episodes: [
        {
          episodeId: 'seen-resolved',
          ambiguous: true,
          split: 'train',
          attempts: [
            {
              turn: 0,
              attempt: 0,
              sender: 'baby-a',
              receiver: 'baby-b',
              success: false,
              formHash: 'first-a',
              messageLength: 2,
            },
            {
              turn: 1,
              attempt: 1,
              sender: 'baby-b',
              receiver: 'baby-a',
              success: true,
              formHash: 'repair-x',
              messageLength: 2,
            },
          ],
        },
        {
          episodeId: 'held-out-unresolved',
          ambiguous: true,
          split: 'held-out',
          attempts: [
            {
              turn: 2,
              attempt: 0,
              sender: 'baby-b',
              receiver: 'baby-a',
              success: false,
              formHash: 'first-b',
            },
            {
              turn: 3,
              attempt: 1,
              sender: 'baby-a',
              receiver: 'baby-b',
              success: false,
              formHash: 'repair-x',
            },
          ],
        },
        {
          episodeId: 'clear-first-try',
          ambiguous: false,
          split: 'train',
          attempts: [
            {
              turn: 4,
              attempt: 0,
              sender: 'baby-a',
              receiver: 'baby-b',
              success: true,
            },
          ],
        },
      ],
    });

    expect(result.repairRate?.summary).toMatchObject({ successes: 1, n: 2, proportion: 0.5 });
    expect(result.turnsPerResolvedAmbiguity).toBe(2);
    expect(result.repairInitiation).toEqual({ originalReceiver: 2, originalSender: 0 });
    expect(result.reuse).toMatchObject({
      repairAttemptsWithForm: 2,
      distinctRepairForms: 1,
      reusedAttempts: 1,
      reuseRate: 0.5,
      repairSpecificForms: 1,
    });
    expect(result.seenRepairRate?.summary.proportion).toBe(1);
    expect(result.heldOutRepairRate?.summary.proportion).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.claimBoundary).toBe('software-readiness-only');
  });
});
