/**
 * Exported policy state for the tabular `scratch-rl` reference track.
 *
 * `LearnerAdapter.exportPolicy()` returns `unknown` by contract (SPEC §6.2)
 * because every track has its own state shape. This module gives the tabular
 * track a validated, canonicalizable shape so that
 * `hashCanonical(HASH_DOMAINS.policyCheckpoint, policy)` is stable across
 * processes and so a derived run (SPEC §7.4) can load a checkpoint that was
 * round-tripped through JSON.
 *
 * All numbers are rounded to 12 decimal places before export: IEEE-754 tails
 * differ between accumulation orders and would otherwise change the policy
 * hash without changing behavior.
 *
 * Besides the learned tables, a checkpoint carries the adapter's episodic
 * registries (`EpisodicRegistriesSchema`), because SPEC §7.3 recovery
 * re-initializes an adapter against a ledger chain it has already written to.
 */
import { z } from 'zod';

import { LearnerConfigurationError } from './errors.js';

export const POLICY_DECIMALS = 12;

export const TabularPolicyOptionsSchema = z.object({
  valuesPerAttribute: z.number().int().positive(),
  attributeCount: z.number().int().positive(),
  messageLength: z.number().int().positive(),
  learningRate: z.number().positive(),
  baselineDecay: z.number().min(0).max(1),
  temperature: z.number().positive(),
  intrinsicMode: z.literal('prediction-progress').optional(),
});

/** One symbol's current hypothesis (CONCEPT-IDEA.md §11.2 rule 3). */
export const HypothesisRecordSchema = z.object({
  symbol: z.string().min(1),
  version: z.number().int().positive(),
  hypothesisRef: z.string().min(1),
  argmaxTypeCode: z.number().int().min(0),
});

/** One key of the intrinsic-mode prediction model (SPEC §11.1). */
export const PredictorEntrySchema = z.object({
  key: z.string().min(1),
  value: z.number(),
});

/**
 * The episodic (per-run, per-Baby) registries an adapter must not lose when it
 * is re-initialized inside a run.
 *
 * These are not learned parameters: they record what this Baby has already
 * written to *this* ledger chain — which terms it has already recorded a first
 * use for (CONCEPT-IDEA.md §11.2 rule 1) and which hypothesis reference each
 * symbol currently carries (rule 3, LEDGER §5's revision graph). SPEC §7.3
 * crash recovery re-initializes the adapter against the same chain, so without
 * them the recovered adapter re-emits `term.first_*` events for terms that
 * already have one and re-issues `hyp:<symbol>:1` for a different hypothesis.
 *
 * `runId`/`babyId` scope them to the chain they describe: a derived run (SPEC
 * §7.4) loads the same checkpoint but starts a *fresh* chain, so it must start
 * with empty registries and record its own first uses.
 */
export const EpisodicRegistriesSchema = z.object({
  runId: z.string().min(1),
  babyId: z.string().min(1),
  /** Symbols this Baby has already recorded `term.first_emitted` for. */
  emitted: z.array(z.string().min(1)),
  /** Symbols this Baby has already recorded `term.first_received` for. */
  received: z.array(z.string().min(1)),
  hypotheses: z.array(HypothesisRecordSchema),
  predictor: z.array(PredictorEntrySchema),
});

/**
 * Current exported-policy version.
 *
 * Version 2 adds `registries`. A version 1 checkpoint still loads: it simply
 * carries no registries, and the adapter then starts with empty ones — the
 * pre-existing behavior, which is correct for a derived run and lossy only for
 * a recovery from a checkpoint written before this field existed.
 */
export const EXPORTED_TABULAR_POLICY_VERSION = 2 as const;

export const ExportedTabularPolicySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  /** `[typeCode][symbolIndex]` sender logits. */
  thetaSender: z.array(z.array(z.number())).min(1),
  /** `[position][symbolIndex][typeCode]` receiver logits. */
  thetaReceiver: z.array(z.array(z.array(z.number()))).min(1),
  /** Moving-average REINFORCE baseline. */
  baseline: z.number(),
  options: TabularPolicyOptionsSchema,
  /** Absent in a version 1 checkpoint. */
  registries: EpisodicRegistriesSchema.optional(),
});

export type TabularPolicyOptions = z.infer<typeof TabularPolicyOptionsSchema>;
export type ExportedTabularPolicy = z.infer<typeof ExportedTabularPolicySchema>;
export type ExportedEpisodicRegistries = z.infer<
  typeof EpisodicRegistriesSchema
>;
export type ExportedHypothesisRecord = z.infer<typeof HypothesisRecordSchema>;

export interface TabularPolicyShape {
  typeCount: number;
  symbolCount: number;
  messageLength: number;
}

/**
 * Parse and shape-check an exported tabular policy. Rejects ragged tables so
 * downstream index arithmetic cannot silently read `undefined`.
 */
export function parseExportedTabularPolicy(
  value: unknown,
): ExportedTabularPolicy {
  const policy = ExportedTabularPolicySchema.parse(value);
  const typeCount = policy.thetaSender.length;
  const symbolCount = (policy.thetaSender[0] as number[]).length;

  if (symbolCount === 0) {
    throw new LearnerConfigurationError('thetaSender rows must not be empty');
  }
  for (const row of policy.thetaSender) {
    if (row.length !== symbolCount) {
      throw new LearnerConfigurationError('thetaSender must be rectangular');
    }
  }
  if (policy.thetaReceiver.length !== policy.options.messageLength) {
    throw new LearnerConfigurationError(
      'thetaReceiver must have one table per message position',
    );
  }
  for (const table of policy.thetaReceiver) {
    if (table.length !== symbolCount) {
      throw new LearnerConfigurationError(
        'each thetaReceiver table must have one row per symbol',
      );
    }
    for (const row of table) {
      if (row.length !== typeCount) {
        throw new LearnerConfigurationError(
          'each thetaReceiver row must have one column per type code',
        );
      }
    }
  }

  return policy;
}

/** Table dimensions implied by an exported policy. */
export function tabularPolicyShape(
  policy: ExportedTabularPolicy,
): TabularPolicyShape {
  return {
    typeCount: policy.thetaSender.length,
    symbolCount: (policy.thetaSender[0] as number[]).length,
    messageLength: policy.options.messageLength,
  };
}
