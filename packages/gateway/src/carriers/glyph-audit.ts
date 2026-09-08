/**
 * Glyph leakage audit — a **heuristic** screen, not a detector
 * (SPECIFICATION.md §9.2: the glyph bundle "MUST ... pass the OCR/glyph
 * leakage audit"; ALD-031, with the real detector owned by ALD-039).
 *
 * What this claims: given a 16x16 monochrome bitmap, it computes four cheap
 * structural features and flags the bitmap when those features look like a
 * written character rather than like an abstract mark. That is enough to keep
 * an accidentally letter-shaped glyph out of a generated bundle, and it is
 * deterministic, so a bundle that passes it passes it identically for a third
 * party rebuilding the bundle from its seed.
 *
 * What this explicitly does NOT claim: it is not OCR, it does not recognise
 * characters, and a bitmap it passes is not certified text-free. The real
 * text/OCR detection over Baby-visible images is ALD-039's
 * `OcrDetector`/`HeuristicTextDetector`, and this module exposes a
 * {@link GlyphLeakageAudit} hook so that detector can be plugged in as the
 * bundle's audit instead of this screen (SPEC §9.2, ALD-039).
 *
 * The thresholds below are pre-registered constants of `glyph-audit-v1`: they
 * are part of the audit version string, so changing one is a new audit
 * version rather than a silent retune.
 */

/** Version recorded alongside every audit result (SPEC §15.3 analysis version). */
export const GLYPH_AUDIT_VERSION = 'glyph-audit-v1';

/** Machine-readable cues; a closed set, no payload text. */
export const GLYPH_AUDIT_REASON_CODES = [
  /** Nearly all ink sits inside one x-height band, as written text does. */
  'baseline-band-concentration',
  /** One small connected mark: a single stroke reads as a character. */
  'too-few-components',
  /** Almost no ink at all: nothing to distinguish, and nothing to reuse. */
  'ink-too-sparse',
  /** Ink fills the grid: a solid block carries no reusable form either. */
  'ink-too-dense',
] as const;

export type GlyphAuditReasonCode = (typeof GLYPH_AUDIT_REASON_CODES)[number];

/** Pre-registered thresholds of `glyph-audit-v1`. */
export const GLYPH_AUDIT_THRESHOLDS = {
  /** Height of the x-height band scanned for baseline concentration. */
  bandHeight: 8,
  /** Ink share inside one band at or above which the mark reads as text. */
  bandConcentration: 0.95,
  /** Vertical ink extent at or below which the band cue is meaningful. */
  maxVerticalExtent: 0.7,
  /** Minimum number of 4-connected ink components. */
  minComponents: 2,
  /** Ink density below which a mark is too sparse to be a reusable form. */
  minInkDensity: 0.04,
  /** Ink density above which a mark is a solid block. */
  maxInkDensity: 0.7,
} as const;

export interface GlyphBitmapFeatures {
  /** Fraction of cells that are ink. */
  inkDensity: number;
  /** Largest ink share inside any `bandHeight`-row horizontal band. */
  rowBandConcentration: number;
  /** Fraction of rows that contain any ink. */
  verticalExtent: number;
  /** Fraction of columns that contain any ink. */
  horizontalExtent: number;
  /** Number of 4-connected ink components. */
  componentCount: number;
}

export interface GlyphAuditFinding {
  /** Index of the glyph inside the bundle. */
  index: number;
  glyphId: string;
  textLike: boolean;
  /** Highest normalized cue value in `[0, 1]`; higher is more text-like. */
  score: number;
  reasonCodes: GlyphAuditReasonCode[];
  features: GlyphBitmapFeatures;
}

export interface GlyphLeakageAuditResult {
  auditVersion: string;
  glyphCount: number;
  textLikeCount: number;
  /** `true` when no glyph in the bundle was flagged. */
  pass: boolean;
  findings: GlyphAuditFinding[];
}

/** One 16x16 monochrome glyph as the audit sees it. */
export interface AuditableGlyph {
  glyphId: string;
  width: number;
  height: number;
  bits: readonly (0 | 1)[];
}

/**
 * Pluggable audit over a whole bundle. ALD-039's real text detector satisfies
 * this shape, so a bundle can be generated under the production detector
 * without this module changing.
 */
export type GlyphLeakageAudit = (
  glyphs: readonly AuditableGlyph[],
) => GlyphLeakageAuditResult;

function bitAt(
  bits: readonly (0 | 1)[],
  width: number,
  x: number,
  y: number,
): 0 | 1 {
  return bits[y * width + x] ?? 0;
}

