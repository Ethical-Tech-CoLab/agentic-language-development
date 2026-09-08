/**
 * Text detection over scenario assets (ALD-039; SPECIFICATION.md §10.2).
 *
 * §10.2: "Synthetic scenes MUST contain no text. Any future use of real
 * images MUST pass through OCR detection and quarantine so that environmental
 * text cannot instruct an agent or leak human vocabulary". This module is the
 * detection half; `bundle.ts` is the quarantine half.
 *
 * `HeuristicTextDetector` is a **heuristic**, not an OCR engine, and every
 * comment, reason code, and report field here says so. It does not recognize
 * characters and cannot report what an image says; it reports whether an
 * image contains the *structure* of rendered text — a run of similarly sized
 * ink components sitting on a common fitted baseline at a regular pitch with
 * a consistent stroke width. That is the structure a caption, a label, or an
 * OCR-visible watermark has and that the §9.2-style random-stroke controls do
 * not. It is calibrated against the pre-registered ALD-068 fixtures, and the
 * calibration is reported as false-positive/false-negative counts, never as a
 * claim of OCR coverage.
 *
 * `TemplateGlyphDetector` is the seam for a real engine (tesseract.js or a
 * template matcher over a frozen glyph set). Nothing in this package depends
 * on one; `combineDetectors` ORs any number of detectors so adding an engine
 * later strictly widens detection and cannot weaken it.
 */
import type { DecodedImage } from './png.js';

/** Structural cues; each names what fired, never what the text said. */
export type TextDetectionReason =
  /** Ink components in a row sit on a common (possibly rotated) baseline. */
  | 'baseline-aligned-row'
  /** Ink components in a row have near-equal heights (an x-height band). */
  | 'uniform-glyph-height'
  /** Component left edges advance at a regular pitch (character advance). */
  | 'regular-glyph-spacing'
  /** Horizontal run lengths are consistent (a pen of constant width). */
  | 'consistent-stroke-width'
  /** Enough glyph-sized components in one row to be a word. */
  | 'glyph-count-in-row'
  /** A single component with internal, constant-width, multi-run structure. */
  | 'rectilinear-glyph-structure';

export interface TextDetection {
  /** True when `score >= threshold`; the bundle is then quarantined. */
  textLikely: boolean;
  /** Calibrated 0..1 structural score. Not a probability. */
  score: number;
  reasons: TextDetectionReason[];
}

export interface OcrDetector {
  /** Recorded in every quarantine record so a decision is reproducible. */
  readonly detectorVersion: string;
  detect(image: DecodedImage): TextDetection;
}

/**
 * Hook for a future real OCR/template engine. Implementations recognize
 * glyphs; `templateSetHash` pins the glyph set (or model) so a quarantine
 * decision stays reproducible. Intentionally unimplemented here: adding a
 * dependency for it is a separate, pre-registered decision.
 */
export interface TemplateGlyphDetector extends OcrDetector {
  /** Engine identifier, e.g. `tesseract.js@5`. */
  readonly engine: string;
  /** Hash of the frozen template/model set the engine matches against. */
  readonly templateSetHash: string;
}

/**
 * OR-combine detectors: text is likely when any detector says so, and the
 * combined score is the maximum. Version strings are concatenated so the
 * record identifies the exact ensemble.
 */
export function combineDetectors(detectors: readonly OcrDetector[]): OcrDetector {
  if (detectors.length === 0) {
    throw new Error('combineDetectors requires at least one detector');
  }
  const detectorVersion = detectors.map((detector) => detector.detectorVersion).join('+');
  return {
    detectorVersion,
    detect(image: DecodedImage): TextDetection {
      let best: TextDetection = { textLikely: false, score: 0, reasons: [] };
      for (const detector of detectors) {
        const result = detector.detect(image);
        if (result.textLikely && !best.textLikely) {
          best = result;
        } else if (result.textLikely === best.textLikely && result.score > best.score) {
          best = result;
        }
      }
      return best;
    },
  };
}

export interface HeuristicTextDetectorOptions {
  /** Score at or above which the asset is reported as text. Default 0.35. */
  threshold?: number;
  /** Global luminance range below which local normalization is used. Default 32. */
  lowContrastRange?: number;
  /** Block edge for local contrast normalization, in pixels. Default 16. */
  normalizationBlock?: number;
}

interface Component {
  left: number;
  right: number;
  top: number;
  bottom: number;
  area: number;
  /** Horizontal foreground run lengths inside the component. */
  runs: number[];
  /** Occupied rows, used for the runs-per-row structure cue. */
  rowCount: number;
}

const DETECTOR_VERSION = 'heuristic-text-detector-v2';

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  let total = 0;
  for (const value of values) {
    total += (value - average) ** 2;
  }
  return Math.sqrt(total / (values.length - 1));
}

