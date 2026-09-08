/**
 * Closed error/reason-code vocabulary for the scenario-bundle quarantine
 * (ALD-039; SPECIFICATION.md §10.1, §10.2).
 *
 * Two distinct vocabularies live here, and the difference matters:
 *
 * - `QuarantineErrorCode` is for *caller* faults — a bundle that cannot even
 *   be evaluated (a non-object, an unreadable registry directory). These
 *   throw, because there is no bundle to quarantine.
 * - `QuarantineReasonCode` is for *content* findings — what §10.2 calls
 *   "detected OCR text", captions, semantic filenames, or human-readable
 *   labels. A finding never throws and is never sanitized away: it
 *   quarantines the complete bundle and is recorded as a code.
 *
 * Neither vocabulary carries payload text. §10.2 forbids passing prohibited
 * content through, and SPEC §13.6/ALD-039 criterion 3 forbids exposing raw
 * injection text in Baby-visible or public logs, so a finding records the
 * reason code, the dotted path, and the asset hash — never the offending
 * string and never the asset bytes.
 */

/** Faults that make a bundle un-evaluable; these throw. */
export type QuarantineErrorCode =
  | 'invalid-input'
  | 'registry-io'
  | 'registry-corrupt'
  | 'unknown-detector'
  /** A run referenced a bundle hash the registry does not list as approved. */
  | 'bundle-not-approved';

export class QuarantineError extends Error {
  constructor(
    readonly code: QuarantineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Every reason a bundle can be quarantined. Closed union: a new detection
 * cue must be named here, so a reader of a quarantine record can enumerate
 * the complete filter surface without reading the implementation.
 */
export type QuarantineReasonCode =
  /** The bundle does not satisfy `ScenarioBundleSchema`. */
  | 'schema-invalid'
  /** `assetId` is not an opaque identifier (§10.1: no semantic IDs). */
  | 'asset-id-format'
  /** Duplicate `assetId` inside one bundle. */
  | 'asset-id-duplicate'
  /** Only `image/png` assets can be text-scanned, so nothing else loads. */
  | 'unsupported-media-type'
  /**
   * The §10.1 scan (`scanForHumanLanguage`) matched a banned token or read a
   * string as prose. The §10.1 filter reports those as two codes; the public
   * helper collapses them into one list of offending strings, and this
   * quarantine keeps only the count (never the text), so both classes are
   * recorded under this one code.
   */
  | 'human-language-token'
  /** A bundle string contains an emoji/pictographic code point. */
  | 'pictographic'
  /** Zero-width or invisible formatting characters used to hide text. */
  | 'zero-width-character'
  /** Confusable/homoglyph characters that fold to banned vocabulary. */
  | 'homoglyph-language'
  /** Base64/hex-encoded human language inside a string. */
  | 'encoded-language'
  /** A filename at all is out-of-scenario metadata (§10.1). */
  | 'filename-present'
  /** A caption at all is out-of-scenario metadata (§10.1). */
  | 'caption-present'
  /** The image carries a PNG tEXt/zTXt/iTXt chunk. */
  | 'image-text-chunk'
  /** The image bytes cannot be decoded (truncated, bad CRC, not a PNG …). */
  | 'image-undecodable'
  /** The image declares dimensions beyond the decode budget. */
  | 'image-too-large'
  /** The text detector reports OCR-visible glyph structure (§10.2). */
  | 'ocr-text-detected';

/** Human-language findings share one mapping from the §10.1 filter's codes. */
export const LANGUAGE_REASON_CODES: readonly QuarantineReasonCode[] = [
  'human-language-token',
  'pictographic',
  'zero-width-character',
  'homoglyph-language',
  'encoded-language',
];
