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

/**
 * A value nested `depth` array levels deep, for exercising the SPEC §9.4
 * complexity budget (default `maxDepth` of 32; see inspect.ts).
 */
function deeplyNested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
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

  // --- complexity budget (SPEC §9.4) --------------------------------------
  {
    name: 'rejects a public artifact nested past the complexity budget',
    envelope: envelope(symbolProposal({ symbols: [deeplyNested(50)] })),
    expect: 'payload-too-complex',
  },
  {
    name: 'rejects a private ledger draft nested past the complexity budget',
    envelope: envelope(
      symbolProposal({ symbols: ['S01'] }),
      conformanceIntentionDraft({ content: deeplyNested(50) }),
    ),
    expect: 'payload-too-complex',
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

// ---------------------------------------------------------------------------
// SPEC §9.2 alternate-carrier vectors (ALD-031 criterion 3, ALD-036)
// ---------------------------------------------------------------------------
//
// One array per §9.2 carrier, in the same shape as `FIXED_TOKEN_VECTORS` and
// exercised by the same driver. They are registered by
// `registerAlternateCarriers()` (`carriers/register.ts`) rather than at module
// load, because SPEC §9.2 makes an alternate carrier "an explicit experiment
// condition, never the default": a build that has not opted into the
// alternate carriers has no module registered for them either, and
// `assertEveryCarrierHasVectors(registeredCarriers())` must stay satisfiable
// in both states.
//
// Every vector below is written against `CONFORMANCE_MAX_SYMBOLS` (4),
// `CONFORMANCE_MAX_SYMBOL_REPEATS` (3) and the §9.2 defaults: a 32-mark glyph
// inventory, exactly 256 bitmap bits, 8 strokes, 8 tones.

/** SPEC §9.2 default `fixed-glyph` inventory the glyph vectors assume. */
export const CONFORMANCE_GLYPH_INVENTORY: readonly string[] = Array.from(
  { length: 32 },
  (_, index) => `G${String(index + 1).padStart(2, '0')}`,
);

/** Exactly 256 bits, the §9.2 `generative-bitmap` grid. */
function bits(fill: (index: number) => 0 | 1, count = 256): (0 | 1)[] {
  return Array.from({ length: count }, (_, index) => fill(index));
}

function stroke(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { startX: 1, startY: 2, endX: 13, endY: 14, width: 1, ...overrides };
}

function tone(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { pitchBin: 3, durationBin: 2, ...overrides };
}

function glyphProposal(publicArtifact: unknown): unknown {
  return { kind: 'emit_glyphs', publicArtifact };
}

function bitmapProposal(publicArtifact: unknown): unknown {
  return { kind: 'emit_bitmap', publicArtifact };
}

function canvasProposal(publicArtifact: unknown): unknown {
  return { kind: 'emit_canvas', publicArtifact };
}

function toneProposal(publicArtifact: unknown): unknown {
  return { kind: 'emit_tones', publicArtifact };
}

export const FIXED_GLYPH_VECTORS: readonly ConformanceVector[] = [
  // --- acceptance (ALD-031 criterion 1) -----------------------------------
  {
    name: 'accepts one inventory glyph',
    envelope: envelope(glyphProposal({ glyphs: ['G01'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts three inventory glyphs',
    envelope: envelope(glyphProposal({ glyphs: ['G32', 'G01', 'G17'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts the maximum of four glyphs',
    envelope: envelope(glyphProposal({ glyphs: ['G02', 'G02', 'G31', 'G31'] })),
    expect: 'accepted',
  },
  {
    name: 'accepts exactly maxSymbolRepeats consecutive repeats',
    envelope: envelope(glyphProposal({ glyphs: ['G05', 'G05', 'G05'] })),
    expect: 'accepted',
  },

  // --- length and repetition (SPEC §9.1 rules, §9.2 "same repeat rule") ---
  {
    name: 'rejects an empty glyph list',
    envelope: envelope(glyphProposal({ glyphs: [] })),
    expect: 'empty-message',
  },
  {
    name: 'rejects five glyphs against a cap of four',
    envelope: envelope(
      glyphProposal({ glyphs: ['G01', 'G02', 'G03', 'G04', 'G05'] }),
    ),
    expect: 'message-too-long',
  },
  {
    name: 'rejects four consecutive repeats of one glyph',
    envelope: envelope(
      glyphProposal({ glyphs: ['G07', 'G07', 'G07', 'G07'] }),
    ),
    expect: 'symbol-repeat-limit',
  },

  // --- allowlist and free text (SPEC §9.2) --------------------------------
  {
    name: 'rejects a well-formed glyph id outside the frozen bundle',
    envelope: envelope(glyphProposal({ glyphs: ['G33'] })),
    expect: 'glyph-not-in-inventory',
  },
  {
    name: 'rejects a fixed-token symbol submitted as a glyph id',
    envelope: envelope(glyphProposal({ glyphs: ['S01'] })),
    expect: 'glyph-not-in-inventory',
  },
  {
    name: 'rejects a glyph id with surrounding whitespace rather than trimming it',
    envelope: envelope(glyphProposal({ glyphs: [' G01 '] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects prose in the glyph list',
    envelope: envelope(glyphProposal({ glyphs: ['a small red circle'] })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a semantic tag smuggled into an extra artifact field',
    envelope: envelope(
      glyphProposal({ glyphs: ['G01'], meaning: 'the round one' }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a non-string extra artifact field',
    envelope: envelope(glyphProposal({ glyphs: ['G01'], strength: 3 })),
    expect: 'unexpected-artifact-field',
  },

  // --- envelope frame and routing ----------------------------------------
  {
    name: 'rejects a non-string glyph id',
    envelope: envelope(glyphProposal({ glyphs: [1] })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a glyph list that is not an array',
    envelope: envelope(glyphProposal({ glyphs: 'G01' })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects an artifact with no glyphs field',
    envelope: envelope(glyphProposal({})),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a fixed-token proposal on a glyph run',
    envelope: envelope({
      kind: 'emit_symbols',
      publicArtifact: { symbols: ['S01'] },
    }),
    expect: 'carrier-mismatch',
  },
  {
    name: 'rejects Baby-supplied trusted metadata on a glyph proposal',
    envelope: envelope({
      kind: 'emit_glyphs',
      publicArtifact: { glyphs: ['G01'] },
      runId: 'run-forged',
    }),
    expect: 'trusted-metadata-present',
  },
  {
    name: 'rejects a glyph proposal with no intention draft',
    envelope: envelope(
      glyphProposal({ glyphs: ['G01'] }),
      conformanceIntentionDraft({ eventType: 'interpretation.recorded' }),
    ),
    expect: 'missing-intention',
  },
];

export const GENERATIVE_BITMAP_VECTORS: readonly ConformanceVector[] = [
  // --- acceptance (ALD-031 criterion 1) -----------------------------------
  {
    name: 'accepts the all-zero 256-bit matrix',
    envelope: envelope(bitmapProposal({ bitmap: { bits: bits(() => 0) } })),
    expect: 'accepted',
  },
  {
    name: 'accepts the all-one 256-bit matrix',
    envelope: envelope(bitmapProposal({ bitmap: { bits: bits(() => 1) } })),
    expect: 'accepted',
  },
  {
    name: 'accepts an alternating 256-bit matrix',
    envelope: envelope(
      bitmapProposal({
        bitmap: { bits: bits((index) => (index % 2 === 0 ? 1 : 0)) },
      }),
    ),
    expect: 'accepted',
  },

  // --- exact grid size (SPEC §9.2 "256 bits") -----------------------------
  {
    name: 'rejects a 255-bit matrix',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0, 255) } }),
    ),
    expect: 'bitmap-size-invalid',
  },
  {
    name: 'rejects a 257-bit matrix',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0, 257) } }),
    ),
    expect: 'bitmap-size-invalid',
  },
  {
    name: 'rejects an empty bit matrix',
    envelope: envelope(bitmapProposal({ bitmap: { bits: [] } })),
    expect: 'bitmap-size-invalid',
  },

  // --- cell values --------------------------------------------------------
  {
    name: 'rejects a cell value of 2',
    envelope: envelope(
      bitmapProposal({
        bitmap: { bits: bits((index) => (index === 5 ? (2 as 0 | 1) : 0)) },
      }),
    ),
    expect: 'bitmap-value-invalid',
  },
  {
    name: 'rejects a fractional cell value',
    envelope: envelope(
      bitmapProposal({
        bitmap: { bits: bits((index) => (index === 0 ? (0.5 as 0 | 1) : 0)) },
      }),
    ),
    expect: 'bitmap-value-invalid',
  },
  {
    name: 'rejects a string cell as free text, not as a value error',
    envelope: envelope(
      bitmapProposal({
        bitmap: {
          bits: bits((index) => (index === 3 ? ('1' as unknown as 0 | 1) : 0)),
        },
      }),
    ),
    expect: 'free-text-present',
  },

  // --- no color or text field (SPEC §9.2) ---------------------------------
  {
    name: 'rejects a color field beside the bitmap',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0) }, color: '#ff0000' }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a caption nested inside the bitmap',
    envelope: envelope(
      bitmapProposal({
        bitmap: { bits: bits(() => 0), caption: 'the tall one' },
      }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a numeric grid override nested inside the bitmap',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0), gridWidth: 16 } }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects an explicit bitmap width side feature',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0) }, width: 16 }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects an explicit bitmap height side feature',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0) }, height: 16 }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects a bitmap compression side feature',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0) }, compression: 'rle' }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a bitmap container side feature',
    envelope: envelope(
      bitmapProposal({ bitmap: { bits: bits(() => 0) }, container: 'png' }),
    ),
    expect: 'free-text-present',
  },

  // --- envelope frame and routing ----------------------------------------
  {
    name: 'rejects a bitmap that is not an object',
    envelope: envelope(bitmapProposal({ bitmap: [0, 1] })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a bits field that is not an array',
    envelope: envelope(bitmapProposal({ bitmap: { bits: 256 } })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a canvas proposal on a bitmap run',
    envelope: envelope(canvasProposal({ strokes: [stroke()] })),
    expect: 'carrier-mismatch',
  },
];

export const GENERATIVE_CANVAS_VECTORS: readonly ConformanceVector[] = [
  // --- acceptance (ALD-031 criterion 1) -----------------------------------
  {
    name: 'accepts one stroke',
    envelope: envelope(canvasProposal({ strokes: [stroke()] })),
    expect: 'accepted',
  },
  {
    name: 'accepts the default maximum of eight strokes',
    envelope: envelope(
      canvasProposal({
        strokes: Array.from({ length: 8 }, (_, index) =>
          stroke({ startX: index, endX: 15 - index }),
        ),
      }),
    ),
    expect: 'accepted',
  },
  {
    name: 'accepts a degenerate zero-length stroke as a dot',
    envelope: envelope(
      canvasProposal({
        strokes: [{ startX: 4, startY: 4, endX: 4, endY: 4, width: 2 }],
      }),
    ),
    expect: 'accepted',
  },
  {
    name: 'accepts all three quantized pen widths',
    envelope: envelope(
      canvasProposal({
        strokes: [stroke({ width: 1 }), stroke({ width: 2 }), stroke({ width: 3 })],
      }),
    ),
    expect: 'accepted',
  },
  {
    name: 'accepts strokes at both grid extremes',
    envelope: envelope(
      canvasProposal({
        strokes: [{ startX: 0, startY: 0, endX: 15, endY: 15, width: 3 }],
      }),
    ),
    expect: 'accepted',
  },

  // --- stroke count (SPEC §9.2 maxStrokes) --------------------------------
  {
    name: 'rejects an empty stroke list',
    envelope: envelope(canvasProposal({ strokes: [] })),
    expect: 'empty-message',
  },
  {
    name: 'rejects nine strokes against a cap of eight',
    envelope: envelope(
      canvasProposal({ strokes: Array.from({ length: 9 }, () => stroke()) }),
    ),
    expect: 'too-many-strokes',
  },

  // --- coordinate and width bounds ----------------------------------------
  {
    name: 'rejects a stroke past the right edge of the grid',
    envelope: envelope(canvasProposal({ strokes: [stroke({ endX: 16 })] })),
    expect: 'stroke-out-of-range',
  },
  {
    name: 'rejects a negative stroke coordinate',
    envelope: envelope(canvasProposal({ strokes: [stroke({ startY: -1 })] })),
    expect: 'stroke-out-of-range',
  },
  {
    name: 'rejects a fractional stroke coordinate',
    envelope: envelope(canvasProposal({ strokes: [stroke({ startX: 1.5 })] })),
    expect: 'stroke-out-of-range',
  },
  {
    name: 'rejects a pen width of four',
    envelope: envelope(canvasProposal({ strokes: [stroke({ width: 4 })] })),
    expect: 'stroke-width-invalid',
  },
  {
    name: 'rejects a pen width of zero',
    envelope: envelope(canvasProposal({ strokes: [stroke({ width: 0 })] })),
    expect: 'stroke-width-invalid',
  },

  // --- no color or text field (SPEC §9.2) ---------------------------------
  {
    name: 'rejects a per-stroke color field',
    envelope: envelope(
      canvasProposal({ strokes: [stroke({ color: '#00ff00' })] }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a per-stroke semantic tag',
    envelope: envelope(
      canvasProposal({ strokes: [stroke({ label: 'the square one' })] }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a per-stroke numeric extra field',
    envelope: envelope(
      canvasProposal({ strokes: [stroke({ pressure: 2 })] }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects an explicit canvas width side feature',
    envelope: envelope(canvasProposal({ strokes: [stroke()], canvasWidth: 16 })),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects an explicit canvas height side feature',
    envelope: envelope(canvasProposal({ strokes: [stroke()], canvasHeight: 16 })),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects a canvas compression side feature',
    envelope: envelope(canvasProposal({ strokes: [stroke()], compression: 'svgz' })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a canvas container side feature',
    envelope: envelope(canvasProposal({ strokes: [stroke()], container: 'svg' })),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a string pen width as free text',
    envelope: envelope(canvasProposal({ strokes: [stroke({ width: '1' })] })),
    expect: 'free-text-present',
  },

  // --- envelope frame and routing ----------------------------------------
  {
    name: 'rejects a stroke list that is not an array',
    envelope: envelope(canvasProposal({ strokes: stroke() })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a stroke that is not an object',
    envelope: envelope(canvasProposal({ strokes: [[0, 0, 1, 1, 1]] })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a tone proposal on a canvas run',
    envelope: envelope(toneProposal({ tones: { tones: [tone()] } })),
    expect: 'carrier-mismatch',
  },
];

export const GENERATIVE_TONE_VECTORS: readonly ConformanceVector[] = [
  // --- acceptance (ALD-031 criterion 1) -----------------------------------
  {
    name: 'accepts one tone',
    envelope: envelope(toneProposal({ tones: { tones: [tone()] } })),
    expect: 'accepted',
  },
  {
    name: 'accepts the maximum of eight tones',
    envelope: envelope(
      toneProposal({
        tones: {
          tones: Array.from({ length: 8 }, (_, index) =>
            tone({ pitchBin: index }),
          ),
        },
      }),
    ),
    expect: 'accepted',
  },
  {
    name: 'accepts both bin extremes',
    envelope: envelope(
      toneProposal({
        tones: {
          tones: [
            { pitchBin: 0, durationBin: 1 },
            { pitchBin: 7, durationBin: 4 },
          ],
        },
      }),
    ),
    expect: 'accepted',
  },

  // --- sequence length (SPEC §9.2 "8 tones") ------------------------------
  {
    name: 'rejects an empty tone sequence',
    envelope: envelope(toneProposal({ tones: { tones: [] } })),
    expect: 'empty-message',
  },
  {
    name: 'rejects nine tones against a cap of eight',
    envelope: envelope(
      toneProposal({
        tones: { tones: Array.from({ length: 9 }, () => tone()) },
      }),
    ),
    expect: 'too-many-tones',
  },

  // --- bin bounds ---------------------------------------------------------
  {
    name: 'rejects a ninth pitch bin',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ pitchBin: 8 })] } }),
    ),
    expect: 'tone-out-of-range',
  },
  {
    name: 'rejects a negative pitch bin',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ pitchBin: -1 })] } }),
    ),
    expect: 'tone-out-of-range',
  },
  {
    name: 'rejects a zero duration bin',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ durationBin: 0 })] } }),
    ),
    expect: 'tone-out-of-range',
  },
  {
    name: 'rejects a fifth duration bin',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ durationBin: 5 })] } }),
    ),
    expect: 'tone-out-of-range',
  },

  // --- no text field, no raw audio (SPEC §9.2) ----------------------------
  {
    name: 'rejects a note name beside the quantized bins',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ noteName: 'C4' })] } }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a base64 audio payload smuggled beside the sequence',
    envelope: envelope(
      toneProposal({
        tones: { tones: [tone()] },
        sample: 'UklGRiQAAABXQVZF',
      }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a numeric tempo field beside the sequence',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone()] }, tempo: 120 }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects a per-tone numeric extra field',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone({ velocity: 5 })] } }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects a tone sample-rate side feature',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone()] }, sampleRate: 48_000 }),
    ),
    expect: 'unexpected-artifact-field',
  },
  {
    name: 'rejects a tone compression side feature',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone()] }, compression: 'flac' }),
    ),
    expect: 'free-text-present',
  },
  {
    name: 'rejects a tone container side feature',
    envelope: envelope(
      toneProposal({ tones: { tones: [tone()] }, container: 'wav' }),
    ),
    expect: 'free-text-present',
  },

  // --- envelope frame and routing ----------------------------------------
  {
    name: 'rejects a tone sequence that is not an array',
    envelope: envelope(toneProposal({ tones: { tones: tone() } })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a tone that is not an object',
    envelope: envelope(toneProposal({ tones: { tones: [[3, 2]] } })),
    expect: 'invalid-envelope',
  },
  {
    name: 'rejects a glyph proposal on a tone run',
    envelope: envelope(glyphProposal({ glyphs: ['G01'] })),
    expect: 'carrier-mismatch',
  },
];

/**
 * Vector set per §9.2 alternate carrier, keyed exactly as `carrierMode` is.
 * `registerAlternateCarriers()` feeds this map into
 * `registerConformanceVectors`, so ALD-036's
 * `assertEveryCarrierHasVectors(registeredCarriers())` covers all five
 * carriers once a run has opted into the alternate ones (ALD-031 criterion 3).
 */
export const ALTERNATE_CARRIER_VECTORS: ReadonlyMap<
  RunConfig['carrierMode'],
  readonly ConformanceVector[]
> = new Map([
  ['fixed-glyph', FIXED_GLYPH_VECTORS],
  ['generative-bitmap', GENERATIVE_BITMAP_VECTORS],
  ['generative-canvas', GENERATIVE_CANVAS_VECTORS],
  ['generative-tone', GENERATIVE_TONE_VECTORS],
] as const);
