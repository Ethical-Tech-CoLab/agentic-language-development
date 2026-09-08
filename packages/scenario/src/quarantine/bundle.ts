/**
 * Scenario-bundle registration and quarantine (ALD-039; SPECIFICATION.md
 * §10.1, §10.2).
 *
 * §10.1: "the Scenario Engine's authoring pipeline MUST run an automated
 * Observation Hygiene Filter … before any scenario bundle may be referenced
 * by a preregistered run". §10.2: "a scenario bundle containing detected OCR
 * text MUST fail the Observation Hygiene Filter and MUST NOT be loaded into a
 * run", and prohibited text is "never sanitized and passed through".
 *
 * `registerScenarioBundle` is that pipeline stage. It runs four gates in a
 * fixed order — schema, string scan, image decode, text detection — and
 * applies one rule to their union: **any** finding quarantines the **whole**
 * bundle. There is no per-asset approval, no stripping, and no downgrade
 * path; a bundle is either approved as a unit or quarantined as a unit.
 *
 * What a quarantine record contains (ALD-039 criterion 3): the reason codes,
 * index-based paths, the plain SHA-256 of every asset, the detector version,
 * and match counts. What it never contains: the offending string, a decoded
 * metadata value, a caption, a filename, or any asset byte. The record is
 * therefore safe to write into an evidence bundle or a public log, and the
 * raw injection text exists only in the researcher's own fixture source.
 *
 * The registration record is deliberately clock-free and pure, so two
 * registrations of the same bundle produce byte-identical canonical JSON.
 * Timestamps belong to the registry (`bundle-registry.ts`), which takes an
 * injected `Clock`.
 */
import { z } from 'zod';
import { HASH_DOMAINS } from '@ald/types';
import { canonicalJson, encodeHash, hashCanonical, sha256Bytes } from '@ald/hashing';

import { QuarantineError, type QuarantineReasonCode } from './errors.js';
import {
  HeuristicTextDetector,
  type OcrDetector,
  type TextDetectionReason,
} from './detector.js';
import { PngDecodeError, decodePng, type PngDecodeErrorCode, type PngDecodeOptions } from './png.js';
import { scanBundleString } from './text-scan.js';

/** Version of the complete filter pipeline, recorded in every decision. */
export const OBSERVATION_FILTER_VERSION = 'scenario-bundle-filter-v1';

/** Only PNG assets can be decoded and text-scanned, so nothing else loads. */
export const SUPPORTED_MEDIA_TYPES = ['image/png'] as const;

/**
 * Opaque asset identifier: no whitespace, no prose punctuation, bounded
 * length (§10.1 "no … semantic IDs"). The pattern alone does not decide
 * whether an id is semantic — `red_circle` matches it — which is why every
 * id is also run through the human-language scan below.
 */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

const jsonScalar = z.union([z.string(), z.number().finite(), z.boolean()]);

export const ScenarioBundleAssetSchema = z
  .object({
    /** Opaque id; never a filename, never a description. */
    assetId: z.string(),
    mediaType: z.string(),
    /**
     * Raw asset bytes. Never canonicalized, never hashed with a domain.
     * `z.custom` rather than `z.instanceof` so a `Buffer` from `readFileSync`
     * (a `Uint8Array<ArrayBufferLike>`) is accepted as-is.
     */
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
      message: 'asset bytes must be a Uint8Array',
    }),
    /** Authoring metadata; present in the model so fixtures can carry it. */
    metadata: z.record(z.string(), jsonScalar).optional(),
  })
  .strict();

export const ScenarioBundleSchema = z
  .object({
    version: z.literal(1),
    /**
     * The frozen generation config (a `ReferentialScenarioConfig` or any
     * canonical object). Its canonical hash is what `scenarioBundleHash`
     * commits to for asset-free bundles today.
     */
    generatorConfig: z.record(z.string(), z.unknown()),
    assets: z.array(ScenarioBundleAssetSchema),
    /** Present only so an adversarial bundle can be *tested*; see below. */
    fileNames: z.array(z.string()).optional(),
    captions: z.array(z.string()).optional(),
  })
  .strict();

export type ScenarioBundleAsset = z.infer<typeof ScenarioBundleAssetSchema>;
export type ScenarioBundle = z.infer<typeof ScenarioBundleSchema>;