/** Number of 4-connected ink components, by iterative flood fill. */
function countComponents(
  bits: readonly (0 | 1)[],
  width: number,
  height: number,
): number {
  const seen = new Uint8Array(width * height);
  let components = 0;
  for (let start = 0; start < width * height; start += 1) {
    if (bits[start] !== 1 || seen[start] === 1) {
      continue;
    }
    components += 1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const x = cell % width;
      const y = Math.floor(cell / width);
      const neighbours: Array<[number, number]> = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbours) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        const index = ny * width + nx;
        if (bits[index] === 1 && seen[index] === 0) {
          seen[index] = 1;
          stack.push(index);
        }
      }
    }
  }
  return components;
}

/** The four `glyph-audit-v1` features of one monochrome bitmap. */
export function glyphBitmapFeatures(
  bits: readonly (0 | 1)[],
  width: number,
  height: number,
): GlyphBitmapFeatures {
  const cells = width * height;
  let ink = 0;
  const rowInk = new Array<number>(height).fill(0);
  const columnInk = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bitAt(bits, width, x, y) === 1) {
        ink += 1;
        rowInk[y] = (rowInk[y] ?? 0) + 1;
        columnInk[x] = (columnInk[x] ?? 0) + 1;
      }
    }
  }

  const band = Math.min(GLYPH_AUDIT_THRESHOLDS.bandHeight, height);
  let bestBand = 0;
  for (let top = 0; top + band <= height; top += 1) {
    let inBand = 0;
    for (let y = top; y < top + band; y += 1) {
      inBand += rowInk[y] ?? 0;
    }
    bestBand = Math.max(bestBand, inBand);
  }

  return {
    inkDensity: cells === 0 ? 0 : ink / cells,
    rowBandConcentration: ink === 0 ? 0 : bestBand / ink,
    verticalExtent:
      height === 0 ? 0 : rowInk.filter((count) => count > 0).length / height,
    horizontalExtent:
      width === 0 ? 0 : columnInk.filter((count) => count > 0).length / width,
    componentCount: countComponents(bits, width, height),
  };
}

/**
 * Flag one glyph as text-like or not.
 *
 * The baseline cue is the one that actually distinguishes writing: Latin,
 * Cyrillic and Greek characters put nearly all of their ink between the
 * baseline and the x-height line, so a mark whose ink is ≥95% inside one
 * eight-row band while occupying ≤70% of the rows is shaped like a letter.
 * The remaining three cues reject marks that carry no reusable form at all
 * (a single small stroke, an empty grid, a filled grid) — those are not
 * "text-like" in the OCR sense, but §9.2 wants a bundle of usable unfamiliar
 * glyphs, and rejecting them here is what makes the generated bundle usable.
 */
export function auditGlyphBitmap(
  glyph: AuditableGlyph,
  index: number,
): GlyphAuditFinding {
  const features = glyphBitmapFeatures(glyph.bits, glyph.width, glyph.height);
  const reasonCodes: GlyphAuditReasonCode[] = [];
  const scores: number[] = [];

  if (
    features.rowBandConcentration >= GLYPH_AUDIT_THRESHOLDS.bandConcentration &&
    features.verticalExtent <= GLYPH_AUDIT_THRESHOLDS.maxVerticalExtent
  ) {
    reasonCodes.push('baseline-band-concentration');
    scores.push(features.rowBandConcentration);
  }
  if (features.componentCount < GLYPH_AUDIT_THRESHOLDS.minComponents) {
    reasonCodes.push('too-few-components');
    scores.push(1);
  }
  if (features.inkDensity < GLYPH_AUDIT_THRESHOLDS.minInkDensity) {
    reasonCodes.push('ink-too-sparse');
    scores.push(1);
  }
  if (features.inkDensity > GLYPH_AUDIT_THRESHOLDS.maxInkDensity) {
    reasonCodes.push('ink-too-dense');
    scores.push(1);
  }

  return {
    index,
    glyphId: glyph.glyphId,
    textLike: reasonCodes.length > 0,
    score: scores.length === 0 ? 0 : Math.max(...scores),
    reasonCodes,
    features,
  };
}

/** The built-in `glyph-audit-v1` screen over a whole bundle. */
export const heuristicGlyphLeakageAudit: GlyphLeakageAudit = (glyphs) => {
  const findings = glyphs.map((glyph, index) => auditGlyphBitmap(glyph, index));
  const textLikeCount = findings.filter((finding) => finding.textLike).length;
  return {
    auditVersion: GLYPH_AUDIT_VERSION,
    glyphCount: glyphs.length,
    textLikeCount,
    pass: textLikeCount === 0,
    findings,
  };
};
