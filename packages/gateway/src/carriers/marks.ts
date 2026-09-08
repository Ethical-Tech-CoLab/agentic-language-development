/**
 * Shared validation steps every SPECIFICATION.md §9.2 carrier module runs
 * before it looks at its own grammar (ALD-031, ALD-034 criterion 3).
 *
 * These are the checks that must be *identical* across carriers, because the
 * §9.4 rejection framework and the §11.3 envelope rules are carrier-
 * independent: a proposal holds exactly `kind` and `publicArtifact`, an
 * artifact holds exactly the fields its carrier defines, an extra field
 * holding a string anywhere is free text, and a mark list is bounded in
 * length and in consecutive repeats.
 *
 * Everything here operates on the *raw* proposal. `z.object()` strips unknown
 * keys on `.parse()`, so a check that ran after parsing could not see a
 * smuggled `color`, `label`, or `runId` field at all (SPEC §11.3).
 */
import {
  extraFieldFailure,
  fail,
  maxSymbolsFor,
  trailingRepeats,
  BARE_TOKEN_PATTERN,
  type CarrierContext,
  type CarrierValidationResult,
} from '../carrier-modules.js';
import { containsString, isPlainObject } from '../inspect.js';
import type { GatewayReasonCode } from '../reason-codes.js';

/**
 * `free-text-present` when a string appears anywhere inside `value`,
 * `undefined` otherwise.
 *
 * The three generative grammars of SPEC §9.2 are numeric only — bits,
 * quantized coordinates and pen widths, quantized pitch and duration bins —
 * so a string anywhere inside one is free text by construction, whatever key
 * it hides under: a color name, a semantic tag, a caption, a filename, or a
 * base64 audio blob. Running this before the shape checks makes the reason
 * code name the real violation (§9.1 "any accompanying free text ... is
 * rejected") rather than the shape mismatch the same payload also causes.
 *
 * `where` is a diagnostic path only; no part of the payload is ever included
 * (SPEC §9.4).
 */
export function assertNoStrings(
  value: unknown,
  where: string,
): CarrierValidationResult | undefined {
  return containsString(value)
    ? fail('free-text-present', `${where} carries a string value`)
    : undefined;
}

/** A raw proposal narrowed to the single artifact field its carrier defines. */
export type ArtifactReadResult =
  | { ok: true; artifact: Record<string, unknown>; value: unknown }
  | { ok: false; failure: CarrierValidationResult };

/**
 * Steps 1-3 of every module's `validate`: the proposal frame, the artifact
 * frame, and the artifact's single declared field.
 *
 * `field` is the one key the carrier's `publicArtifact` may hold, taken from
 * `AgentActionProposalSchema` (`glyphs`, `bitmap`, `strokes`, `tones`). Any
 * other key is `free-text-present` when it carries a string anywhere and
 * `unexpected-artifact-field` otherwise — which is how SPEC §9.2's "no color
 * or text field" is enforced without enumerating field names.
 */
export function readCarrierArtifact(
  proposal: unknown,
  field: string,
): ArtifactReadResult {
  if (!isPlainObject(proposal)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', 'proposal is not an object'),
    };
  }

  const extraProposalKeys = Object.keys(proposal).filter(
    (key) => key !== 'kind' && key !== 'publicArtifact',
  );
  if (extraProposalKeys.length > 0) {
    return {
      ok: false,
      failure: extraFieldFailure(proposal, extraProposalKeys, 'proposal'),
    };
  }

  const artifact = proposal.publicArtifact;
  if (!isPlainObject(artifact)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', 'publicArtifact is not an object'),
    };
  }

  const extraArtifactKeys = Object.keys(artifact).filter(
    (key) => key !== field,
  );
  if (extraArtifactKeys.length > 0) {
    return {
      ok: false,
      failure: extraFieldFailure(artifact, extraArtifactKeys, 'publicArtifact'),
    };
  }

  if (!(field in artifact)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', `publicArtifact.${field} is absent`),
    };
  }

  return { ok: true, artifact, value: artifact[field] };
}

/**
 * A nested object that must hold exactly one declared field, used by the
 * bitmap (`{ bitmap: { bits } }`) and tone (`{ tones: { tones } }`) artifact
 * shapes of `AgentActionProposalSchema`.
 */
