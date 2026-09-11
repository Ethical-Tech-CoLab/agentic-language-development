/** Handcrafted E13 perceptual-family diagnostics for generated carriers. */
export const CARRIER_PERCEPTION_ANALYSIS_VERSION = 'carrier-perception/v1';

export type BitmapMark = {
  readonly carrier: 'generative-bitmap';
  readonly bits: readonly (0 | 1)[];
};
export type CanvasStroke = {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly width: 1 | 2 | 3;
};
export type CanvasMark = {
  readonly carrier: 'generative-canvas';
  readonly strokes: readonly CanvasStroke[];
};
export type ToneMark = {
  readonly carrier: 'generative-tone';
  readonly tones: readonly { readonly pitchBin: number; readonly durationBin: number }[];
};
export type PerceptualMark = BitmapMark | CanvasMark | ToneMark;

export interface LabeledPerceptualMark {
  readonly id: string;
  readonly family: string;
  readonly mark: PerceptualMark;
}

export interface PerceptualGeneralizationResult {
  readonly analysisVersion: typeof CARRIER_PERCEPTION_ANALYSIS_VERSION;
  readonly carrier: PerceptualMark['carrier'];
  readonly prototypeCount: number;
  readonly queryCount: number;
  readonly families: readonly string[];
  readonly exactNovelQueries: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly predictions: readonly {
    readonly queryId: string;
    readonly expectedFamily: string;
    readonly predictedFamily: string;
    readonly distance: number;
    readonly exactPrototypeMatch: boolean;
  }[];
  readonly claimBoundary: 'handcrafted-distance-diagnostic-only';
}

function fail(message: string): never {
  throw new Error(`carrier-perception: ${message}`);
}

function bitmap(mark: BitmapMark): boolean[] {
  if (mark.bits.length !== 256 || mark.bits.some((bit) => bit !== 0 && bit !== 1)) {
    fail('bitmap must contain exactly 256 binary cells');
  }
  return mark.bits.map(Boolean);
}

function canvas(mark: CanvasMark): boolean[] {
  if (mark.strokes.length < 1 || mark.strokes.length > 8) fail('canvas must contain 1-8 strokes');
  const cells = new Array<boolean>(256).fill(false);
  const paint = (x: number, y: number, radius: number): void => {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < 16 && py >= 0 && py < 16) cells[py * 16 + px] = true;
      }
    }
  };
  for (const stroke of mark.strokes) {
    const values = [stroke.startX, stroke.startY, stroke.endX, stroke.endY];
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 15) || ![1, 2, 3].includes(stroke.width)) fail('canvas stroke is outside the registered grammar');
    let x = stroke.startX;
    let y = stroke.startY;
    const dx = Math.abs(stroke.endX - stroke.startX);
    const sx = stroke.startX < stroke.endX ? 1 : -1;
    const dy = -Math.abs(stroke.endY - stroke.startY);
    const sy = stroke.startY < stroke.endY ? 1 : -1;
    let error = dx + dy;
    while (true) {
      paint(x, y, Math.floor(stroke.width / 2));
      if (x === stroke.endX && y === stroke.endY) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x += sx; }
      if (twice <= dx) { error += dx; y += sy; }
    }
  }
  return cells;
}

function hamming(left: readonly boolean[], right: readonly boolean[]): number {
  return left.filter((value, index) => value !== right[index]).length / left.length;
}

function shiftedHamming(
  left: readonly boolean[],
  right: readonly boolean[],
  shiftX: number,
  shiftY: number,
): number {
  let differences = 0;
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      const rightValue = sourceX >= 0 && sourceX < 16 && sourceY >= 0 && sourceY < 16
        ? (right[sourceY * 16 + sourceX] ?? false)
        : false;
      if ((left[y * 16 + x] ?? false) !== rightValue) differences += 1;
    }
  }
  return differences / 256;
}

function canvasDistance(left: CanvasMark, right: CanvasMark): number {
  const leftRaster = canvas(left);
  const rightRaster = canvas(right);
  let minimum = 1;
  for (let shiftY = -1; shiftY <= 1; shiftY += 1) {
    for (let shiftX = -1; shiftX <= 1; shiftX += 1) {
      minimum = Math.min(minimum, shiftedHamming(leftRaster, rightRaster, shiftX, shiftY));
    }
  }
  return minimum;
}

