/**
 * `hybrid` learner track (SPEC §6.1; BACKLOG ALD-047).
 *
 * PLACEHOLDER — replaced by the ALD-047 implementation. Until then the
 * factory throws `NotImplementedTrackError` naming its backlog item rather
 * than falling back to another track (SPEC §6.1: never a silent default).
 */
import type { LearnerAdapterFactory } from '@ald/types';

import { NotImplementedTrackError } from './errors.js';

/** Options accepted by the `hybrid` factory. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- placeholder until the track lands
export interface HybridAdapterOptions {}

export function createHybridAdapterFactory(
  _options: HybridAdapterOptions = {},
): LearnerAdapterFactory {
  throw new NotImplementedTrackError('hybrid', 'ALD-047');
}
