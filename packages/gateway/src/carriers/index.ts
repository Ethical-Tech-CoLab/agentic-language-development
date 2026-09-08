/**
 * The SPECIFICATION.md §9.2 alternate neutral carrier protocols (ALD-031).
 *
 * Four protocol modules — `fixed-glyph`, `generative-bitmap`,
 * `generative-canvas`, `generative-tone` — plus the frozen glyph bundle, its
 * leakage audit, and the carrier-qualified content addressing of §9.2. See
 * `packages/gateway/README.md` for the threat-model and claim boundaries, and
 * `register.ts` for why nothing here is registered by default.
 */
export {
  ABSOLUTE_MAX_STROKES,
  BITMAP_BIT_COUNT,
  BITMAP_GRID_HEIGHT,
  BITMAP_GRID_WIDTH,
  CANVAS_GRID_MAX,
  CANVAS_GRID_MIN,
  CANVAS_STROKE_WIDTHS,
  DEFAULT_MAX_STROKES,
  DEFAULT_SYMBOL_INVENTORY_SIZE,
  MAX_TONES,
  TONE_DURATION_BINS,
  TONE_PITCH_BINS,
  isBit,
  isDurationBin,
  isGridCoordinate,
  isPitchBin,
  isStrokeWidth,
  maxStrokesFor,
} from './bounds.js';
export { generativeBitmapModule } from './bitmap.js';
export { generativeCanvasModule } from './canvas.js';
export {
  GlyphBundleAuditFailedError,
  GlyphBundleMismatchError,
  MissingGlyphBundleHashError,
  UnknownCarrierGrammarError,
} from './errors.js';
export {
  assertGlyphRunConfig,
  fixedGlyphModule,
  glyphInventoryFor,
} from './glyph.js';
export {
  GLYPH_AUDIT_REASON_CODES,
  GLYPH_AUDIT_THRESHOLDS,
  GLYPH_AUDIT_VERSION,
  auditGlyphBitmap,
  glyphBitmapFeatures,
  heuristicGlyphLeakageAudit,
  type AuditableGlyph,
  type GlyphAuditFinding,
  type GlyphAuditReasonCode,
  type GlyphBitmapFeatures,
  type GlyphLeakageAudit,
  type GlyphLeakageAuditResult,
} from './glyph-audit.js';
export {
  GLYPH_BUNDLE_HASH_DOMAIN,
  GLYPH_BUNDLE_VERSION,
  GLYPH_STROKES_MAX,
  GLYPH_STROKES_MIN,
  auditGlyphBundle,
  generateGlyphBundle,
  hashGlyphBundle,
  isGlyphBundleHash,
  verifyGlyphBundle,
  type GenerateGlyphBundleOptions,
  type GlyphBitmap,
  type GlyphBundle,
} from './glyph-bundle.js';
export {
  GLYPH_ID_PATTERN,
  carrierInventory,
  glyphInventory,
  isSymbolicCarrier,
} from './inventory.js';
export { carrierMarkHash } from './mark.js';
export {
  CARRIER_MARK_HASH_VECTORS,
  type CarrierMarkVector,
} from './mark-vectors.js';
export {
  assertNoStrings,
  randomMarkList,
  readCarrierArtifact,
  readNestedField,
  validateMarkList,
  type ArtifactReadResult,
  type MarkListResult,
  type MarkListRules,
} from './marks.js';
export {
  ALTERNATE_CARRIER_MODULES,
  ALTERNATE_CARRIERS,
  registerAlternateCarriers,
} from './register.js';
export { generativeToneModule } from './tone.js';
