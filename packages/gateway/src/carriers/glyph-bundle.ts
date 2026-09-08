/**
 * The frozen unfamiliar-glyph bundle (SPECIFICATION.md §9.2, ALD-031).
 *
 * §9.2: "The unfamiliar glyph bundle MUST be generated and frozen before
 * pre-registration, contain no Unicode text labels in Baby-visible data, and
 * pass the OCR/glyph leakage audit."
 *
 * All three properties are structural here rather than procedural:
 *
 * - **No Unicode text.** A glyph is a 16x16 monochrome bit matrix drawn from
 *   random bounded straight strokes. There is no font, no glyph outline
 *   library, and no code point anywhere in the pipeline — the only strings in
 *   a bundle are the opaque `G01`-style identifiers, which are indices, not
 *   labels, and are never rendered into the image.
 * - **Frozen.** The whole bundle is a deterministic function of one seed and
 *   its size, so `glyphBundleHash` pins it: a third party regenerates the
 *   identical bundle from the pre-registration and recomputes the same hash.
 * - **Audited.** Every glyph is screened by a {@link GlyphLeakageAudit}
 *   (`glyph-audit.ts` by default, ALD-039's real text detector when it is
 *   available) and a flagged glyph is *resampled*, not accepted — so the
 *   bundle that gets hashed is audit-clean by construction and
 *   `auditGlyphBundle` on it is a re-check, not the first check.
 *
 * The hash domain is implementation-defined: SPEC §11.1 and §18 name
 * `glyphBundleHash` but no separator string. The implementation-defined
 * separator lives in `HASH_DOMAINS` beside every other evidence hash domain.
 */
import { HASH_DOMAINS } from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';

import {
  BITMAP_GRID_HEIGHT,
  BITMAP_GRID_WIDTH,
  CANVAS_GRID_MAX,
  DEFAULT_SYMBOL_INVENTORY_SIZE,
} from './bounds.js';
import { GlyphBundleAuditFailedError, GlyphBundleMismatchError } from './errors.js';
import {
  heuristicGlyphLeakageAudit,
  type AuditableGlyph,
  type GlyphLeakageAudit,
  type GlyphLeakageAuditResult,
} from './glyph-audit.js';
import { glyphInventory } from './inventory.js';

/**
 * Implementation-defined hash domain for the §9.2 glyph bundle.
 */
export const GLYPH_BUNDLE_HASH_DOMAIN = HASH_DOMAINS.glyphBundle;

/** Bundle format version; part of the hashed preimage. */
export const GLYPH_BUNDLE_VERSION = 1 as const;

/** Strokes drawn per glyph, inclusive range. Part of the hashed preimage. */
export const GLYPH_STROKES_MIN = 3;
export const GLYPH_STROKES_MAX = 5;

/** Seeded resample attempts before generation gives up on one glyph. */
const AUDIT_ATTEMPT_BUDGET = 64;

export interface GlyphBitmap {
  /** Opaque inventory identifier (`G01`); an index, never a label. */
  glyphId: string;
  width: number;
  height: number;
  /** Row-major monochrome cells, `width * height` of them. */
  bits: (0 | 1)[];
}

export interface GlyphBundle {
  version: typeof GLYPH_BUNDLE_VERSION;
  /** The seed the bundle is a pure function of; researcher-visible only. */
  seed: string;
  width: number;
  height: number;
  strokesMin: number;
  strokesMax: number;
  auditVersion: string;
  glyphs: GlyphBitmap[];
}

export interface GenerateGlyphBundleOptions {
  seed: string;
  /** Inventory size, 2-256; defaults to the §9.1/§9.2 default of 32. */
  size?: number;
  /**
   * SPEC §9.2 audit hook. Defaults to `glyph-audit.ts`'s heuristic screen;
   * pass ALD-039's `OcrDetector`-backed audit to generate a bundle under the
   * production detector instead.
   */
  leakageAudit?: GlyphLeakageAudit;
}

/** Draw one straight stroke into `bits` with Bresenham; width 1, monochrome. */
function drawStroke(
  bits: (0 | 1)[],
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    bits[y * width + x] = 1;
    if (x === x1 && y === y1) {
      return;
    }
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += stepX;
    }
    if (doubled < dx) {
      error += dx;
      y += stepY;
    }
  }
}

/**
 * One candidate glyph from a labelled child stream. Strokes span the whole
 * 0-15 grid — no baseline, no x-height band, no character cell — which is why
 * the audit's baseline cue almost never fires on a generated glyph and does
 * fire on a rendered letter.
 */
