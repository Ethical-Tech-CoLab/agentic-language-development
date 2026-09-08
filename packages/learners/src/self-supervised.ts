/**
 * `self-supervised` learner track (SPEC §6.1; BACKLOG ALD-046).
 *
 * PLACEHOLDER — replaced by the ALD-046 implementation. Until then the
 * factory throws `NotImplementedTrackError` naming its backlog item rather
 * than falling back to another track (SPEC §6.1: never a silent default).
 */
import type { LearnerAdapterFactory } from '@ald/types';

import { NotImplementedTrackError } from './errors.js';

/** Options accepted by the `self-supervised` factory. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- placeholder until the track lands
export interface SelfSupervisedAdapterOptions {}

export function createSelfSupervisedAdapterFactory(
  _options: SelfSupervisedAdapterOptions = {},
): LearnerAdapterFactory {
  throw new NotImplementedTrackError('self-supervised', 'ALD-046');
}