function validateTone(mark: ToneMark): void {
  if (mark.tones.length < 1 || mark.tones.length > 8) fail('tone marks must contain 1-8 tones');
  for (const tone of mark.tones) {
    if (
      !Number.isInteger(tone.pitchBin)
      || !Number.isInteger(tone.durationBin)
      || tone.pitchBin < 0
      || tone.pitchBin > 7
      || tone.durationBin < 1
      || tone.durationBin > 4
    ) fail('tone is outside the registered grammar');
  }
}

function toneDistance(left: ToneMark, right: ToneMark): number {
  validateTone(left);
  validateTone(right);
  const width = right.tones.length + 1;
  const costs = new Array<number>((left.tones.length + 1) * width).fill(0);
  for (let i = 0; i <= left.tones.length; i += 1) costs[i * width] = i;
  for (let j = 0; j <= right.tones.length; j += 1) costs[j] = j;
  for (let i = 1; i <= left.tones.length; i += 1) {
    for (let j = 1; j <= right.tones.length; j += 1) {
      const a = left.tones[i - 1];
      const b = right.tones[j - 1];
      if (a === undefined || b === undefined) fail('tone sequence index is invalid');
      const substitution = (Math.abs(a.pitchBin - b.pitchBin) / 7 + Math.abs(a.durationBin - b.durationBin) / 3) / 2;
      costs[i * width + j] = Math.min(
        (costs[(i - 1) * width + j] ?? 0) + 1,
        (costs[i * width + j - 1] ?? 0) + 1,
        (costs[(i - 1) * width + j - 1] ?? 0) + substitution,
      );
    }
  }
  return (costs[left.tones.length * width + right.tones.length] ?? 0) / Math.max(left.tones.length, right.tones.length);
}

export function carrierPerceptualDistance(left: PerceptualMark, right: PerceptualMark): number {
  if (left.carrier !== right.carrier) fail('cross-carrier distance is undefined');
  switch (left.carrier) {
    case 'generative-bitmap': return hamming(bitmap(left), bitmap(right as BitmapMark));
    case 'generative-canvas': return canvasDistance(left, right as CanvasMark);
    case 'generative-tone': return toneDistance(left, right as ToneMark);
  }
}

export function evaluatePerceptualGeneralization(input: {
  readonly prototypes: readonly LabeledPerceptualMark[];
  readonly queries: readonly LabeledPerceptualMark[];
}): PerceptualGeneralizationResult {
  if (input.prototypes.length < 2 || input.queries.length < 1) fail('at least two prototypes and one query are required');
  const carrier = input.prototypes[0]?.mark.carrier;
  if (carrier === undefined || [...input.prototypes, ...input.queries].some((row) => row.id.length === 0 || row.family.length === 0 || row.mark.carrier !== carrier)) fail('IDs/families must be non-empty and carriers must match');
  const identifiers = [...input.prototypes, ...input.queries].map((row) => row.id);
  if (new Set(identifiers).size !== identifiers.length) fail('prototype and query IDs must be unique');
  const families = [...new Set(input.prototypes.map((row) => row.family))].sort();
  if (families.length < 2 || input.queries.some((row) => !families.includes(row.family))) fail('at least two prototype families must cover every query');
  const predictions = input.queries.map((query) => {
    const ranked = input.prototypes.map((prototype) => ({
      prototype,
      distance: carrierPerceptualDistance(query.mark, prototype.mark),
    })).sort((left, right) => left.distance - right.distance || left.prototype.family.localeCompare(right.prototype.family) || left.prototype.id.localeCompare(right.prototype.id));
    const nearest = ranked[0];
    if (nearest === undefined) fail('no prototype available');
    return {
      queryId: query.id,
      expectedFamily: query.family,
      predictedFamily: nearest.prototype.family,
      distance: nearest.distance,
      exactPrototypeMatch: JSON.stringify(query.mark) === JSON.stringify(nearest.prototype.mark),
    };
  });
  const correct = predictions.filter((row) => row.expectedFamily === row.predictedFamily).length;
  return {
    analysisVersion: CARRIER_PERCEPTION_ANALYSIS_VERSION,
    carrier,
    prototypeCount: input.prototypes.length,
    queryCount: input.queries.length,
    families,
    exactNovelQueries: predictions.filter((row) => !row.exactPrototypeMatch).length,
    correct,
    accuracy: correct / predictions.length,
    predictions,
    claimBoundary: 'handcrafted-distance-diagnostic-only',
  };
}