/** One reason a bundle is quarantined. Carries codes and hashes only. */
export interface QuarantineFinding {
  reason: QuarantineReasonCode;
  /**
   * Index-based path inside the bundle, e.g. `assets.0.metadata.2.value`.
   * Index-based on purpose: a metadata *key* can itself be the injection, so
   * no key text is ever interpolated into a path.
   */
  path: string;
  /**
   * The asset id, present only when the id itself passed the opaque-id and
   * language checks. An id that is *itself* the injection is represented by
   * `assetIdHash` alone, so a quarantine record can never republish it.
   */
  assetId?: string;
  /** `sha256:<hex>` of the asset id's UTF-8 bytes; always present for assets. */
  assetIdHash?: string;
  /** Plain `sha256:<hex>` of the asset bytes (reproducible with `sha256sum`). */
  assetHash?: string;
  /** How many matches fired, for triage without content. */
  hits?: number;
  /** Detector score for an `ocr-text-detected` finding. */
  score?: number;
  /** Which structural cues fired (never what the text said). */
  detectionReasons?: TextDetectionReason[];
  /** Sub-code of a decode failure. */
  decodeCode?: PngDecodeErrorCode;
}

export interface ScenarioBundleAssetRecord {
  /** Omitted when the id failed the opaque-id or language checks. */
  assetId?: string;
  assetIdHash: string;
  assetHash: string;
  mediaType: string;
  byteLength: number;
  /** Present only when the asset decoded. */
  width?: number;
  height?: number;
  /** Number of PNG text chunks found (their content is never recorded). */
  textChunkCount?: number;
}

export interface ScenarioBundleRegistration {
  status: 'approved' | 'quarantined';
  /** `hashCanonical(HASH_DOMAINS.scenarioBundle, <bundle summary>)`. */
  bundleHash: string;
  filterVersion: string;
  detectorVersion: string;
  assets: ScenarioBundleAssetRecord[];
  findings: QuarantineFinding[];
  /** Deduplicated, sorted reason codes — the summary a report quotes. */
  reasonCodes: QuarantineReasonCode[];
}

/** Minimal sink the registry implements; keeps `bundle.ts` cycle-free. */
export interface ScenarioBundleRegistrySink {
  record(registration: ScenarioBundleRegistration): void;
}

export interface RegisterScenarioBundleOptions {
  /** Defaults to `HeuristicTextDetector`. Use `combineDetectors` to add OCR. */
  detector?: OcrDetector;
  /** Records the decision (approved and quarantined alike). */
  registry?: ScenarioBundleRegistrySink;
  /** Experiment-specific banned vocabulary, forwarded to the §10.1 scan. */
  extraTokens?: string[];
  /**
   * Fail-closed default (`false`): a scenario bundle has no legitimate need
   * for a filename, so carrying one is itself a finding
   * (`filename-present`). Set `true` to test that the language scan alone
   * still quarantines a *semantic* filename.
   */
  allowFileNames?: boolean;
  /** Same fail-closed rule for captions (`caption-present`). */
  allowCaptions?: boolean;
  /** Decode budget; an asset beyond it is quarantined, never approved. */
  decode?: PngDecodeOptions;
}

/** Plain SHA-256 of asset bytes; no domain separator, so `sha256sum` matches. */
export function hashAssetBytes(bytes: Uint8Array): string {
  return encodeHash(sha256Bytes(bytes));
}

function hashText(text: string): string {
  return encodeHash(sha256Bytes(Buffer.from(text, 'utf8')));
}

function collectStrings(
  value: unknown,
  path: string,
  out: Array<{ path: string; text: string }>,
): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectStrings(entry, `${path}.${index}`, out);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    Object.keys(record)
      .sort()
      .forEach((key, index) => {
        // The key is authored text too, and may itself be the injection, so
        // it is scanned under an index-based path.
        out.push({ path: `${path}.${index}.key`, text: key });
        collectStrings(record[key], `${path}.${index}.value`, out);
      });
  }
}

/**
 * Canonical summary the bundle hash commits to. Asset bytes are represented
 * by their plain SHA-256, and every authored string by the SHA-256 of its
 * UTF-8 bytes, so the hash preimage contains no prohibited text even for a
 * quarantined bundle.
 */
export function scenarioBundleSummary(bundle: ScenarioBundle): Record<string, unknown> {
  return {
    version: bundle.version,
    generatorConfig: bundle.generatorConfig,
    assets: bundle.assets.map((asset) => ({
      assetId: asset.assetId,
      assetHash: hashAssetBytes(asset.bytes),
      mediaType: asset.mediaType,
      byteLength: asset.bytes.byteLength,
      metadataHash:
        asset.metadata === undefined
          ? undefined
          : hashText(canonicalJson(asset.metadata)),
    })),
    fileNameHashes: bundle.fileNames?.map((name) => hashText(name)),
    captionHashes: bundle.captions?.map((caption) => hashText(caption)),
  };
}

