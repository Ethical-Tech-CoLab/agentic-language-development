/**
 * Scenario-bundle quarantine (ALD-039; SPECIFICATION.md §10.1, §10.2).
 *
 * The four modules behind this barrel are the pipeline stages, in order:
 * `png.ts` decodes an asset (fail-closed on anything malformed),
 * `text-scan.ts` folds authored strings through the ALD-068 evasion forms
 * before the §10.1 dictionary scan, `detector.ts` looks for the structure of
 * rendered text in the pixels, and `bundle.ts` turns any finding into a
 * whole-bundle quarantine record that carries codes and hashes but never the
 * prohibited content.
 */
export {
  QuarantineError,
  LANGUAGE_REASON_CODES,
  type QuarantineErrorCode,
  type QuarantineReasonCode,
} from './errors.js';
export {
  PngDecodeError,
  crc32,
  decodePng,
  type DecodedImage,
  type PngDecodeErrorCode,
  type PngDecodeOptions,
  type PngTextChunk,
} from './png.js';
export {
  countInvisible,
  encodedCandidates,
  foldConfusables,
  scanBundleString,
  stripInvisible,
  type StringFinding,
} from './text-scan.js';
export {
  HeuristicTextDetector,
  NULL_TEXT_DETECTOR,
  combineDetectors,
  type HeuristicTextDetectorOptions,
  type OcrDetector,
  type TemplateGlyphDetector,
  type TextDetection,
  type TextDetectionReason,
} from './detector.js';
export {
  ASSET_ID_PATTERN,
  OBSERVATION_FILTER_VERSION,
  SUPPORTED_MEDIA_TYPES,
  ScenarioBundleAssetSchema,
  ScenarioBundleSchema,
  hashAssetBytes,
  hashScenarioBundle,
  registerScenarioBundle,
  scenarioBundleSummary,
  type QuarantineFinding,
  type RegisterScenarioBundleOptions,
  type ScenarioBundle,
  type ScenarioBundleAsset,
  type ScenarioBundleAssetRecord,
  type ScenarioBundleRegistration,
  type ScenarioBundleRegistrySink,
} from './bundle.js';
