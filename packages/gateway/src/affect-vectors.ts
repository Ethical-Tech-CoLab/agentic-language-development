/**
 * Affect-protocol conformance vectors (ALD-033 criterion 3, ALD-036).
 *
 * The vectors are data, not tests: `__tests__/affect-conformance.test.ts` runs
 * every one of them against a real {@link AffectProtocol} over a real
 * `EvidenceWriter`, with no learner adapter involved — the same shape
 * `conformance-vectors.ts` uses for the carriers.
 *
 * They are kept in their own registry rather than in `conformance-vectors.ts`
 * because that registry is keyed by `RunConfig['carrierMode']` and the affect
 * channel is not a carrier: a run selects exactly one carrier *and*
 * (independently) one `affectMode`. Folding these in requires widening that
 * registry's key to a namespace; see the integrator notes for the exact
 * change. Until then {@link assertEveryAffectModeHasVectors} is the gate for
 * the affect half of ALD-036.
 *
 * `submission` is deliberately typed `unknown`: most vectors are payloads a
 * `submit_affect` proposal could not express, which is exactly what the
 * boundary has to survive.
 */
import type { RunConfig } from '@ald/types';

/** Modes with a Baby-facing `submit_affect` surface. */
export const AFFECT_SUBMISSION_MODES = [
  'declared',
  'permuted',
  'opaque',
] as const satisfies readonly RunConfig['affectMode'][];

/** Every enabled mode ALD-033 must cover. */
export const AFFECT_VECTOR_MODES = [
  'declared',
  'permuted',
  'opaque',
  'derived',
  'emergent',
] as const satisfies readonly RunConfig['affectMode'][];

export type AffectVectorMode = (typeof AFFECT_VECTOR_MODES)[number];

export interface AffectVector {
  name: string;
  /** Raw payload handed to `submitAffectFrom`. */
  submission: unknown;
  /** `accepted`, or the single §9.3 rule 6 reason code. */
  expect: 'accepted' | 'affect-violation';
  /**
   * When set, the submission is attempted by the window's *recipient* rather
   * than its sender (SPEC §9.3 rule 5).
   */
  fromRecipient?: true;
  /**
   * When set, the submission is attempted after the window has already been
   * answered once, or on a window the Gateway never opened.
   */
  outOfWindow?: 'already-answered' | 'never-opened';
}

function submission(displayId: unknown): unknown {
  return { kind: 'submit_affect', publicArtifact: { displayId } };
}

/**
 * Vectors shared by `declared`, `permuted`, and `opaque`: the three modes
 * differ only in what the recipient is delivered and in the Baby-facing
 * labels, never in what the Gateway accepts (SPEC §9.3).
 */