/**
 * Hash of a bundle, defined for approved and quarantined bundles alike so a
 * quarantine record can be referenced by hash.
 *
 * An asset-free bundle hashes its `generatorConfig` directly, which is
 * exactly what `ReferentialScenarioEngine.bundleHash` already computes
 * (`hashCanonical(HASH_DOMAINS.scenarioBundle, config)`). That equality is
 * deliberate: every existing run is an asset-free, text-free-by-construction
 * bundle, so it registers trivially and its `RunConfig.scenarioBundleHash`
 * keeps matching the registry. Only a bundle that actually carries assets,
 * filenames, or captions hashes the richer summary.
 */
export function hashScenarioBundle(bundle: ScenarioBundle): string {
  const assetFree =
    bundle.assets.length === 0 &&
    (bundle.fileNames ?? []).length === 0 &&
    (bundle.captions ?? []).length === 0;
  return assetFree
    ? hashCanonical(HASH_DOMAINS.scenarioBundle, bundle.generatorConfig)
    : hashCanonical(HASH_DOMAINS.scenarioBundle, scenarioBundleSummary(bundle));
}

function schemaOnlyRegistration(
  detectorVersion: string,
  findings: QuarantineFinding[],
  bundleHash: string,
): ScenarioBundleRegistration {
  return {
    status: 'quarantined',
    bundleHash,
    filterVersion: OBSERVATION_FILTER_VERSION,
    detectorVersion,
    assets: [],
    findings,
    reasonCodes: uniqueReasons(findings),
  };
}

function uniqueReasons(findings: readonly QuarantineFinding[]): QuarantineReasonCode[] {
  return [...new Set(findings.map((finding) => finding.reason))].sort();
}

/**
 * Run the complete §10.1/§10.2 filter over a candidate bundle.
 *
 * Order (fixed, and each stage runs to completion so the record lists every
 * reason rather than the first): schema → authored-string scan → image decode
 * → text detection. Never throws for prohibited *content*; throws
 * `QuarantineError` only when the input is not a bundle-shaped object at all.
 */