function coefficientOfVariation(values: readonly number[]): number {
  const average = mean(values);
  return average === 0 ? Number.POSITIVE_INFINITY : standardDeviation(values) / average;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Otsu's method on a 256-bin histogram of the plane. Returns the level `t`
 * that maximizes between-class variance, with the classes defined as
 * `[0..t]` and `[t+1..255]` — so the foreground test below is `value <= t`,
 * not `value < t`. (A two-tone image histogram is exactly where the
 * off-by-one bites: `{0, 255}` yields `t = 0`, and `value < 0` selects
 * nothing.)
 */
function otsuThreshold(plane: Uint8Array): number {
  const histogram = new Float64Array(256);
  for (let index = 0; index < plane.length; index += 1) {
    const value = plane[index] ?? 0;
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  const total = plane.length;
  let sum = 0;
  for (let value = 0; value < 256; value += 1) {
    sum += value * (histogram[value] ?? 0);
  }
  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = -1;
  let bestThreshold = 128;
  for (let value = 0; value < 256; value += 1) {
    weightBackground += histogram[value] ?? 0;
    if (weightBackground === 0) {
      continue;
    }
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) {
      break;
    }
    sumBackground += value * (histogram[value] ?? 0);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = value;
    }
  }
  return bestThreshold;
}

/**
 * Local contrast normalization for low-contrast text (the ALD-068
 * `#7f7f7f on #808080` fixture has a global luminance range of 1). Each block
 * is stretched to `0..255` in its own range; a block with no variation is set
 * to 255, i.e. background, so a flat region never becomes ink.
 */
function normalizeLocally(
  plane: Uint8Array,
  width: number,
  height: number,
  block: number,
): Uint8Array {
  const out = new Uint8Array(plane.length);
  for (let blockTop = 0; blockTop < height; blockTop += block) {
    for (let blockLeft = 0; blockLeft < width; blockLeft += block) {
      const bottom = Math.min(height, blockTop + block);
      const right = Math.min(width, blockLeft + block);
      let minimum = 255;
      let maximum = 0;
      for (let row = blockTop; row < bottom; row += 1) {
        for (let column = blockLeft; column < right; column += 1) {
          const value = plane[row * width + column] ?? 0;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
      const range = maximum - minimum;
      for (let row = blockTop; row < bottom; row += 1) {
        for (let column = blockLeft; column < right; column += 1) {
          const target = row * width + column;
          if (range < 1) {
            out[target] = 255;
          } else {
            out[target] = Math.round((((plane[target] ?? 0) - minimum) * 255) / range);
          }
        }
      }
    }
  }
  return out;
}

function invert(plane: Uint8Array): Uint8Array {
  const out = new Uint8Array(plane.length);
  for (let index = 0; index < plane.length; index += 1) {
    out[index] = 255 - (plane[index] ?? 0);
  }
  return out;
}

function isConstant(plane: Uint8Array): boolean {
  const first = plane[0] ?? 0;
  for (let index = 1; index < plane.length; index += 1) {
    if ((plane[index] ?? 0) !== first) {
      return false;
    }
  }
  return true;
}

/** 8-connected components of the foreground mask. */
function findComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  maxComponents: number,
): Component[] {
  const labels = new Int32Array(mask.length).fill(0);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if ((mask[start] ?? 0) === 0 || (labels[start] ?? 0) !== 0) {
      continue;
    }
    if (components.length >= maxComponents) {
      break;
    }
    const label = components.length + 1;
    labels[start] = label;
    stack.length = 0;
    stack.push(start);
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    let area = 0;
    while (stack.length > 0) {
      const index = stack.pop() ?? 0;
      const row = Math.floor(index / width);
      const column = index % width;
      area += 1;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
      for (let deltaRow = -1; deltaRow <= 1; deltaRow += 1) {
        for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn += 1) {
          const nextRow = row + deltaRow;
          const nextColumn = column + deltaColumn;
          if (nextRow < 0 || nextRow >= height || nextColumn < 0 || nextColumn >= width) {
            continue;
          }
          const next = nextRow * width + nextColumn;
          if ((mask[next] ?? 0) === 1 && (labels[next] ?? 0) === 0) {
            labels[next] = label;
            stack.push(next);
          }
        }
      }
    }
    // Horizontal runs, the stroke-width proxy: the width of a pen stroke is
    // the length of a run of ink across it.
    const runs: number[] = [];
    let occupiedRows = 0;
    for (let row = top; row <= bottom; row += 1) {
      let run = 0;
      let rowHasInk = false;
      for (let column = left; column <= right + 1; column += 1) {
        const inside =
          column <= right && (labels[row * width + column] ?? 0) === label;
        if (inside) {
          run += 1;
          rowHasInk = true;
        } else if (run > 0) {
          runs.push(run);
          run = 0;
        }
      }
      if (rowHasInk) {
        occupiedRows += 1;
      }
    }
    components.push({
      left,
      right,
      top,
      bottom,
      area,
      runs,
      rowCount: occupiedRows,
    });
  }
  return components;
}

