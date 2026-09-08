/**
 * Deterministic image renderers for the ALD-068 fixtures.
 *
 * Two families:
 *
 * - **Positives** — planes that carry rendered human language, in the exact
 *   evasion forms EXPERIMENT-NOTEBOOK.md E02 and BACKLOG ALD-068 name: plain
 *   text at several sizes and typefaces, text at a luminance contrast of one
 *   step (`#7f7f7f` on `#808080`), rotated and sheared text, and single
 *   characters.
 * - **Negatives** — text-free controls: blank, seeded noise, filled shapes,
 *   and the SPEC §9.2-style random bounded strokes that the unfamiliar-glyph
 *   carrier bundle uses. These are the fixtures that MUST keep loading
 *   (ALD-039 criterion 2), so they are drawn with the same seeded PRNG the
 *   rest of the system uses and are therefore reproducible.
 *
 * Everything is drawn into an 8-bit grayscale plane with `SeededPrng`, no
 * wall clock and no ambient randomness, so a fixture's bytes are a function
 * of its definition alone.
 */
import { SeededPrng } from '@ald/hashing';

import { textMask, type TextMaskOptions } from './bitmap-font.js';

export interface Plane {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function blankPlane(width: number, height: number, value = 255): Plane {
  const pixels = new Uint8Array(width * height).fill(value);
  return { width, height, pixels };
}

export interface DrawTextOptions extends TextMaskOptions {
  /** Top-left corner of the (untransformed) text block. */
  x?: number;
  y?: number;
  foreground?: number;
  /** Clockwise rotation about the text block's centre, in degrees. */
  rotationDegrees?: number;
  /** Horizontal shear: `x' = x + skewX * y`. */
  skewX?: number;
}

/**
 * Draw `text` into `plane`. Rotation and shear are applied by inverse
 * mapping with nearest-neighbour sampling, which keeps the result exactly
 * reproducible (no anti-aliasing, no floating-point accumulation across
 * pixels) while still defeating a detector that assumes a horizontal
 * baseline.
 */
export function drawText(plane: Plane, text: string, options: DrawTextOptions = {}): Plane {
  const glyphs = textMask(text, options);
  const foreground = options.foreground ?? 0;
  const offsetX = options.x ?? 0;
  const offsetY = options.y ?? 0;
  const radians = ((options.rotationDegrees ?? 0) * Math.PI) / 180;
  const skewX = options.skewX ?? 0;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centreX = glyphs.width / 2;
  const centreY = glyphs.height / 2;

  for (let row = 0; row < plane.height; row += 1) {
    for (let column = 0; column < plane.width; column += 1) {
      // Destination → text-block coordinates (the inverse transform).
      const localX = column - offsetX - centreX;
      const localY = row - offsetY - centreY;
      const unrotatedX = localX * cos + localY * sin;
      const unrotatedY = -localX * sin + localY * cos;
      const sourceX = Math.round(unrotatedX - skewX * unrotatedY + centreX);
      const sourceY = Math.round(unrotatedY + centreY);
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= glyphs.width ||
        sourceY >= glyphs.height
      ) {
        continue;
      }
      if ((glyphs.mask[sourceY * glyphs.width + sourceX] ?? 0) === 1) {
        plane.pixels[row * plane.width + column] = foreground;
      }
    }
  }
  return plane;
}

export interface TextPlaneOptions extends DrawTextOptions {
  width: number;
  height: number;
  background?: number;
  /** Uniform ±amplitude noise added after the text, for OCR evasion. */
  noise?: { amplitude: number; seed: string };
}

/** A grayscale plane containing exactly one rendered line of text. */
export function renderTextPlane(text: string, options: TextPlaneOptions): Plane {
  const plane = blankPlane(options.width, options.height, options.background ?? 255);
  drawText(plane, text, options);
  if (options.noise !== undefined) {
    addNoise(plane, options.noise.seed, options.noise.amplitude);
  }
  return plane;
}

/** Add bounded, seeded noise in place. */
export function addNoise(plane: Plane, seed: string, amplitude: number): Plane {
  const prng = new SeededPrng(seed);
  for (let index = 0; index < plane.pixels.length; index += 1) {
    const delta = prng.nextInt(2 * amplitude + 1) - amplitude;
    const value = (plane.pixels[index] ?? 0) + delta;
    plane.pixels[index] = Math.max(0, Math.min(255, value));
  }
  return plane;
}