export function registerScenarioBundle(
  candidate: unknown,
  options: RegisterScenarioBundleOptions = {},
): ScenarioBundleRegistration {
  const detector = options.detector ?? new HeuristicTextDetector();
  const extraTokens = options.extraTokens ?? [];

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new QuarantineError('invalid-input', 'a scenario bundle must be a JSON object');
  }

  const parsed = ScenarioBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    // No bundle hash is definable for a shape the filter cannot read, so the
    // record carries the hash of the schema issue paths instead — enough to
    // reference the decision, never the payload.
    const issuePaths = parsed.error.issues.map((issue) => issue.path.join('.')).sort();
    const registration = schemaOnlyRegistration(
      detector.detectorVersion,
      issuePaths.map((path) => ({ reason: 'schema-invalid' as QuarantineReasonCode, path })),
      hashCanonical(HASH_DOMAINS.scenarioBundle, { schemaIssuePaths: issuePaths }),
    );
    options.registry?.record(registration);
    return registration;
  }
  const bundle = parsed.data;

  let bundleHash: string;
  try {
    bundleHash = hashScenarioBundle(bundle);
  } catch (cause) {
    throw new QuarantineError(
      'invalid-input',
      `generatorConfig is not canonicalizable: ${(cause as Error).message}`,
    );
  }

  const findings: QuarantineFinding[] = [];

  // Asset identity, resolved before anything else references an asset: an id
  // that is itself an injection must never be echoed into a record, so each
  // asset gets a hash-only label unless its id passed both id checks.
  const labels = bundle.assets.map((asset, index) => {
    const assetIdHash = hashText(asset.assetId);
    const assetHash = hashAssetBytes(asset.bytes);
    const formatOk = ASSET_ID_PATTERN.test(asset.assetId);
    const languageFindings = scanBundleString(asset.assetId, extraTokens);
    if (!formatOk) {
      findings.push({
        reason: 'asset-id-format',
        path: `assets.${index}.assetId`,
        assetIdHash,
        assetHash,
      });
    }
    for (const finding of languageFindings) {
      findings.push({
        reason: finding.reason,
        path: `assets.${index}.assetId`,
        assetIdHash,
        assetHash,
        hits: finding.hits,
      });
    }
    const safe = formatOk && languageFindings.length === 0;
    return { assetIdHash, assetHash, safe, assetId: asset.assetId };
  });

  const attach = (index: number): Pick<QuarantineFinding, 'assetId' | 'assetIdHash' | 'assetHash'> => {
    const label = labels[index];
    if (label === undefined) {
      return {};
    }
    return label.safe
      ? { assetId: label.assetId, assetIdHash: label.assetIdHash, assetHash: label.assetHash }
      : { assetIdHash: label.assetIdHash, assetHash: label.assetHash };
  };

  const scanString = (text: string, path: string, assetIndex?: number): void => {
    for (const finding of scanBundleString(text, extraTokens)) {
      findings.push({
        reason: finding.reason,
        path,
        hits: finding.hits,
        ...(assetIndex === undefined ? {} : attach(assetIndex)),
      });
    }
  };

  // ---- Gate 2: authored strings (§10.1 regex/dictionary scan) ------------
  const generatorStrings: Array<{ path: string; text: string }> = [];
  collectStrings(bundle.generatorConfig, 'generatorConfig', generatorStrings);
  for (const entry of generatorStrings) {
    scanString(entry.text, entry.path);
  }

  const seenAssetIds = new Set<string>();
  bundle.assets.forEach((asset, index) => {
    if (seenAssetIds.has(asset.assetId)) {
      findings.push({
        reason: 'asset-id-duplicate',
        path: `assets.${index}.assetId`,
        ...attach(index),
      });
    }
    seenAssetIds.add(asset.assetId);
    if (asset.metadata !== undefined) {
      const metadataStrings: Array<{ path: string; text: string }> = [];
      collectStrings(asset.metadata, `assets.${index}.metadata`, metadataStrings);
      for (const entry of metadataStrings) {
        scanString(entry.text, entry.path, index);
      }
    }
  });

  (bundle.fileNames ?? []).forEach((name, index) => {
    if (options.allowFileNames !== true) {
      findings.push({ reason: 'filename-present', path: `fileNames.${index}` });
    }
    scanString(name, `fileNames.${index}`);
  });
  (bundle.captions ?? []).forEach((caption, index) => {
    if (options.allowCaptions !== true) {
      findings.push({ reason: 'caption-present', path: `captions.${index}` });
    }
    scanString(caption, `captions.${index}`);
  });

  // ---- Gates 3 and 4: decode, then detect text in pixels ----------------
  const assetRecords: ScenarioBundleAssetRecord[] = bundle.assets.map((asset, index) => {
    const label = labels[index];
    const record: ScenarioBundleAssetRecord = {
      assetIdHash: label?.assetIdHash ?? hashText(asset.assetId),
      assetHash: label?.assetHash ?? hashAssetBytes(asset.bytes),
      mediaType: asset.mediaType,
      byteLength: asset.bytes.byteLength,
    };
    if (label?.safe === true) {
      record.assetId = asset.assetId;
    }
    const supported: readonly string[] = SUPPORTED_MEDIA_TYPES;
    if (!supported.includes(asset.mediaType)) {
      findings.push({
        reason: 'unsupported-media-type',
        path: `assets.${index}.mediaType`,
        ...attach(index),
      });
      return record;
    }
    let image;
    try {
      image = decodePng(asset.bytes, options.decode);
    } catch (cause) {
      const decodeError =
        cause instanceof PngDecodeError
          ? cause
          : new PngDecodeError('chunk-invalid', 'decoder raised a non-decode error');
      findings.push({
        reason:
          decodeError.code === 'dimensions-too-large'
            ? 'image-too-large'
            : 'image-undecodable',
        path: `assets.${index}.bytes`,
        ...attach(index),
        decodeCode: decodeError.code,
      });
      return record;
    }
    record.width = image.width;
    record.height = image.height;
    record.textChunkCount = image.textChunks.length;

    image.textChunks.forEach((chunk, chunkIndex) => {
      findings.push({
        reason: 'image-text-chunk',
        path: `assets.${index}.textChunks.${chunkIndex}`,
        ...attach(index),
      });
      scanString(chunk.keyword, `assets.${index}.textChunks.${chunkIndex}.keyword`, index);
      scanString(chunk.text, `assets.${index}.textChunks.${chunkIndex}.text`, index);
    });

    const detection = detector.detect(image);
    if (detection.textLikely) {
      findings.push({
        reason: 'ocr-text-detected',
        path: `assets.${index}.bytes`,
        ...attach(index),
        score: detection.score,
        detectionReasons: detection.reasons,
      });
    }
    return record;
  });

  const registration: ScenarioBundleRegistration = {
    status: findings.length === 0 ? 'approved' : 'quarantined',
    bundleHash,
    filterVersion: OBSERVATION_FILTER_VERSION,
    detectorVersion: detector.detectorVersion,
    assets: assetRecords,
    findings,
    reasonCodes: uniqueReasons(findings),
  };
  options.registry?.record(registration);
  return registration;
}