interface Cue {
  reason: TextDetectionReason;
  weight: number;
}

const ROW_CUE_WEIGHTS: Record<string, number> = {
  'glyph-count-in-row': 0.2,
  'baseline-aligned-row': 0.25,
  'uniform-glyph-height': 0.2,
  'regular-glyph-spacing': 0.2,
  'consistent-stroke-width': 0.15,
};

/** Least-squares line through the component bottoms, so rotated text still
 * has an "aligned baseline"; the residual, not the slope, is the cue. */
function baselineResidual(components: readonly Component[]): number {
  const xs = components.map((component) => (component.left + component.right) / 2);
  const ys = components.map((component) => component.bottom);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    covariance += dx * ((ys[index] ?? 0) - meanY);
    variance += dx * dx;
  }
  const slope = variance === 0 ? 0 : covariance / variance;
  const intercept = meanY - slope * meanX;
  const residuals = xs.map(
    (x, index) => (ys[index] ?? 0) - (slope * x + intercept),
  );
  return standardDeviation(residuals);
}

function scoreRow(components: readonly Component[]): Cue[] {
  const cues: Cue[] = [];
  const ordered = [...components].sort((left, right) => left.left - right.left);
  const heights = ordered.map((component) => component.bottom - component.top + 1);
  const meanHeight = mean(heights);
  if (ordered.length >= 3) {
    cues.push({
      reason: 'glyph-count-in-row',
      weight: ROW_CUE_WEIGHTS['glyph-count-in-row'] ?? 0,
    });
  }
  if (ordered.length < 3 || meanHeight <= 0) {
    return cues;
  }
  if (baselineResidual(ordered) <= Math.max(1.5, 0.18 * meanHeight)) {
    cues.push({
      reason: 'baseline-aligned-row',
      weight: ROW_CUE_WEIGHTS['baseline-aligned-row'] ?? 0,
    });
  }
  if (coefficientOfVariation(heights) <= 0.3) {
    cues.push({
      reason: 'uniform-glyph-height',
      weight: ROW_CUE_WEIGHTS['uniform-glyph-height'] ?? 0,
    });
  }
  const pitches: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    pitches.push((ordered[index]?.left ?? 0) - (ordered[index - 1]?.left ?? 0));
  }
  if (pitches.length >= 2 && coefficientOfVariation(pitches) <= 0.35) {
    cues.push({
      reason: 'regular-glyph-spacing',
      weight: ROW_CUE_WEIGHTS['regular-glyph-spacing'] ?? 0,
    });
  }
  const strokeWidths = ordered.map((component) => median(component.runs));
  if (
    coefficientOfVariation(strokeWidths) <= 0.45 &&
    mean(strokeWidths) <= 0.6 * meanHeight
  ) {
    cues.push({
      reason: 'consistent-stroke-width',
      weight: ROW_CUE_WEIGHTS['consistent-stroke-width'] ?? 0,
    });
  }
  return cues;
}

/**
 * Single-glyph cue. A lone rendered character is not a row, so the row cues
 * cannot fire; what remains is that a glyph is a constant-width pen path with
 * internal structure (a repeated narrow pen width), a moderate fill of its
 * bounding box, and a character-like aspect ratio. Crossbars and diagonals
 * legitimately create a few long runs, so the test uses the fraction of
 * narrow runs instead of the coefficient of variation across every run.
 * This is the weakest cue in the detector and is scored so that it alone
 * reaches the threshold only when all four sub-conditions hold.
 */
function scoreSingleGlyph(component: Component, imageHeight: number): Cue[] {
  const width = component.right - component.left + 1;
  const height = component.bottom - component.top + 1;
  if (height < 8 || height > 0.95 * imageHeight) {
    return [];
  }
  const aspect = width / height;
  const fill = component.area / (width * height);
  const strokeWidths = component.runs;
  const typicalStroke = median(strokeWidths);
  const narrowRunRatio =
    strokeWidths.length === 0
      ? 0
      : strokeWidths.filter((run) => run <= 1.5 * typicalStroke).length /
        strokeWidths.length;
  const conditions = [
    aspect >= 0.3 && aspect <= 1.7,
    fill >= 0.15 && fill <= 0.72,
    typicalStroke >= 1 && typicalStroke <= 0.45 * width,
    narrowRunRatio >= 0.7,
  ];
  const satisfied = conditions.filter((condition) => condition).length;
  return satisfied === conditions.length
    ? [{ reason: 'rectilinear-glyph-structure', weight: 0.55 }]
    : [];
}

