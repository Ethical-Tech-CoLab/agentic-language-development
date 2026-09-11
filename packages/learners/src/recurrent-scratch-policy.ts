import { z } from 'zod';

import { CarrierLearningStateSchema } from './carrier-support.js';
import { LearnerConfigurationError } from './errors.js';
import { EpisodicRegistriesSchema } from './policy.js';
import {
  ExportedRecurrentModelSchema,
  RECURRENT_ARCHITECTURE,
  RECURRENT_RL_OBJECTIVE,
} from './recurrent-model.js';

export const RECURRENT_SCRATCH_POLICY_VERSION = 2 as const;

export const RecurrentScratchPolicyOptionsSchema = z
  .object({
    valuesPerAttribute: z.number().int().positive(),
    attributeCount: z.number().int().positive(),
    messageLength: z.number().int().positive(),
    temperature: z.number().positive(),
    learningRate: z.number().positive(),
    baselineDecay: z.number().min(0).max(1),
    intrinsicMode: z.literal('prediction-progress').optional(),
  })
  .strict();

const RecurrentScratchPolicyFields = {
    track: z.literal('scratch-rl'),
    architecture: z.literal(RECURRENT_ARCHITECTURE),
    updateRule: z.literal(RECURRENT_RL_OBJECTIVE),
    options: RecurrentScratchPolicyOptionsSchema,
    model: ExportedRecurrentModelSchema,
    registries: EpisodicRegistriesSchema,
} as const;

export const ExportedRecurrentScratchPolicySchema = z.union([
  z.object({
    version: z.literal(1),
    ...RecurrentScratchPolicyFields,
  }).strict(),
  z.object({
    version: z.literal(RECURRENT_SCRATCH_POLICY_VERSION),
    ...RecurrentScratchPolicyFields,
    carrierState: CarrierLearningStateSchema,
  }).strict(),
]);

export type ExportedRecurrentScratchPolicy = z.infer<
  typeof ExportedRecurrentScratchPolicySchema
>;

export function parseExportedRecurrentScratchPolicy(
  value: unknown,
): ExportedRecurrentScratchPolicy {
  const policy = ExportedRecurrentScratchPolicySchema.parse(value);
  const model = policy.model.options;
  const typeCount =
    policy.options.valuesPerAttribute ** policy.options.attributeCount;
  const mismatches: string[] = [];
  if (model.typeCount !== typeCount) mismatches.push('typeCount');
  if (model.messageLength !== policy.options.messageLength) {
    mismatches.push('messageLength');
  }
  if (mismatches.length > 0) {
    throw new LearnerConfigurationError(
      `recurrent scratch policy is internally inconsistent: ${mismatches.join(', ')}`,
    );
  }
  return policy;
}
