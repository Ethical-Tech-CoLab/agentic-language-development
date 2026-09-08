/**
 * The pre-registered ALD-068 observation fixture set (EXPERIMENT-NOTEBOOK.md
 * E02; BACKLOG ALD-068 criterion 1).
 *
 * One entry per adversarial or control bundle, covering every attack category
 * ALD-068 names: "direct text, low-contrast/OCR-evasion fixtures, metadata
 * labels, semantic filenames, and malformed-image cases", plus the alternate
 * encodings of §10.1 and the text-free controls that ALD-039 criterion 2
 * requires to keep loading.
 *
 * Three conventions make this list safe to cite in evidence:
 *
 * 1. **Fixture ids and categories are language-free labels.** `fixtureId` is
 *    what the red-team result object records, so it never contains the
 *    planted vocabulary — `direct-text-01`, not `direct-text-red-circle`.
 * 2. **`plantedText` lives here and only here.** It is the researcher's own
 *    attack material. It is never copied into a registration record, a suite
 *    result, or a bundle attachment; the result carries `plantedTextHash`.
 * 3. **`assetId` is derived by hashing the fixture id**, so an asset
 *    identifier is opaque (§10.1 "no … semantic IDs") even though the fixture
 *    it came from is human-readable in this file.
 *
 * Every fixture's bytes are a pure function of its definition (seeded PRNG,
 * embedded typefaces, stored-DEFLATE PNG), so `generate.ts` reproduces the
 * committed files byte-for-byte on any machine.
 */
import { encodeHash, sha256Bytes } from '@ald/hashing';

import {
  encodeGrayscalePng,
  encodeRgbPng,
  type EncodePngOptions,
  type PngTextChunkInput,
} from './png-encode.js';
import {
  blankPlane,
  planeToRgb,
  renderGradientPlane,
  renderNoisePlane,
  renderRandomStrokesPlane,
  renderShapesPlane,
  renderTextPlane,
  type Plane,
} from './render.js';
import { TYPEFACES } from './bitmap-font.js';

/** Attack (and control) categories of the E02 procedure. */
export type FixtureCategory =
  | 'direct-text'
  | 'low-contrast-text'
  | 'rotated-text'
  | 'single-character'
  | 'image-metadata'
  | 'file-name'
  | 'caption-string'
  | 'malformed-image'
  | 'alternate-encoding'
  | 'text-free-control';

/** Bundle-level strings a fixture carries alongside its asset. */
export interface FixtureStrings {
  metadata?: Record<string, string | number | boolean>;
  fileNames?: string[];
  captions?: string[];
}

export interface FixtureDefinition {
  /** Language-free identifier; this is what evidence records. */
  fixtureId: string;
  category: FixtureCategory;
  /** The pre-registered expectation, set before the detector was calibrated. */
  expected: 'quarantined' | 'approved';
  /** Researcher-facing description. Stays in this file. */
  note: string;
  /** The exact planted human-language string, when the fixture plants one. */
  plantedText?: string;
  /** Deterministic asset bytes. */
  bytes(): Buffer;
  strings?: FixtureStrings;
}

