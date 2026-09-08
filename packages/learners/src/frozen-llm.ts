/**
 * `frozen-llm` learner track (SPEC §6.1; BACKLOG ALD-044).
 *
 * PLACEHOLDER — replaced by the ALD-044 implementation. Until then the
 * factory throws `NotImplementedTrackError` naming its backlog item rather
 * than falling back to another track (SPEC §6.1: never a silent default).
 */
import type { LearnerAdapterFactory } from '@ald/types';

import { NotImplementedTrackError } from './errors.js';

/** Options accepted by the `frozen-llm` factory. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- placeholder until the track lands
export interface FrozenLlmAdapterOptions {}

export function createFrozenLlmAdapterFactory(
  _options: FrozenLlmAdapterOptions = {},
): LearnerAdapterFactory {
  throw new NotImplementedTrackError('frozen-llm', 'ALD-044');
}