function drawCandidate(prng: SeededPrng, width: number, height: number): (0 | 1)[] {
  const bits = new Array<0 | 1>(width * height).fill(0);
  const strokes =
    GLYPH_STROKES_MIN + prng.nextInt(GLYPH_STROKES_MAX - GLYPH_STROKES_MIN + 1);
  for (let stroke = 0; stroke < strokes; stroke += 1) {
    drawStroke(
      bits,
      width,
      prng.nextInt(CANVAS_GRID_MAX + 1),
      prng.nextInt(CANVAS_GRID_MAX + 1),
      prng.nextInt(CANVAS_GRID_MAX + 1),
      prng.nextInt(CANVAS_GRID_MAX + 1),
    );
  }
  return bits;
}

/**
 * Generate the bundle for `seed` and `size`. Pure and total: the same
 * arguments always produce the identical bundle, and a glyph that the audit
 * flags is resampled from a further-derived stream rather than kept.
 */
export function generateGlyphBundle(
  options: GenerateGlyphBundleOptions,
): GlyphBundle {
  const size = options.size ?? DEFAULT_SYMBOL_INVENTORY_SIZE;
  const ids = glyphInventory(size);
  const audit = options.leakageAudit ?? heuristicGlyphLeakageAudit;
  const root = new SeededPrng(options.seed).derive('glyph-bundle');
  const width = BITMAP_GRID_WIDTH;
  const height = BITMAP_GRID_HEIGHT;

  const glyphs: GlyphBitmap[] = [];
  let auditVersion = '';

  ids.forEach((glyphId, index) => {
    let accepted: GlyphBitmap | undefined;
    let lastReasonCodes: string[] = [];
    for (
      let attempt = 0;
      attempt < AUDIT_ATTEMPT_BUDGET && accepted === undefined;
      attempt += 1
    ) {
      const candidate: GlyphBitmap = {
        glyphId,
        width,
        height,
        bits: drawCandidate(
          root.derive(`${String(index)}/${String(attempt)}`),
          width,
          height,
        ),
      };
      const result = audit([candidate]);
      auditVersion = result.auditVersion;
      if (result.pass) {
        accepted = candidate;
      } else {
        lastReasonCodes = result.findings.flatMap(
          (finding) => finding.reasonCodes,
        );
      }
    }
    if (accepted === undefined) {
      throw new GlyphBundleAuditFailedError(
        index,
        AUDIT_ATTEMPT_BUDGET,
        lastReasonCodes,
      );
    }
    glyphs.push(accepted);
  });

  return {
    version: GLYPH_BUNDLE_VERSION,
    seed: options.seed,
    width,
    height,
    strokesMin: GLYPH_STROKES_MIN,
    strokesMax: GLYPH_STROKES_MAX,
    auditVersion,
    glyphs,
  };
}

/**
 * `glyphBundleHash` (SPEC §9.2, §11.1): the domain-separated hash of the RFC
 * 8785 canonical form of the whole bundle, including the seed and the drawing
 * parameters, so the hash pins the *recipe* as well as the pixels.
 */
export function hashGlyphBundle(bundle: GlyphBundle): string {
  return hashCanonical(GLYPH_BUNDLE_HASH_DOMAIN, bundle);
}

/** The audit re-check over an existing bundle (SPEC §9.2). */
export function auditGlyphBundle(
  bundle: GlyphBundle,
  leakageAudit: GlyphLeakageAudit = heuristicGlyphLeakageAudit,
): GlyphLeakageAuditResult {
  return leakageAudit(bundle.glyphs as readonly AuditableGlyph[]);
}

/**
 * Verify a bundle against the hash a run configuration pins. Throws
 * {@link GlyphBundleMismatchError} on a mismatch rather than returning
 * `false`, because a silently unverified bundle is exactly the failure §9.2
 * is guarding against; the boolean form is {@link isGlyphBundleHash}.
 */
export function verifyGlyphBundle(
  bundle: GlyphBundle,
  expectedHash: string,
): void {
  const actualHash = hashGlyphBundle(bundle);
  if (actualHash !== expectedHash) {
    throw new GlyphBundleMismatchError(expectedHash, actualHash);
  }
}

/** Non-throwing form of {@link verifyGlyphBundle}. */
export function isGlyphBundleHash(
  bundle: GlyphBundle,
  expectedHash: string,
): boolean {
  return hashGlyphBundle(bundle) === expectedHash;
}
