/**
 * ALD-031 — the frozen unfamiliar-glyph bundle and its leakage audit
 * (SPEC §9.2: "generated and frozen before pre-registration, contain no
 * Unicode text labels in Baby-visible data, and pass the OCR/glyph leakage
 * audit").
 *
 * The audit under test is a documented heuristic screen, not OCR: the
 * assertions below check exactly that — that it is deterministic, that it
 * keeps letter-shaped and formless bitmaps out of a generated bundle, and
 * that a generated bundle passes it. They do not assert that a passing bundle
 * is certified text-free; the real detector is ALD-039's.
 */
import { describe, expect, it } from 'vitest';

import { RunConfigSchema } from '@ald/types';

import {
  GLYPH_AUDIT_REASON_CODES,
  GLYPH_AUDIT_THRESHOLDS,
  GLYPH_AUDIT_VERSION,
  GLYPH_BUNDLE_HASH_DOMAIN,
  GLYPH_BUNDLE_VERSION,
  GlyphBundleAuditFailedError,
  GlyphBundleMismatchError,
  auditGlyphBitmap,
  auditGlyphBundle,
  generateGlyphBundle,
  glyphBitmapFeatures,
  glyphInventory,
  hashGlyphBundle,
  heuristicGlyphLeakageAudit,
  isGlyphBundleHash,
  verifyGlyphBundle,
  type GlyphBundle,
  type GlyphLeakageAudit,
} from '../src/carriers/index.js';

const SEED = 'ald-e13-glyph-bundle-v1';

/** A 16x16 bitmap whose ink sits in one x-height band, like written text. */
function letterLikeBitmap(): (0 | 1)[] {
  const bits = new Array<0 | 1>(256).fill(0);
  // Three vertical strokes and one crossbar between rows 5 and 11 only.
  for (const column of [3, 7, 11]) {
    for (let row = 5; row < 12; row += 1) {
      bits[row * 16 + column] = 1;
    }
  }
  for (let column = 3; column <= 11; column += 1) {
    bits[8 * 16 + column] = 1;
  }
  return bits;
}

/** A bitmap with a single tiny mark: no reusable form. */
function singleDotBitmap(): (0 | 1)[] {
  const bits = new Array<0 | 1>(256).fill(0);
  bits[8 * 16 + 8] = 1;
  return bits;
}

function solidBitmap(): (0 | 1)[] {
  return new Array<0 | 1>(256).fill(1);
}

describe('glyph inventory (SPEC §9.2)', () => {
  it('ALD-031: mints opaque G-prefixed identifiers, padded like S-tokens', () => {
    expect(glyphInventory(32)).toHaveLength(32);
    expect(glyphInventory(32)[0]).toBe('G01');
    expect(glyphInventory(32)[31]).toBe('G32');
    expect(glyphInventory(100)[99]).toBe('G100');
    expect(() => glyphInventory(1)).toThrow(/between 2 and 256/u);
    expect(() => glyphInventory(257)).toThrow(/between 2 and 256/u);
  });
});

