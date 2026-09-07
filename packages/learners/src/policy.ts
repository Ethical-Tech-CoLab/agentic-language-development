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

export const ExportedTabularPolicySchema = z.object({
  version: z.literal(1),
  /** `[typeCode][symbolIndex]` sender logits. */
  thetaSender: z.array(z.array(z.number())).min(1),
  /** `[position][symbolIndex][typeCode]` receiver logits. */
  thetaReceiver: z.array(z.array(z.array(z.number()))).min(1),
  /** Moving-average REINFORCE baseline. */
  baseline: z.number(),
  options: TabularPolicyOptionsSchema,
});

export type TabularPolicyOptions = z.infer<typeof TabularPolicyOptionsSchema>;
export type ExportedTabularPolicy = z.infer<typeof ExportedTabularPolicySchema>;

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