export const AFFECT_SUBMISSION_VECTORS: readonly AffectVector[] = [
  // --- the allowlist, exhaustively (ALD-033 criterion 1) ------------------
  { name: 'accepts A1', submission: submission('A1'), expect: 'accepted' },
  { name: 'accepts A2', submission: submission('A2'), expect: 'accepted' },
  { name: 'accepts A3', submission: submission('A3'), expect: 'accepted' },
  { name: 'accepts A4', submission: submission('A4'), expect: 'accepted' },
  { name: 'accepts A5', submission: submission('A5'), expect: 'accepted' },
  { name: 'accepts A6', submission: submission('A6'), expect: 'accepted' },

  // --- non-allowlisted code points (SPEC §9.3 rule 3) ---------------------
  {
    name: 'rejects a display beyond the allowlist',
    submission: submission('A7'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a zero-indexed display',
    submission: submission('A0'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a lowercase display',
    submission: submission('a1'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a padded display rather than trimming it',
    submission: submission(' A1 '),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a Unicode look-alike of an allowlisted display',
    submission: submission('Ａ１'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects an empty display',
    submission: submission(''),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a numeric display index',
    submission: submission(1),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a null display',
    submission: submission(null),
    expect: 'affect-violation',
  },

  // --- sequences, repetitions, combinations (SPEC §9.3 rule 3) ------------
  {
    name: 'rejects a sequence of two displays',
    submission: submission(['A1', 'A2']),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a repetition of one display',
    submission: submission(['A1', 'A1']),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a single-element sequence',
    submission: submission(['A1']),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a combination object',
    submission: submission({ primary: 'A1', secondary: 'A2' }),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a concatenated pair of displays',
    submission: submission('A1A2'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a plural displayIds field',
    submission: { kind: 'submit_affect', publicArtifact: { displayIds: ['A1'] } },
    expect: 'affect-violation',
  },

  // --- extra fields and free text (SPEC §9.3 rule 1, §9.1) ----------------
  {
    name: 'rejects an extra artifact field beside a valid display',
    submission: {
      kind: 'submit_affect',
      publicArtifact: { displayId: 'A1', intensity: 3 },
    },
    expect: 'affect-violation',
  },
  {
    name: 'rejects free text smuggled beside a valid display',
    submission: {
      kind: 'submit_affect',
      publicArtifact: { displayId: 'A1', note: 'pick the red one' },
    },
    expect: 'affect-violation',
  },
  {
    name: 'rejects an extra proposal-level field',
    submission: {
      kind: 'submit_affect',
      publicArtifact: { displayId: 'A1' },
      runId: 'run-forged',
    },
    expect: 'affect-violation',
  },
  {
    name: 'rejects a display smuggled into a symbols payload',
    submission: { kind: 'emit_symbols', publicArtifact: { symbols: ['A1'] } },
    expect: 'affect-violation',
  },
  {
    name: 'rejects a bare display string',
    submission: 'A1',
    expect: 'affect-violation',
  },
  {
    name: 'rejects a bare artifact with no proposal frame',
    submission: { displayId: 'A1' },
    expect: 'affect-violation',
  },
  {
    name: 'rejects a proposal with no publicArtifact',
    submission: { kind: 'submit_affect' },
    expect: 'affect-violation',
  },
  {
    name: 'rejects an empty publicArtifact',
    submission: { kind: 'submit_affect', publicArtifact: {} },
    expect: 'affect-violation',
  },
  {
    name: 'rejects a null submission',
    submission: null,
    expect: 'affect-violation',
  },

  // --- window discipline (SPEC §9.3 rules 2 and 5) ------------------------
  {
    name: 'rejects a submission by the window recipient',
    submission: submission('A1'),
    expect: 'affect-violation',
    fromRecipient: true,
  },
  {
    name: 'rejects a second submission in one window',
    submission: submission('A2'),
    expect: 'affect-violation',
    outOfWindow: 'already-answered',
  },
  {
    name: 'rejects a submission for a window that never opened',
    submission: submission('A3'),
    expect: 'affect-violation',
    outOfWindow: 'never-opened',
  },
];

/**
 * `derived` and `emergent` expose no `submit_affect` surface at all
 * (ALD-033 criterion 2), so *every* submission is a violation — including a
 * perfectly well-formed one, which is the property worth pinning.
 */
export const AFFECT_NO_SUBMISSION_VECTORS: readonly AffectVector[] = [
  {
    name: 'rejects a well-formed submission where submit_affect is unavailable',
    submission: submission('A1'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a malformed submission where submit_affect is unavailable',
    submission: submission('A9'),
    expect: 'affect-violation',
  },
  {
    name: 'rejects a bare submission where submit_affect is unavailable',
    submission: 'A1',
    expect: 'affect-violation',
  },
];

const modeVectors = new Map<AffectVectorMode, readonly AffectVector[]>([
  ['declared', AFFECT_SUBMISSION_VECTORS],
  ['permuted', AFFECT_SUBMISSION_VECTORS],
  ['opaque', AFFECT_SUBMISSION_VECTORS],
  ['derived', AFFECT_NO_SUBMISSION_VECTORS],
  ['emergent', AFFECT_NO_SUBMISSION_VECTORS],
]);

export function affectVectorsFor(
  mode: AffectVectorMode,
): readonly AffectVector[] | undefined {
  return modeVectors.get(mode);
}

/**
 * Namespace prefix for the day `conformance-vectors.ts` widens its registry
 * key from `RunConfig['carrierMode']` to a namespaced string. At that point
 * the affect vectors register as `affect:declared`, `affect:permuted`, … and
 * `assertEveryCarrierHasVectors` covers them too; until then
 * {@link assertEveryAffectModeHasVectors} is the gate. Exported so the
 * integrator's registration call needs no string literals of its own.
 */
export const AFFECT_VECTOR_NAMESPACE = 'affect';

/** The namespaced registry key for one mode, e.g. `affect:declared`. */
export function affectVectorKey(mode: AffectVectorMode): string {
  return `${AFFECT_VECTOR_NAMESPACE}:${mode}`;
}

/**
 * The ALD-033 criterion 3 gate: every enabled affect mode must contribute
 * vectors, and the three submission modes must contribute both an acceptance
 * and a rejection, so a mode cannot be declared conformant on happy-path
 * coverage alone.
 */
export function assertEveryAffectModeHasVectors(
  modes: readonly AffectVectorMode[] = AFFECT_VECTOR_MODES,
): void {
  const missing = modes.filter((mode) => !modeVectors.has(mode));
  if (missing.length > 0) {
    throw new Error(
      `Affect mode(s) contribute no conformance vectors: ${missing.join(', ')}`,
    );
  }
  for (const mode of modes) {
    const vectors = modeVectors.get(mode) as readonly AffectVector[];
    if (!vectors.some((vector) => vector.expect === 'affect-violation')) {
      throw new Error(`${mode} vectors must include at least one rejection`);
    }
    const submissionMode = (
      AFFECT_SUBMISSION_MODES as readonly string[]
    ).includes(mode);
    if (submissionMode && !vectors.some((vector) => vector.expect === 'accepted')) {
      throw new Error(`${mode} vectors must include at least one acceptance`);
    }
  }
}