describe('glyph bundle generation (ALD-031, SPEC §9.2)', () => {
  const bundle = generateGlyphBundle({ seed: SEED, size: 32 });

  it('ALD-031: is a pure function of its seed and size', () => {
    const again = generateGlyphBundle({ seed: SEED, size: 32 });
    expect(again).toEqual(bundle);
    expect(hashGlyphBundle(again)).toBe(hashGlyphBundle(bundle));

    const otherSeed = generateGlyphBundle({ seed: `${SEED}-b`, size: 32 });
    expect(hashGlyphBundle(otherSeed)).not.toBe(hashGlyphBundle(bundle));
    const otherSize = generateGlyphBundle({ seed: SEED, size: 16 });
    expect(hashGlyphBundle(otherSize)).not.toBe(hashGlyphBundle(bundle));
  });

  it('ALD-031: renders 32 monochrome 16x16 glyphs with the declared ids', () => {
    expect(bundle.version).toBe(GLYPH_BUNDLE_VERSION);
    expect(bundle.glyphs).toHaveLength(32);
    expect(bundle.glyphs.map((glyph) => glyph.glyphId)).toEqual(
      glyphInventory(32),
    );
    for (const glyph of bundle.glyphs) {
      expect(glyph.width).toBe(16);
      expect(glyph.height).toBe(16);
      expect(glyph.bits).toHaveLength(256);
      expect(glyph.bits.every((bit) => bit === 0 || bit === 1)).toBe(true);
    }
  });

  it('ALD-031: carries no Unicode text label in any Baby-visible field', () => {
    // The only strings in a bundle are the opaque identifiers and the
    // researcher-only seed and version fields. Nothing renderable as text
    // reaches the glyph images themselves, which are bits.
    const glyphStrings = bundle.glyphs.flatMap((glyph) =>
      Object.entries(glyph)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `${key}=${String(value)}`),
    );
    expect(glyphStrings).toEqual(
      glyphInventory(32).map((id) => `glyphId=${id}`),
    );
    for (const glyph of bundle.glyphs) {
      expect(glyph.glyphId).toMatch(/^G[0-9]{2}$/u);
    }
  });

  it('ALD-031: every generated glyph passes the §9.2 leakage audit', () => {
    const audit = auditGlyphBundle(bundle);
    expect(audit.auditVersion).toBe(GLYPH_AUDIT_VERSION);
    expect(audit.glyphCount).toBe(32);
    expect(audit.textLikeCount).toBe(0);
    expect(audit.pass).toBe(true);
    expect(audit.findings.every((finding) => finding.reasonCodes.length === 0)).toBe(
      true,
    );
  });

  it('ALD-031: hashes under the documented implementation-defined domain', () => {
    expect(GLYPH_BUNDLE_HASH_DOMAIN).toBe('dtsf-glyph-bundle-v1');
    expect(hashGlyphBundle(bundle)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The hash is accepted by RunConfigSchema's `glyphBundleHash` field.
    expect(() =>
      RunConfigSchema.shape.glyphBundleHash.parse(hashGlyphBundle(bundle)),
    ).not.toThrow();
  });

  it('ALD-031: verification is exact and reports a mismatch rather than passing', () => {
    const hash = hashGlyphBundle(bundle);
    expect(() => verifyGlyphBundle(bundle, hash)).not.toThrow();
    expect(isGlyphBundleHash(bundle, hash)).toBe(true);

    const tampered: GlyphBundle = {
      ...bundle,
      glyphs: bundle.glyphs.map((glyph, index) =>
        index === 0
          ? { ...glyph, bits: glyph.bits.map((bit, cell) => (cell === 0 ? 1 : bit)) }
          : glyph,
      ),
    };
    expect(isGlyphBundleHash(tampered, hash)).toBe(false);
    let caught: unknown;
    try {
      verifyGlyphBundle(tampered, hash);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GlyphBundleMismatchError);
    expect((caught as GlyphBundleMismatchError).expectedHash).toBe(hash);
  });

  it('ALD-031: accepts a pluggable audit and records its version', () => {
    const calls: number[] = [];
    const permissive: GlyphLeakageAudit = (glyphs) => {
      calls.push(glyphs.length);
      return {
        auditVersion: 'stub-ocr-detector-v0',
        glyphCount: glyphs.length,
        textLikeCount: 0,
        pass: true,
        findings: [],
      };
    };
    const custom = generateGlyphBundle({
      seed: SEED,
      size: 4,
      leakageAudit: permissive,
    });
    expect(custom.auditVersion).toBe('stub-ocr-detector-v0');
    expect(calls).toHaveLength(4);
  });

  it('ALD-031: reports a parameter fault when no candidate can pass the audit', () => {
    const refuseEverything: GlyphLeakageAudit = (glyphs) => ({
      auditVersion: 'always-fails-v0',
      glyphCount: glyphs.length,
      textLikeCount: glyphs.length,
      pass: false,
      findings: glyphs.map((glyph, index) => ({
        index,
        glyphId: glyph.glyphId,
        textLike: true,
        score: 1,
        reasonCodes: ['ink-too-sparse'],
        features: glyphBitmapFeatures(glyph.bits, glyph.width, glyph.height),
      })),
    });
    let caught: unknown;
    try {
      generateGlyphBundle({ seed: SEED, size: 2, leakageAudit: refuseEverything });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GlyphBundleAuditFailedError);
    expect((caught as GlyphBundleAuditFailedError).glyphIndex).toBe(0);
    expect((caught as GlyphBundleAuditFailedError).reasonCodes).toContain(
      'ink-too-sparse',
    );
  });
});