/** Opaque asset id for a fixture: `a` plus 12 hex of the id's SHA-256. */
export function fixtureAssetId(fixtureId: string): string {
  const digest = encodeHash(sha256Bytes(Buffer.from(fixtureId, 'utf8')));
  return `a${digest.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

/**
 * The generator config every fixture bundle carries: numeric fields plus the
 * fixed-token inventory, i.e. text-free by construction. Deliberately shared,
 * so a bundle's verdict is decided by its asset and strings, not its config.
 */
export function fixtureGeneratorConfig(index: number): Record<string, unknown> {
  return {
    version: 1,
    attributeCount: 2,
    valuesPerAttribute: 4,
    candidatesPerEpisode: 4,
    heldOutTypeCodes: [],
    interactionMode: 'cooperative-signaling',
    symbolInventory: ['S01', 'S02', 'S03', 'S04'],
    fixtureIndex: index,
  };
}

const grayscale = (plane: Plane, options: EncodePngOptions = {}): Buffer =>
  encodeGrayscalePng(plane.width, plane.height, plane.pixels, options);

function textChunk(
  kind: PngTextChunkInput['kind'],
  keyword: string,
  text: string,
): PngTextChunkInput[] {
  return [{ kind, keyword, text }];
}

const STROKE_SEED = 'ald-068-strokes';

/** A text-free carrier image used by the metadata/filename/caption fixtures. */
function carrierPlane(seed: string): Plane {
  return renderRandomStrokesPlane(96, 48, seed);
}

const definitions: FixtureDefinition[] = [
  // ---- direct rendered text, several typefaces and sizes ----------------
  {
    fixtureId: 'direct-text-01',
    category: 'direct-text',
    expected: 'quarantined',
    note: 'attribute vocabulary, bitmap-5x7 at scale 2',
    plantedText: 'RED CIRCLE',
    bytes: () =>
      grayscale(
        renderTextPlane('RED CIRCLE', {
          width: 128,
          height: 28,
          x: 5,
          y: 7,
          scale: 2,
          typeface: 'bitmap-5x7',
        }),
      ),
  },
  {
    fixtureId: 'direct-text-02',
    category: 'direct-text',
    expected: 'quarantined',
    note: 'task vocabulary, bitmap-5x7 at scale 3',
    plantedText: 'TARGET',
    bytes: () =>
      grayscale(
        renderTextPlane('TARGET', {
          width: 120,
          height: 36,
          x: 6,
          y: 7,
          scale: 3,
          typeface: 'bitmap-5x7',
        }),
      ),
  },
  {
    fixtureId: 'direct-text-03',
    category: 'direct-text',
    expected: 'quarantined',
    note: 'an instruction sentence, bitmap-3x5 at scale 2',
    plantedText: 'PICK THE RED ONE',
    bytes: () =>
      grayscale(
        renderTextPlane('PICK THE RED ONE', {
          width: 136,
          height: 24,
          x: 4,
          y: 7,
          scale: 2,
          typeface: 'bitmap-3x5',
        }),
      ),
  },
  {
    fixtureId: 'direct-text-04',
    category: 'direct-text',
    expected: 'quarantined',
    note: 'outcome vocabulary, bitmap-5x7 bold at scale 2',
    plantedText: 'CORRECT',
    bytes: () =>
      grayscale(
        renderTextPlane('CORRECT', {
          width: 104,
          height: 24,
          x: 6,
          y: 8,
          scale: 2,
          bold: true,
          typeface: 'bitmap-5x7',
        }),
      ),
  },
  // ---- low-contrast / OCR-evasion --------------------------------------
  {
    fixtureId: 'low-contrast-01',
    category: 'low-contrast-text',
    expected: 'quarantined',
    note: 'one luminance step of contrast (#7f7f7f on #808080)',
    plantedText: 'TARGET',
    bytes: () =>
      grayscale(
        renderTextPlane('TARGET', {
          width: 112,
          height: 28,
          x: 6,
          y: 9,
          scale: 2,
          background: 0x80,
          foreground: 0x7f,
        }),
      ),
  },
  {
    fixtureId: 'low-contrast-02',
    category: 'low-contrast-text',
    expected: 'quarantined',
    note: 'eight luminance steps of contrast plus bounded seeded noise',
    plantedText: 'RED SQUARE',
    bytes: () =>
      grayscale(
        renderTextPlane('RED SQUARE', {
          width: 136,
          height: 28,
          x: 5,
          y: 9,
          scale: 2,
          background: 0x80,
          foreground: 0x88,
          noise: { amplitude: 2, seed: 'ald-068-low-contrast-02' },
        }),
      ),
  },
  // ---- rotated / sheared ----------------------------------------------
  {
    fixtureId: 'rotated-text-01',
    category: 'rotated-text',
    expected: 'quarantined',
    note: 'twelve-degree rotation, so the baseline is not horizontal',
    plantedText: 'TARGET',
    bytes: () =>
      grayscale(
        renderTextPlane('TARGET', {
          width: 136,
          height: 56,
          x: 12,
          y: 16,
          scale: 3,
          rotationDegrees: 12,
        }),
      ),
  },
  {
    fixtureId: 'rotated-text-02',
    category: 'rotated-text',
    expected: 'quarantined',
    note: 'horizontal shear of 0.4',
    plantedText: 'GREEN STAR',
    bytes: () =>
      grayscale(
        renderTextPlane('GREEN STAR', {
          width: 160,
          height: 40,
          x: 8,
          y: 12,
          scale: 2,
          skewX: 0.4,
        }),
      ),
  },
  // ---- single characters ----------------------------------------------
  {
    fixtureId: 'single-char-01',
    category: 'single-character',
    expected: 'quarantined',
    note: 'one large letter, bitmap-5x7 at scale 6',
    plantedText: 'A',
    bytes: () =>
      grayscale(
        renderTextPlane('A', { width: 56, height: 64, x: 12, y: 10, scale: 6 }),
      ),
  },
  {
    fixtureId: 'single-char-02',
    category: 'single-character',
    expected: 'quarantined',
    note: 'one large digit, bitmap-5x7 at scale 8',
    plantedText: '7',
    bytes: () =>
      grayscale(
        renderTextPlane('7', { width: 64, height: 72, x: 12, y: 8, scale: 8 }),
      ),
  },
  // ---- text in image metadata -----------------------------------------
  {
    fixtureId: 'image-metadata-01',
    category: 'image-metadata',
    expected: 'quarantined',
    note: 'tEXt chunk describing the scene',
    plantedText: 'the red circle is the target',
    bytes: () =>
      grayscale(carrierPlane(`${STROKE_SEED}-meta-01`), {
        textChunks: textChunk('tEXt', 'Description', 'the red circle is the target'),
      }),
  },
  {
    fixtureId: 'image-metadata-02',
    category: 'image-metadata',
    expected: 'quarantined',
    note: 'iTXt chunk carrying an answer label',
    plantedText: 'answer: the small blue square',
    bytes: () =>
      grayscale(carrierPlane(`${STROKE_SEED}-meta-02`), {
        textChunks: textChunk('iTXt', 'Comment', 'answer: the small blue square'),
      }),
  },
  {
    fixtureId: 'image-metadata-03',
    category: 'image-metadata',
    expected: 'quarantined',
    note: 'zTXt (compressed) chunk carrying a caption',
    plantedText: 'red circle on a white background',
    bytes: () =>
      grayscale(carrierPlane(`${STROKE_SEED}-meta-03`), {
        textChunks: textChunk('zTXt', 'Title', 'red circle on a white background'),
      }),
  },
  // ---- semantic filenames ---------------------------------------------
  {
    fixtureId: 'file-name-01',
    category: 'file-name',
    expected: 'quarantined',
    note: 'a semantic filename on a text-free image',
    plantedText: 'red_circle.png',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-file-01`)),
    strings: { fileNames: ['red_circle.png'] },
  },
  {
    fixtureId: 'file-name-02',
    category: 'file-name',
    expected: 'quarantined',
    note: 'a filename encoding the answer index',
    plantedText: 'target-answer-3.png',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-file-02`)),
    strings: { fileNames: ['target-answer-3.png'] },
  },
  // ---- captions --------------------------------------------------------
  {
    fixtureId: 'caption-01',
    category: 'caption-string',
    expected: 'quarantined',
    note: 'a natural-language caption',
    plantedText: 'the target is the red circle',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-caption-01`)),
    strings: { captions: ['the target is the red circle'] },
  },
  // ---- malformed images ------------------------------------------------
  {
    fixtureId: 'malformed-01',
    category: 'malformed-image',
    expected: 'quarantined',
    note: 'truncated mid-IDAT',
    bytes: () => {
      const full = grayscale(carrierPlane(`${STROKE_SEED}-malformed-01`));
      return Buffer.from(full.subarray(0, Math.floor(full.length / 2)));
    },
  },
  {
    fixtureId: 'malformed-02',
    category: 'malformed-image',
    expected: 'quarantined',
    note: 'IDAT CRC does not match',
    bytes: () =>
      grayscale(carrierPlane(`${STROKE_SEED}-malformed-02`), { corruptIdatCrc: true }),
  },
  {
    fixtureId: 'malformed-03',
    category: 'malformed-image',
    expected: 'quarantined',
    note: 'IHDR declares 100000x100000',
    bytes: () =>
      grayscale(blankPlane(16, 16, 200), {
        declaredDimensions: { width: 100_000, height: 100_000 },
      }),
  },
  {
    fixtureId: 'malformed-04',
    category: 'malformed-image',
    expected: 'quarantined',
    note: 'IHDR declares a zero dimension',
    bytes: () =>
      grayscale(blankPlane(16, 16, 200), {
        declaredDimensions: { width: 0, height: 16 },
      }),
  },
  {
    fixtureId: 'malformed-05',
    category: 'malformed-image',
    expected: 'quarantined',
    note: 'seeded random bytes declared as image/png',
    bytes: () => {
      const noise = renderNoisePlane(16, 32, 'ald-068-not-a-png');
      return Buffer.from(noise.pixels);
    },
  },
  // ---- alternate encodings --------------------------------------------
  {
    fixtureId: 'alternate-encoding-01',
    category: 'alternate-encoding',
    expected: 'quarantined',
    note: 'base64-wrapped sentence in asset metadata',
    plantedText: 'the red circle is the target',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-alt-01`)),
    strings: {
      metadata: {
        n0: Buffer.from('the red circle is the target', 'utf8').toString('base64'),
      },
    },
  },
  {
    fixtureId: 'alternate-encoding-02',
    category: 'alternate-encoding',
    expected: 'quarantined',
    // Cyrillic е substituted for Latin `e` in every position.
    note: 'homoglyph substitution in a caption',
    plantedText: 'thе rеd circlе',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-alt-02`)),
    strings: { captions: ['thе rеd circlе'] },
  },
  {
    fixtureId: 'alternate-encoding-03',
    category: 'alternate-encoding',
    expected: 'quarantined',
    note: 'zero-width spaces inserted inside every banned token',
    plantedText: 'r​ed ci​rcle ta​rget',
    bytes: () => grayscale(carrierPlane(`${STROKE_SEED}-alt-03`)),
    strings: { metadata: { n0: 'r​ed ci​rcle ta​rget' } },
  },
  {
    fixtureId: 'alternate-encoding-04',
    category: 'alternate-encoding',
    expected: 'quarantined',
    note: 'hex-wrapped sentence in a PNG tEXt chunk',
    plantedText: 'the target is red',
    bytes: () =>
      grayscale(carrierPlane(`${STROKE_SEED}-alt-04`), {
        textChunks: textChunk(
          'tEXt',
          'Raw',
          Buffer.from('the target is red', 'utf8').toString('hex'),
        ),
      }),
  },
  // ---- text-free controls (these MUST stay loadable) -------------------
  {
    fixtureId: 'control-01',
    category: 'text-free-control',
    expected: 'approved',
    note: 'uniform blank plane',
    bytes: () => grayscale(blankPlane(64, 64, 200)),
  },
  {
    fixtureId: 'control-02',
    category: 'text-free-control',
    expected: 'approved',
    note: 'seeded uniform noise',
    bytes: () => grayscale(renderNoisePlane(64, 64, 'ald-068-control-02')),
  },
  {
    fixtureId: 'control-03',
    category: 'text-free-control',
    expected: 'approved',
    note: 'seeded filled discs and rectangles',
    bytes: () => grayscale(renderShapesPlane(96, 48, 'ald-068-control-03')),
  },
  {
    fixtureId: 'control-04',
    category: 'text-free-control',
    expected: 'approved',
    note: 'SPEC §9.2-style random bounded strokes (the hardest negative)',
    bytes: () => grayscale(renderRandomStrokesPlane(96, 48, 'ald-068-control-04')),
  },
  {
    fixtureId: 'control-05',
    category: 'text-free-control',
    expected: 'approved',
    note: 'horizontal luminance ramp',
    bytes: () => grayscale(renderGradientPlane(64, 32)),
  },
  {
    fixtureId: 'control-06',
    category: 'text-free-control',
    expected: 'approved',
    note: 'RGB shapes, to exercise the colour-type 2 decode path',
    bytes: () => {
      const plane = renderShapesPlane(64, 48, 'ald-068-control-06');
      return encodeRgbPng(
        plane.width,
        plane.height,
        planeToRgb(plane, 'ald-068-control-06-tint'),
      );
    },
  },
  {
    fixtureId: 'control-07',
    category: 'text-free-control',
    expected: 'approved',
    note: 'opaque (non-semantic) filename and numeric metadata',
    bytes: () => grayscale(renderRandomStrokesPlane(96, 48, 'ald-068-control-07')),
    strings: { fileNames: ['a4f19c02.png'], metadata: { n0: 7, n1: 12, n2: true } },
  },
];

/** The frozen fixture list. */
export const OBSERVATION_FIXTURES: readonly FixtureDefinition[] = definitions;

/** Version of the fixture set; bump when a fixture is added or changed. */
export const FIXTURE_SET_VERSION = 'ald-068-observation-fixtures-v1';

/** Typeface names used, recorded in the manifest for provenance. */
export const FIXTURE_TYPEFACES = Object.keys(TYPEFACES).sort();
