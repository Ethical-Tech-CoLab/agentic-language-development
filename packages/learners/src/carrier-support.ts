/**
 * Carrier support for the reference learner tracks (ALD-031 learner half;
 * EXPERIMENT-NOTEBOOK.md E13 "Test whether agents invent both signal forms
 * and meanings").
 *
 * A learner adapter reasons over a discrete **form index**: "the thing I say
 * when I mean type code 7" is position `i` in its own form inventory. What
 * that index turns into on the wire is the carrier's business, and the five
 * SPECIFICATION.md §9.1/§9.2 carriers split into two kinds:
 *
 * - **Symbolic carriers** (`fixed-token`, `fixed-glyph`) declare an
 *   inventory. A form index is an index into it, a message is
 *   `messageLength` marks, and both Babies share the id space — so a
 *   received mark maps back to an index by lookup.
 * - **Generative carriers** (`generative-bitmap`, `generative-canvas`,
 *   `generative-tone`) declare no inventory at all (§9.2 gives them a
 *   grammar, not a vocabulary). Each Baby therefore **invents** its own form
 *   inventory at `init` from its private seed: `formCount` distinct valid
 *   artifacts, drawn once and never shared. A message is exactly one
 *   invented form. The Gateway sees only artifacts and never learns that an
 *   inventory exists; the receiving Baby recognises a delivered form only by
 *   an exact `markHash` match against its *own* inventory, and any other
 *   artifact is a novel form it has never produced.
 *
 * That asymmetry is the point of E13: with a generative carrier the two
 * Babies start with disjoint private form inventories and no shared id space,
 * so a convention can only arise if one Baby's forms become recognisable to
 * the other through use. Nothing here makes that happen or measures whether
 * it did — `markHash` reuse is what ALD-032's analysis counts.
 *
 * ### Why the bounds are restated here
 *
 * The §9.2 grammars are enforced by `@ald/gateway`'s carrier modules, which
 * this package deliberately does not import: a learner adapter runs inside
 * the Baby's isolation boundary and `@ald/gateway` pulls in the Evidence
 * Store and its native SQLite driver (the same reason `drafts.ts` restates
 * the LEDGER §5 event-type table). The constants below are therefore a second
 * copy, and `__tests__/carrier-support.test.ts` asserts they agree with
 * `@ald/gateway`'s exported bounds and that every artifact this module
 * generates is accepted by the real carrier module — so a drift is a test
 * failure, not a silent protocol violation.
 */
import {
  HASH_DOMAINS,
  type AgentActionProposal,
  type LearnerInitContext,
  type LearnerVisibleRunConfig,
  type RunConfig,
  type TurnBudget,
} from '@ald/types';
import { SeededPrng, hashCanonical, hashCarrierMark } from '@ald/hashing';

import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import type { ResolvedGameShape } from './game.js';

export type CarrierMode = RunConfig['carrierMode'];
export type CarrierEmitKind = Extract<
  AgentActionProposal['kind'],
  'emit_symbols' | 'emit_glyphs' | 'emit_bitmap' | 'emit_canvas' | 'emit_tones'
>;
export type CarrierArtifact = AgentActionProposal['publicArtifact'];

/** The emit tool each carrier offers (SPEC §6.3, §9.6: exactly one per run). */
export const CARRIER_EMIT_KIND: Readonly<Record<CarrierMode, CarrierEmitKind>> = {
  'fixed-token': 'emit_symbols',
  'fixed-glyph': 'emit_glyphs',
  'generative-bitmap': 'emit_bitmap',
  'generative-canvas': 'emit_canvas',
  'generative-tone': 'emit_tones',
};

// --- SPEC §9.1/§9.2 bounds (see the module header on why these are here) ---

/** SPEC §9.2 `generative-bitmap`: exactly 16 * 16 = 256 bits. */
export const BITMAP_BIT_COUNT = 256;
/** SPEC §9.2 `generative-canvas`: integer grid coordinates 0-15. */
export const CANVAS_GRID_MAX = 15;
/** SPEC §9.2 `generative-canvas`: default `maxStrokes`, absolute ceiling 64. */
export const DEFAULT_MAX_STROKES = 8;
export const ABSOLUTE_MAX_STROKES = 64;
/** SPEC §9.2 `generative-tone`: at most 8 tones, 8 pitch bins, 4 duration bins. */
export const MAX_TONES = 8;
export const TONE_PITCH_BINS = 8;
export const TONE_DURATION_BINS = 4;
/** SPEC §9.1/§9.2 default inventory size, shared by both symbolic carriers. */
export const DEFAULT_SYMBOL_INVENTORY_SIZE = 32;

