/**
 * Fixed-token conformance vectors (ALD-036, ALD-030, ALD-034, ALD-035).
 *
 * The vectors are data, not tests: they run against a real
 * `SymbolGatewayImpl` and a real `EvidenceWriter` with no learner adapter
 * involved (ALD-036 criterion 2), and the later ALD-031/ALD-033 modules
 * extend the suite by exporting their own vector arrays in the same shape.
 *
 * Each vector's `envelope` is deliberately typed `unknown`: several of them
 * are malformed submissions that a `TurnProposalEnvelope` could not express,
 * which is exactly what the boundary has to survive.
 */
import { fixedTokenInventory, type RunConfig } from '@ald/types';

import type { GatewayReasonCode } from './reason-codes.js';

/** SPEC §9.1 default inventory (`S01`-`S32`) the vectors are written against. */
export const CONFORMANCE_INVENTORY: readonly string[] = fixedTokenInventory(32);
/** SPEC §9.1 default `maxSymbolsPerMessage` the vectors assume. */
export const CONFORMANCE_MAX_SYMBOLS = 4;
/** SPEC §9.1 default `maxSymbolRepeats` the vectors assume. */
export const CONFORMANCE_MAX_SYMBOL_REPEATS = 3;

/** A distinctive hash used inside metadata vectors; never produced by a run. */
const SENTINEL_HASH = `sha256:${'a'.repeat(64)}`;

export interface ConformanceVector {
  name: string;
  /** Raw submission handed to `submitProposal`. */
  envelope: unknown;
  /** `accepted`, or the exact reason code the Gateway must report. */
  expect: 'accepted' | GatewayReasonCode;
}

/** A valid `intention.recorded` draft (SPEC §8.1 step 2, §11.4). */
export function conformanceIntentionDraft(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: 'subject-conformance',
    content: { artifactRef: 'artifact-conformance' },
    blindingNonce: 'nonce-conformance',
    evidenceRefs: [],
    ...overrides,
  };
}

function envelope(
  proposal: unknown,
  draft: unknown = conformanceIntentionDraft(),
): unknown {
  return { proposal, privateLedgerDraft: draft };
}

function symbolProposal(publicArtifact: unknown): unknown {
  return { kind: 'emit_symbols', publicArtifact };
}