/** Text-free control: uniform seeded noise. */
export function renderNoisePlane(width: number, height: number, seed: string): Plane {
  const prng = new SeededPrng(seed);
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = prng.nextInt(256);
  }
  return { width, height, pixels };
}

/** Text-free control: a smooth horizontal luminance ramp. */
export function renderGradientPlane(width: number, height: number): Plane {
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      pixels[row * width + column] = Math.round((column * 255) / Math.max(1, width - 1));
    }
  }
  return { width, height, pixels };
}

function fillRectangle(
  plane: Plane,
  left: number,
  top: number,
  right: number,
  bottom: number,
  value: number,
): void {
  for (let row = Math.max(0, top); row <= Math.min(plane.height - 1, bottom); row += 1) {
    for (
      let column = Math.max(0, left);
      column <= Math.min(plane.width - 1, right);
      column += 1
    ) {
      plane.pixels[row * plane.width + column] = value;
    }
  }
}

function fillDisc(plane: Plane, cx: number, cy: number, radius: number, value: number): void {
  for (let row = 0; row < plane.height; row += 1) {
    for (let column = 0; column < plane.width; column += 1) {
      const dx = column - cx;
      const dy = row - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        plane.pixels[row * plane.width + column] = value;
      }
    }
  }
}

/** Text-free control: seeded filled discs and rectangles. */
export function renderShapesPlane(width: number, height: number, seed: string): Plane {
  const plane = blankPlane(width, height, 235);
  const prng = new SeededPrng(seed);
  const shapes = 3 + prng.nextInt(3);
  for (let index = 0; index < shapes; index += 1) {
    const value = prng.nextInt(140);
    if (prng.nextInt(2) === 0) {
      const radius = 4 + prng.nextInt(Math.max(2, Math.floor(height / 3)));
      fillDisc(plane, prng.nextInt(width), prng.nextInt(height), radius, value);
    } else {
      const left = prng.nextInt(width);
      const top = prng.nextInt(height);
      fillRectangle(
        plane,
        left,
        top,
        left + 4 + prng.nextInt(Math.max(2, Math.floor(width / 3))),
        top + 4 + prng.nextInt(Math.max(2, Math.floor(height / 3))),
        value,
      );
    }
  }
  return plane;
}

function drawLine(
  plane: Plane,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  value: number,
  thickness: number,
): void {
  const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(fromX + ((toX - fromX) * step) / steps);
    const y = Math.round(fromY + ((toY - fromY) * step) / steps);
    fillRectangle(plane, x, y, x + thickness - 1, y + thickness - 1, value);
  }
}

/**
 * Text-free control in the shape of the SPEC §9.2 unfamiliar-glyph bundle:
 * random bounded polyline strokes on a grid. This is the hardest negative,
 * because it has ink components of glyph-like size — which is exactly why it
 * is a pre-registered control rather than a decoration.
 */
export function renderRandomStrokesPlane(
  width: number,
  height: number,
  seed: string,
): Plane {
  const plane = blankPlane(width, height, 255);
  const prng = new SeededPrng(seed);
  const marks = 4 + prng.nextInt(4);
  for (let mark = 0; mark < marks; mark += 1) {
    const strokes = 1 + prng.nextInt(3);
    let x = prng.nextInt(width);
    let y = prng.nextInt(height);
    for (let stroke = 0; stroke < strokes; stroke += 1) {
      const nextX = Math.max(0, Math.min(width - 1, x + prng.nextInt(21) - 10));
      const nextY = Math.max(0, Math.min(height - 1, y + prng.nextInt(21) - 10));
      drawLine(plane, x, y, nextX, nextY, 0, 1 + prng.nextInt(2));
      x = nextX;
      y = nextY;
    }
  }
  return plane;
}

/** Expand a grayscale plane to RGB with a seeded per-channel tint. */
export function planeToRgb(plane: Plane, seed: string): Uint8Array {
  const prng = new SeededPrng(seed);
  const tint = [prng.nextInt(40), prng.nextInt(40), prng.nextInt(40)];
  const pixels = new Uint8Array(plane.width * plane.height * 3);
  for (let index = 0; index < plane.width * plane.height; index += 1) {
    const value = plane.pixels[index] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[index * 3 + channel] = Math.max(
        0,
        Math.min(255, value - (tint[channel] ?? 0)),
      );
    }
  }
  return pixels;
}