export function readNestedField(
  container: unknown,
  field: string,
  where: string,
): ArtifactReadResult {
  if (!isPlainObject(container)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', `${where} is not an object`),
    };
  }
  const extraKeys = Object.keys(container).filter((key) => key !== field);
  if (extraKeys.length > 0) {
    return { ok: false, failure: extraFieldFailure(container, extraKeys, where) };
  }
  if (!(field in container)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', `${where}.${field} is absent`),
    };
  }
  return { ok: true, artifact: container, value: container[field] };
}

export interface MarkListRules {
  /** Which allowlist miss to report, e.g. `glyph-not-in-inventory`. */
  notInInventory: GatewayReasonCode;
  /** The declared inventory this carrier's marks are drawn from. */
  inventory: readonly string[];
  /** Diagnostic noun used in `detail`; never any part of the payload. */
  noun: string;
}

export type MarkListResult =
  | { ok: true; marks: string[] }
  | { ok: false; failure: CarrierValidationResult };

/**
 * The §9.1 mark-list discipline, applied to a symbolic carrier's id list.
 *
 * Validation order is fixed so the reason code for a given payload is
 * deterministic — shape, emptiness, length, allowlist/free text per mark,
 * then consecutive repeats — and matches the fixed-token module's order
 * exactly, because §9.2 gives `fixed-glyph` "the same repeat rule as tokens"
 * at "32 glyphs, 4 per message".
 */
export function validateMarkList(
  value: unknown,
  context: CarrierContext,
  rules: MarkListRules,
): MarkListResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failure: fail('invalid-envelope', `publicArtifact.${rules.noun} is not an array`),
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      failure: fail('empty-message', `publicArtifact.${rules.noun} is empty`),
    };
  }

  const cap = maxSymbolsFor(context.runContext.config);
  if (value.length > cap) {
    return {
      ok: false,
      failure: fail(
        'message-too-long',
        `message carries ${value.length} marks; the cap is ${cap}`,
      ),
    };
  }

  const inventory = new Set(rules.inventory);
  for (let index = 0; index < value.length; index += 1) {
    const mark: unknown = value[index];
    if (typeof mark !== 'string') {
      return {
        ok: false,
        failure: fail('invalid-envelope', `mark at index ${index} is not a string`),
      };
    }
    if (inventory.has(mark)) {
      continue;
    }
    if (!BARE_TOKEN_PATTERN.test(mark)) {
      return {
        ok: false,
        failure: fail(
          'free-text-present',
          `mark at index ${index} is not a bare inventory token`,
        ),
      };
    }
    return {
      ok: false,
      failure: fail(
        rules.notInInventory,
        `mark at index ${index} is not in the declared inventory`,
      ),
    };
  }

  const accepted = value as string[];
  let run = 1;
  for (let index = 1; index < accepted.length; index += 1) {
    run = accepted[index] === accepted[index - 1] ? run + 1 : 1;
    if (run > context.maxSymbolRepeats) {
      return {
        ok: false,
        failure: fail(
          'symbol-repeat-limit',
          `more than ${context.maxSymbolRepeats} consecutive identical marks ending at index ${index}`,
        ),
      };
    }
  }

  return { ok: true, marks: [...accepted] };
}

/**
 * A seeded mark list that the same module accepts: uniform length in
 * `[1, maxSymbolsPerMessage]`, uniform marks, with candidates that would
 * break the consecutive-repeat limit resampled. Identical draw order to the
 * fixed-token module's `randomArtifact`, so the §9.6 `random` control stream
 * stays comparable between the two symbolic carriers at one seed.
 */
export function randomMarkList(
  prng: { nextInt(maxExclusive: number): number },
  context: CarrierContext,
  inventory: readonly string[],
): string[] {
  const cap = maxSymbolsFor(context.runContext.config);
  const length = 1 + prng.nextInt(cap);
  const marks: string[] = [];
  while (marks.length < length) {
    const candidate = inventory[prng.nextInt(inventory.length)] as string;
    if (trailingRepeats(marks, candidate) >= context.maxSymbolRepeats) {
      continue;
    }
    marks.push(candidate);
  }
  return marks;
}