export const FIXED_TOKEN_VECTORS: readonly ConformanceVector[] = [
  // --- acceptance (ALD-030 criterion 1) -----------------------------------
  {
    name: 'accepts one inventory symbol',
    envelope: envelope(symbolProposal({ symbols: ['S01'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts two inventory symbols',
    envelope: envelope(symbolProposal({ symbols: ['S13', 'S04'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts three inventory symbols',
    envelope: envelope(symbolProposal({ symbols: ['S32', 'S01', 'S17'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts the maximum of four symbols',
    envelope: envelope(
      symbolProposal({ symbols: ['S02', 'S02', 'S31', 'S31'] }),
    ),
    expect: 'accepted',
  },
  {
    name: 'accepts exactly maxSymbolRepeats consecutive repeats',
    envelope: envelope(symbolProposal({ symbols: ['S05', 'S05', 'S05'] })),
    expect: 'accepted',
  },

  // --- length and repetition (SPEC §9.1) ----------------------------------
  {
    name: 'rejects an empty symbol list',
    envelope: envelope(symbolProposal({ symbols: [] })),
    expect: 'empty-message',
  },
  {
    name: 'rejects five symbols against a cap of four',
    envelope: envelope(
      symbolProposal({ symbols: ['S01', 'S02', 'S03', 'S04', 'S05'] }),
    ),
    expect: 'message-too-long',
  },
  {
    name: 'rejects seventeen symbols, over the absolute ceiling of sixteen',
    envelope: envelope(
      symbolProposal({
        symbols: Array.from({ length: 17 }, (_, index) =>
          CONFORMANCE_INVENTORY[index % CONFORMANCE_INVENTORY.length] as string,
        ),
      }),
    ),
    expect: 'message-too-long',
  },
  {
    name: 'rejects four consecutive repeats of one symbol',
    envelope: envelope(
      symbolProposal({ symbols: ['S07', 'S07', 'S07', 'S07'] }),
    ),
    expect: 'symbol-repeat-limit',
  },

  // --- allowlist and free text (SPEC §9.1, resolves Q6) -------------------
  {
    name: 'rejects a well-formed symbol outside the declared inventory',
    envelope: envelope(symbolProposal({ symbols: ['S33'] })),
    expect: 'symbol-not-in-inventory',
  },
  {
    name: 'rejects a symbol with surrounding whitespace rather than trimming it',
    envelope: envelope(symbolProposal({ symbols: [' S01 '] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects prose in the symbol list',
    envelope: envelope(symbolProposal({ symbols: ['hello world'] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a URL in the symbol list',
    envelope: envelope(symbolProposal({ symbols: ['https://example.test/a'] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects Unicode look-alikes of an inventory symbol',
    envelope: envelope(symbolProposal({ symbols: ['Ｓ０１'] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects free text smuggled into an extra artifact field',
    envelope: envelope(
      symbolProposal({ symbols: ['S01'], note: 'please pick the red one' }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a non-string extra artifact field',
    envelope: envelope(symbolProposal({ symbols: ['S01'], strength: 3 })),
    expect: 'unexpected-artifact-field',
  },

  // --- trusted metadata (SPEC §11.3, ALD-035 criterion 1) -----------------
  {
    name: 'rejects Baby-supplied trusted metadata at the top level',
    envelope: envelope({
      kind: 'emit_symbols',
      publicArtifact: { symbols: ['S01'] },
      runId: 'run-forged',
    }),
    expect: 'trusted-metadata-present',
  },
  {
    name: 'rejects Baby-supplied trusted metadata nested in the artifact',
    envelope: envelope(
      symbolProposal({
        symbols: ['S01'],
        provenance: { previousHash: SENTINEL_HASH },
      }),
    ),
    expect: 'trusted-metadata-present',
  },
  {
    name: 'rejects a Baby-supplied sender identity',
    envelope: envelope({
      kind: 'emit_symbols',
      publicArtifact: { symbols: ['S01'] },
      sender: 'baby-b',
    }),
    expect: 'trusted-metadata-present',
  },

  // --- carrier routing (SPEC §9.6) ----------------------------------------
  {
    name: 'rejects a task action submitted on the channel',
    envelope: envelope({
      kind: 'select_object',
      publicArtifact: { objectRef: 'object-1' },
    }),
    expect: 'carrier-mismatch',
  },
  {
    name: 'rejects an unknown proposal kind',
    envelope: envelope(
      { kind: 'emit_prose', publicArtifact: { symbols: ['S01'] } },
    ),
    expect: 'carrier-mismatch',
  },

  // --- required intention draft (SPEC §8.1 step 2) ------------------------
  {
    name: 'rejects an interpretation draft where the intention belongs',
    envelope: envelope(
      symbolProposal({ symbols: ['S01'] }),
      conformanceIntentionDraft({ eventType: 'interpretation.recorded' }),
    ),
    expect: 'missing-intention',
  },
  {
    name: 'rejects an intention draft missing its required content field',
    envelope: envelope(
      symbolProposal({ symbols: ['S01'] }),
      conformanceIntentionDraft({ content: {} }),
    ),
    expect: 'missing-intention',
  },
  {
    name: 'rejects an unknown ledger event type',
    envelope: envelope(
      symbolProposal({ symbols: ['S01'] }),
      conformanceIntentionDraft({ eventType: 'intention.smuggled' }),
    ),
    expect: 'missing-intention',
  },

  // --- envelope frame (SPEC §11.3, ALD-035) -------------------------------
  {
    name: 'rejects an envelope with no private ledger draft',
    envelope: { proposal: symbolProposal({ symbols: ['S01'] }) },
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects an envelope with an extra top-level field',
    envelope: {
      proposal: symbolProposal({ symbols: ['S01'] }),
      privateLedgerDraft: conformanceIntentionDraft(),
      broadcast: true,
    },
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a non-object envelope',
    envelope: 'S01',
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a symbol list that is not an array',
    envelope: envelope(symbolProposal({ symbols: 'S01' })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a non-string symbol',
    envelope: envelope(symbolProposal({ symbols: [1] })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects an artifact with no symbols field',
    envelope: envelope(symbolProposal({})),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a proposal with no kind',
    envelope: envelope({ publicArtifact: { symbols: ['S01'] } }),
    expect: 'invalid-envelope',
  },
];

// ---------------------------------------------------------------------------
// Per-carrier vector registry (ALD-036 criterion 3)
// ---------------------------------------------------------------------------

const carrierVectors = new Map<
  RunConfig['carrierMode'],
  readonly ConformanceVector[]
>([['fixed-token', FIXED_TOKEN_VECTORS]]);

/**
 * Registers the vector set for one carrier. A module must contribute at least
 * one acceptance and one rejection vector, so a carrier cannot be declared
 * conformant on happy-path coverage alone.
 */
export function registerConformanceVectors(
  carrier: RunConfig['carrierMode'],
  vectors: readonly ConformanceVector[],
): void {
  if (!vectors.some((vector) => vector.expect === 'accepted')) {
    throw new Error(`${carrier} vectors must include at least one acceptance`);
  }
  if (!vectors.some((vector) => vector.expect !== 'accepted')) {
    throw new Error(`${carrier} vectors must include at least one rejection`);
  }
  carrierVectors.set(carrier, vectors);
}

export function conformanceVectorsFor(
  carrier: RunConfig['carrierMode'],
): readonly ConformanceVector[] | undefined {
  return carrierVectors.get(carrier);
}

/**
 * The EPIC-06 gate: every registered protocol module must contribute vectors
 * before the consolidated suite can be called green (ALD-036, ALD-078).
 */
export function assertEveryCarrierHasVectors(
  carriers: readonly RunConfig['carrierMode'][],
): void {
  const missing = carriers.filter((carrier) => !carrierVectors.has(carrier));
  if (missing.length > 0) {
    throw new Error(
      `Registered carrier module(s) contribute no conformance vectors: ${missing.join(', ')}`,
    );
  }
}

/** Test helper: drop every registration except the built-in fixed-token set. */
export function resetConformanceVectors(): void {
  carrierVectors.clear();
  carrierVectors.set('fixed-token', FIXED_TOKEN_VECTORS);
}