/**
 * Implementation-defined hash domain for a Baby's whole form inventory. SPEC
 * §14.3 requires a run to replay from its seed, and an invented inventory is
 * part of what has to be reproducible; this hash is what the runtime records
 * so a third party can check the inventory it replays is the one that ran.
 * Defined centrally in `HASH_DOMAINS` so the evidence verifier and learner
 * boundary cannot silently disagree about the preimage domain.
 */
export const CARRIER_FORM_INVENTORY_DOMAIN = HASH_DOMAINS.carrierFormInventory;

/** Default number of forms a Baby invents for a generative carrier. */
export const DEFAULT_INVENTED_FORM_COUNT = 32;

/** Bounded attempts to draw a form distinct from every earlier one. */
const DISTINCT_FORM_ATTEMPTS = 64;

export interface CarrierSupportOptions {
  /**
   * How many distinct forms a Baby invents for a generative carrier.
   * Defaults to `RunConfig.symbolInventorySize` (then to 32), so a
   * generative condition has the same number of available forms as the
   * symbolic condition it is compared against (E13 runs "the same scenarios
   * across carrier conditions").
   */
  inventedFormCount?: number;
}

/** One mark of a delivered artifact, as the receiving Baby sees it. */
export interface DeliveredMark {
  /**
   * Index into *this* Baby's own form inventory, or `null` for a form it has
   * never produced. Symbolic carriers resolve every in-inventory mark;
   * generative carriers resolve only an exact `markHash` match.
   */
  formIndex: number | null;
  /** Opaque label: the inventory id, or a content-derived label for a novel form. */
  formId: string;
  /** SPEC §9.2 content address of this single mark. */
  markHash: string;
}

export interface DeliveredForms {
  /** One entry per mark, in delivery order. */
  marks: DeliveredMark[];
  /** `markHash` of the delivered artifact as a whole. */
  artifactMarkHash: string;
}

export interface CarrierAdapterSupport {
  readonly carrier: CarrierMode;
  readonly emitKind: CarrierEmitKind;
  /** `true` for the two carriers that declare an inventory (SPEC §9.1, §9.2). */
  readonly symbolic: boolean;
  /** Number of forms this Baby can choose between. */
  readonly formCount: number;
  /** Marks per message: `messageLength` for symbolic carriers, `1` otherwise. */
  readonly marksPerMessage: number;
  /** Domain-separated hash of the whole form inventory (SPEC §14.3 replay). */
  readonly formInventoryHash: string;
  /** Opaque label for one of this Baby's forms. */
  formId(index: number): string;
  /** SPEC §9.2 content address of one of this Baby's forms. */
  formMarkHash(index: number): string;
  /** The public artifact for a message of exactly `marksPerMessage` forms. */
  artifactForForms(indices: readonly number[]): CarrierArtifact;
  /** SPEC §9.2 content address of a whole artifact. */
  markHashOf(artifact: unknown): string;
  /** Resolve a delivered artifact against this Baby's own inventory. */
  parseDelivery(artifact: unknown): DeliveredForms;
}

/** SPEC §9.1 default fixed-token inventory, restated (see the module header). */
function symbolIds(size: number, prefix: 'S' | 'G'): string[] {
  const width = size >= 100 ? 3 : 2;
  return Array.from(
    { length: size },
    (_, index) => `${prefix}${String(index + 1).padStart(width, '0')}`,
  );
}

function maxStrokesFor(config: Pick<LearnerVisibleRunConfig, 'maxStrokes'>): number {
  return Math.min(config.maxStrokes ?? DEFAULT_MAX_STROKES, ABSOLUTE_MAX_STROKES);
}