function groupRows(components: readonly Component[]): Component[][] {
  const ordered = [...components].sort((left, right) => left.top - right.top);
  const rows: Component[][] = [];
  for (const component of ordered) {
    const height = component.bottom - component.top + 1;
    let placed = false;
    for (const row of rows) {
      const first = row[0];
      if (first === undefined) {
        continue;
      }
      const rowTop = Math.min(...row.map((entry) => entry.top));
      const rowBottom = Math.max(...row.map((entry) => entry.bottom));
      const overlap =
        Math.min(rowBottom, component.bottom) - Math.max(rowTop, component.top) + 1;
      const smaller = Math.min(height, rowBottom - rowTop + 1);
      if (overlap > 0 && overlap >= 0.5 * smaller) {
        row.push(component);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([component]);
    }
  }
  return rows;
}

export class HeuristicTextDetector implements OcrDetector {
  readonly detectorVersion = DETECTOR_VERSION;
  private readonly threshold: number;
  private readonly lowContrastRange: number;
  private readonly normalizationBlock: number;

  constructor(options: HeuristicTextDetectorOptions = {}) {
    this.threshold = options.threshold ?? 0.35;
    this.lowContrastRange = options.lowContrastRange ?? 32;
    this.normalizationBlock = options.normalizationBlock ?? 16;
  }

  detect(image: DecodedImage): TextDetection {
    const planes: Uint8Array[] = [image.luminance, invert(image.luminance)];
    if (image.alpha !== undefined && !isConstant(image.alpha)) {
      planes.push(image.alpha, invert(image.alpha));
    }
    let best: TextDetection = { textLikely: false, score: 0, reasons: [] };
    for (const plane of planes) {
      const detection = this.detectPlane(plane, image.width, image.height);
      if (detection.score > best.score) {
        best = detection;
      }
    }
    return best;
  }

  private detectPlane(plane: Uint8Array, width: number, height: number): TextDetection {
    if (width < 6 || height < 6) {
      return { textLikely: false, score: 0, reasons: [] };
    }
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < plane.length; index += 1) {
      const value = plane[index] ?? 0;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    if (maximum - minimum < 1) {
      return { textLikely: false, score: 0, reasons: [] };
    }
    const working =
      maximum - minimum < this.lowContrastRange
        ? normalizeLocally(plane, width, height, this.normalizationBlock)
        : plane;
    const threshold = otsuThreshold(working);
    const mask = new Uint8Array(working.length);
    let ink = 0;
    for (let index = 0; index < working.length; index += 1) {
      if ((working[index] ?? 0) <= threshold) {
        mask[index] = 1;
        ink += 1;
      }
    }
    const inkFraction = ink / mask.length;
    // Rendered text covers a small fraction of its canvas; a plane that is
    // almost all ink is a filled shape or an inverted background, not text.
    if (inkFraction < 0.005 || inkFraction > 0.45) {
      return { textLikely: false, score: 0, reasons: [] };
    }

    const imageArea = width * height;
    const components = findComponents(mask, width, height, 4096).filter((component) => {
      const componentWidth = component.right - component.left + 1;
      const componentHeight = component.bottom - component.top + 1;
      const fill = component.area / (componentWidth * componentHeight);
      return (
        component.area >= 4 &&
        componentWidth >= 2 &&
        componentHeight >= 3 &&
        componentHeight <= 0.95 * height &&
        componentWidth <= 0.95 * width &&
        component.area <= 0.25 * imageArea &&
        fill >= 0.08 &&
        fill <= 0.97
      );
    });
    if (components.length === 0) {
      return { textLikely: false, score: 0, reasons: [] };
    }

    let bestCues: Cue[] = [];
    for (const row of groupRows(components)) {
      const cues = scoreRow(row);
      if (sumWeights(cues) > sumWeights(bestCues)) {
        bestCues = cues;
      }
    }
    if (components.length <= 2) {
      for (const component of components) {
        const cues = scoreSingleGlyph(component, height);
        if (sumWeights(cues) > sumWeights(bestCues)) {
          bestCues = cues;
        }
      }
    }
    const score = Math.min(1, sumWeights(bestCues));
    return {
      textLikely: score >= this.threshold,
      score: Math.round(score * 1000) / 1000,
      reasons: bestCues.map((cue) => cue.reason),
    };
  }
}

function sumWeights(cues: readonly Cue[]): number {
  let total = 0;
  for (const cue of cues) {
    total += cue.weight;
  }
  return total;
}

/** A detector that reports nothing; used to isolate the string scans in tests. */
export const NULL_TEXT_DETECTOR: OcrDetector = {
  detectorVersion: 'null-detector-v1',
  detect(): TextDetection {
    return { textLikely: false, score: 0, reasons: [] };
  },
};