describe('glyph leakage audit heuristic (ALD-031, ALD-039 hook)', () => {
  it('ALD-031: flags a letter-shaped bitmap by baseline concentration', () => {
    const finding = auditGlyphBitmap(
      { glyphId: 'G01', width: 16, height: 16, bits: letterLikeBitmap() },
      0,
    );
    expect(finding.textLike).toBe(true);
    expect(finding.reasonCodes).toContain('baseline-band-concentration');
    expect(finding.features.rowBandConcentration).toBeGreaterThanOrEqual(
      GLYPH_AUDIT_THRESHOLDS.bandConcentration,
    );
    expect(finding.score).toBeGreaterThan(0.9);
  });

  it('ALD-031: flags a single tiny mark and a solid block', () => {
    const dot = auditGlyphBitmap(
      { glyphId: 'G02', width: 16, height: 16, bits: singleDotBitmap() },
      1,
    );
    expect(dot.textLike).toBe(true);
    expect(dot.reasonCodes).toContain('too-few-components');
    expect(dot.reasonCodes).toContain('ink-too-sparse');

    const solid = auditGlyphBitmap(
      { glyphId: 'G03', width: 16, height: 16, bits: solidBitmap() },
      2,
    );
    expect(solid.textLike).toBe(true);
    expect(solid.reasonCodes).toContain('ink-too-dense');
  });

  it('ALD-031: passes a generated abstract glyph', () => {
    const bundle = generateGlyphBundle({ seed: SEED, size: 8 });
    for (const [index, glyph] of bundle.glyphs.entries()) {
      const finding = auditGlyphBitmap(glyph, index);
      expect(finding.textLike, glyph.glyphId).toBe(false);
      expect(finding.score).toBe(0);
    }
  });

  it('ALD-031: reports only closed-set reason codes', () => {
    const result = heuristicGlyphLeakageAudit([
      { glyphId: 'G01', width: 16, height: 16, bits: letterLikeBitmap() },
      { glyphId: 'G02', width: 16, height: 16, bits: singleDotBitmap() },
    ]);
    expect(result.pass).toBe(false);
    expect(result.textLikeCount).toBe(2);
    for (const finding of result.findings) {
      for (const code of finding.reasonCodes) {
        expect(GLYPH_AUDIT_REASON_CODES).toContain(code);
      }
    }
  });

  it('ALD-031: counts 4-connected components and ink extents', () => {
    const bits = new Array<0 | 1>(256).fill(0);
    bits[0] = 1;
    bits[2] = 1;
    bits[16 * 15 + 15] = 1;
    const features = glyphBitmapFeatures(bits, 16, 16);
    expect(features.componentCount).toBe(3);
    expect(features.inkDensity).toBeCloseTo(3 / 256, 10);
    expect(features.verticalExtent).toBeCloseTo(2 / 16, 10);
    expect(features.horizontalExtent).toBeCloseTo(3 / 16, 10);

    const empty = glyphBitmapFeatures(new Array<0 | 1>(256).fill(0), 16, 16);
    expect(empty.componentCount).toBe(0);
    expect(empty.rowBandConcentration).toBe(0);
  });
});