/** A content-derived opaque label for a generative form: `m` plus 8 hex. */
function formLabel(markHash: string): string {
  return `m${markHash.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`Form index ${index} is outside the inventory`);
  }
  return value;
}

/**
 * SPEC §6.3: a Baby may act only through the tools it is offered this turn.
 * The generalization of `game.ts`'s `requireAction` over all five §9.2 emit
 * tools plus the task tools.
 */
export function requireCarrierAction(
  turnBudget: TurnBudget,
  kind: CarrierEmitKind | 'select_object',
): void {
  if (!turnBudget.availableActions.includes(kind)) {
    throw new LearnerStateError(
      `Action ${kind} is not available on turn ${turnBudget.turn}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generative form generators (SPEC §9.2 grammars)
// ---------------------------------------------------------------------------

function drawBitmap(prng: SeededPrng): CarrierArtifact {
  const bits = Array.from({ length: BITMAP_BIT_COUNT }, () =>
    prng.nextInt(2) === 1 ? 1 : (0 as 0 | 1),
  );
  return { bitmap: { bits } };
}

function drawCanvas(prng: SeededPrng, maxStrokes: number): CarrierArtifact {
  const count = 1 + prng.nextInt(maxStrokes);
  const strokes = Array.from({ length: count }, () => ({
    startX: prng.nextInt(CANVAS_GRID_MAX + 1),
    startY: prng.nextInt(CANVAS_GRID_MAX + 1),
    endX: prng.nextInt(CANVAS_GRID_MAX + 1),
    endY: prng.nextInt(CANVAS_GRID_MAX + 1),
    width: (prng.nextInt(3) + 1) as 1 | 2 | 3,
  }));
  return { strokes };
}

function drawTones(prng: SeededPrng): CarrierArtifact {
  const count = 1 + prng.nextInt(MAX_TONES);
  const tones = Array.from({ length: count }, () => ({
    pitchBin: prng.nextInt(TONE_PITCH_BINS),
    durationBin: 1 + prng.nextInt(TONE_DURATION_BINS),
  }));
  return { tones: { tones } };
}

/**
 * The Baby's invented form inventory: `formCount` distinct valid artifacts
 * drawn from a labelled child of its private seed.
 *
 * Distinctness is by `markHash`, resampled from a further-derived stream, so
 * the inventory is a set of genuinely different forms rather than a bag that
 * might contain the same drawing twice — otherwise two form indices would be
 * indistinguishable on the wire and the policy would be learning over a
 * degenerate action space.
 */
function inventForms(
  carrier: CarrierMode,
  seed: string,
  formCount: number,
  config: Pick<LearnerVisibleRunConfig, 'maxStrokes'>,
): CarrierArtifact[] {
  const root = new SeededPrng(seed).derive(`carrier/${carrier}/forms`);
  const maxStrokes = maxStrokesFor(config);
  const draw = (prng: SeededPrng): CarrierArtifact => {
    switch (carrier) {
      case 'generative-bitmap':
        return drawBitmap(prng);
      case 'generative-canvas':
        return drawCanvas(prng, maxStrokes);
      case 'generative-tone':
        return drawTones(prng);
      case 'fixed-token':
      case 'fixed-glyph':
        throw new LearnerConfigurationError(
          `${carrier} declares an inventory and invents no forms`,
        );
    }
  };

  const forms: CarrierArtifact[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < formCount; index += 1) {
    let accepted: CarrierArtifact | undefined;
    for (
      let attempt = 0;
      attempt < DISTINCT_FORM_ATTEMPTS && accepted === undefined;
      attempt += 1
    ) {
      const candidate = draw(
        root.derive(`${String(index)}/${String(attempt)}`),
      );
      const markHash = hashCarrierMark(carrier, candidate);
      if (!seen.has(markHash)) {
        seen.add(markHash);
        accepted = candidate;
      }
    }
    if (accepted === undefined) {
      throw new LearnerConfigurationError(
        `Could not invent ${formCount} distinct ${carrier} forms from this seed`,
      );
    }
    forms.push(accepted);
  }
  return forms;
}

// ---------------------------------------------------------------------------
// Artifact reading (the mirror of the Gateway's normalization)
// ---------------------------------------------------------------------------

function readMarkList(artifact: unknown, field: 'symbols' | 'glyphs'): string[] {
  const marks = (artifact as Record<string, unknown> | null)?.[field];
  if (
    !Array.isArray(marks) ||
    marks.length === 0 ||
    marks.some((mark) => typeof mark !== 'string' || mark.length === 0)
  ) {
    throw new LearnerStateError(
      `A delivered artifact must carry a non-empty ${field} array`,
    );
  }
  return marks as string[];
}

class CarrierAdapterSupportImpl implements CarrierAdapterSupport {
  readonly emitKind: CarrierEmitKind;
  readonly symbolic: boolean;
  readonly formCount: number;
  readonly marksPerMessage: number;
  readonly formInventoryHash: string;

  private readonly ids: string[];
  private readonly artifacts: CarrierArtifact[];
  private readonly markHashes: string[];
  private readonly indexByMarkHash: Map<string, number>;

  constructor(
    readonly carrier: CarrierMode,
    context: LearnerInitContext,
    shape: ResolvedGameShape,
    options: CarrierSupportOptions,
  ) {
    this.emitKind = CARRIER_EMIT_KIND[carrier];
    this.symbolic = carrier === 'fixed-token' || carrier === 'fixed-glyph';

    if (this.symbolic) {
      // `fixed-token` uses the inventory the runtime declared, verbatim, so
      // this track's behaviour on the default carrier is unchanged. A glyph
      // run's inventory is derived, because the runtime currently fills
      // `symbolInventory` with fixed-token ids for every carrier.
      const ids =
        carrier === 'fixed-token'
          ? [...context.symbolInventory]
          : symbolIds(
              context.config.symbolInventorySize ??
                DEFAULT_SYMBOL_INVENTORY_SIZE,
              'G',
            );
      if (ids.length === 0) {
        throw new LearnerConfigurationError('symbolInventory must not be empty');
      }
      this.ids = ids;
      this.artifacts = ids.map((id) => this.markArtifact(id));
      this.marksPerMessage = shape.messageLength;
    } else {
      if (shape.messageLength !== 1) {
        throw new LearnerConfigurationError(
          `carrier ${carrier} carries one invented form per message, so messageLength must be 1 (got ${shape.messageLength})`,
        );
      }
      const formCount =
        options.inventedFormCount ??
        context.config.symbolInventorySize ??
        DEFAULT_INVENTED_FORM_COUNT;
      if (!Number.isInteger(formCount) || formCount < 2) {
        throw new LearnerConfigurationError(
          'inventedFormCount must be an integer of at least 2',
        );
      }
      this.artifacts = inventForms(
        carrier,
        context.seed,
        formCount,
        context.config,
      );
      this.ids = this.artifacts.map((artifact) =>
        formLabel(hashCarrierMark(carrier, artifact)),
      );
      this.marksPerMessage = 1;
    }

    this.markHashes = this.artifacts.map((artifact) =>
      hashCarrierMark(carrier, artifact),
    );
    this.formCount = this.artifacts.length;
    this.indexByMarkHash = new Map(
      this.markHashes.map((markHash, index) => [markHash, index]),
    );
    this.formInventoryHash = hashCanonical(CARRIER_FORM_INVENTORY_DOMAIN, {
      carrier,
      formCount: this.formCount,
      marksPerMessage: this.marksPerMessage,
      markHashes: [...this.markHashes],
    });
  }

  formId(index: number): string {
    return at(this.ids, index);
  }

  formMarkHash(index: number): string {
    return at(this.markHashes, index);
  }

  artifactForForms(indices: readonly number[]): CarrierArtifact {
    if (indices.length !== this.marksPerMessage) {
      throw new LearnerStateError(
        `A ${this.carrier} message carries exactly ${this.marksPerMessage} mark(s), got ${indices.length}`,
      );
    }
    if (this.symbolic) {
      const marks = indices.map((index) => at(this.ids, index));
      return this.carrier === 'fixed-token'
        ? { symbols: marks }
        : { glyphs: marks };
    }
    return at(this.artifacts, indices[0] as number);
  }

  markHashOf(artifact: unknown): string {
    return hashCarrierMark(this.carrier, artifact);
  }

  parseDelivery(artifact: unknown): DeliveredForms {
    const artifactMarkHash = this.markHashOf(artifact);
    if (!this.symbolic) {
      const formIndex = this.indexByMarkHash.get(artifactMarkHash) ?? null;
      return {
        marks: [
          {
            formIndex,
            formId:
              formIndex === null
                ? formLabel(artifactMarkHash)
                : at(this.ids, formIndex),
            markHash: artifactMarkHash,
          },
        ],
        artifactMarkHash,
      };
    }

    const field = this.carrier === 'fixed-token' ? 'symbols' : 'glyphs';
    const marks = readMarkList(artifact, field);
    const idIndex = new Map(this.ids.map((id, index) => [id, index]));
    return {
      marks: marks.map((mark) => ({
        formIndex: idIndex.get(mark) ?? null,
        formId: mark,
        markHash: hashCarrierMark(this.carrier, this.markArtifact(mark)),
      })),
      artifactMarkHash,
    };
  }

  /** The single-mark artifact a symbolic carrier's `markHash` is taken over. */
  private markArtifact(mark: string): CarrierArtifact {
    return this.carrier === 'fixed-token' ? { symbols: [mark] } : { glyphs: [mark] };
  }
}

/**
 * Build the carrier support for one adapter at `init`.
 *
 * The generative branch draws this Baby's form inventory from
 * `LearnerInitContext.seed`, which is the private per-Baby seed the runtime
 * derives and never shares (SPEC §11.1: `randomSeed` is withheld from the
 * learner precisely so a Baby cannot regenerate the other's private stream).
 * Two Babies in one run therefore invent different inventories, which is the
 * E13 starting condition.
 */
export function createCarrierSupport(
  context: LearnerInitContext,
  shape: ResolvedGameShape,
  options: CarrierSupportOptions = {},
): CarrierAdapterSupport {
  return new CarrierAdapterSupportImpl(
    context.config.carrierMode,
    context,
    shape,
    options,
  );
}

// ---------------------------------------------------------------------------
// Proposal and ledger-draft helpers shared by the reference tracks
// ---------------------------------------------------------------------------

/**
 * The SPEC §11.3 proposal for a message of form indices.
 *
 * The cast is unavoidable and is load-bearing only in the type system:
 * `AgentActionProposal` is a discriminated union over `kind`, and the pairing
 * "this `kind` goes with this artifact shape" is decided at run time by
 * `support.carrier`, which no union member can express. The pairing itself is
 * enforced structurally — `CARRIER_EMIT_KIND` and `artifactForForms` are
 * keyed by the same `carrier` — and checked against the real Gateway modules
 * in `__tests__/carrier-support.test.ts`, so a mismatch is a test failure
 * rather than a rejected turn.
 */
export function carrierProposal(
  support: CarrierAdapterSupport,
  indices: readonly number[],
): AgentActionProposal {
  return {
    kind: support.emitKind,
    publicArtifact: support.artifactForForms(indices),
  } as AgentActionProposal;
}

/**
 * `subjectId` for a ledger event about one mark (SPEC §11.4).
 *
 * `fixed-token` keeps the `symbol:<id>` form the reference tracks have always
 * written, so an existing E00-E03 ledger is unchanged; every other carrier
 * uses `form:<label>`, where the label is the inventory id for a symbolic
 * carrier and a content-derived `m<8 hex>` for an invented form. None of them
 * is a gloss: they are opaque references (SPEC §11.4, CONCEPT-IDEA.md §20.6).
 */
export function subjectIdFor(
  support: CarrierAdapterSupport,
  mark: DeliveredMark,
): string {
  return support.carrier === 'fixed-token'
    ? `symbol:${mark.formId}`
    : `form:${mark.formId}`;
}

/**
 * The message fields of an `intention.recorded` / `interpretation.recorded`
 * content object.
 *
 * `fixed-token` records `symbols` exactly as before. Every other carrier
 * records `marks` (the opaque labels, in delivery order) and `formHashes`
 * (the §9.2 `markHash` of each mark) — the hashes are what makes form reuse
 * recognisable to ALD-032's analysis without anything in the ledger naming a
 * meaning.
 */
export function messageFields(
  support: CarrierAdapterSupport,
  marks: readonly DeliveredMark[],
): Record<string, unknown> {
  if (support.carrier === 'fixed-token') {
    return { symbols: marks.map((mark) => mark.formId) };
  }
  return {
    marks: marks.map((mark) => mark.formId),
    formHashes: marks.map((mark) => mark.markHash),
  };
}

/**
 * The `termRef` (and, off the default carrier, `formHash`) of a
 * `term.first_emitted` / `term.first_received` event. LEDGER §5 requires a
 * non-empty `termRef`; on a generative carrier the only stable, meaning-free
 * name a form has is its `markHash`, so that is what the reference is.
 */
export function termFields(
  support: CarrierAdapterSupport,
  mark: DeliveredMark,
): Record<string, unknown> {
  if (support.carrier === 'fixed-token') {
    return { termRef: `symbol:${mark.formId}` };
  }
  return { termRef: mark.markHash, formId: mark.formId, formHash: mark.markHash };
}

/**
 * The hypothesis reference for one mark (CONCEPT-IDEA.md §11.2 rule 3).
 * `hyp:S01:2` on the default carrier, `hyp:G01:2` / `hyp:m1a2b3c4d:2`
 * elsewhere — an opaque reference in every case.
 */
export function hypothesisRefFor(
  support: CarrierAdapterSupport,
  formId: string,
  version: number,
): string {
  return `hyp:${formId}:${String(version)}`;
}

/**
 * The key an adapter's private registries use for one mark.
 *
 * A symbolic carrier keys by its inventory id, so a `fixed-token` run's
 * exported registries — and therefore its policy-checkpoint hash — are
 * exactly what they were before ALD-031. A generative carrier keys by the
 * full `markHash`: its `formId` is only the first 32 bits of that hash, which
 * is plenty for a ledger label but not something a registry should rely on
 * being collision-free.
 */
export function markKey(
  support: CarrierAdapterSupport,
  mark: DeliveredMark,
): string {
  return support.symbolic ? mark.formId : mark.markHash;
}
