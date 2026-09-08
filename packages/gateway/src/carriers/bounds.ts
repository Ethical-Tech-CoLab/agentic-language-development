/**
 * The frozen physical grammars of the SPECIFICATION.md §9.2 alternate
 * carriers (ALD-031).
 *
 * Every bound here is transcribed from §9.2's table and its TypeScript
 * listing, and duplicated nowhere else in this package: the carrier modules,
 * the §9.6 control artifacts, the glyph bundle generator, and the ALD-036
 * conformance vectors all read these constants, so a bound cannot drift
 * between the validator that enforces it and the vector that tests it.
 *
 * A carrier "supplies a bounded physical grammar but no semantic inventory"
 * (§9.2): nothing in this file names a meaning, a color, or a label. It only
 * says how much can be physically expressed.
 */
import type { RunConfig } from '@ald/types';

/** SPEC §9.2: the monochrome bitmap grid, `gridWidth * gridHeight` defaults. */
export const BITMAP_GRID_WIDTH = 16;
export const BITMAP_GRID_HEIGHT = 16;
/** SPEC §9.2 `generative-bitmap`: exactly 256 bits, never fewer, never more. */
export const BITMAP_BIT_COUNT = BITMAP_GRID_WIDTH * BITMAP_GRID_HEIGHT;

/** SPEC §9.2 `generative-canvas`: the quantized stroke grid is 0-15 per axis. */
export const CANVAS_GRID_MIN = 0;
export const CANVAS_GRID_MAX = 15;
/** SPEC §9.2: quantized pen widths, no color channel. */
export const CANVAS_STROKE_WIDTHS: readonly [1, 2, 3] = [1, 2, 3];
/** SPEC §9.2 default `maxStrokes`. */
export const DEFAULT_MAX_STROKES = 8;
/** SPEC §9.2 / §18: the absolute ceiling regardless of configuration. */
export const ABSOLUTE_MAX_STROKES = 64;

/** SPEC §9.2 `generative-tone`: at most eight quantized tones per message. */
export const MAX_TONES = 8;
/** SPEC §9.2: eight pitch bins, `0`-`7`. */
export const TONE_PITCH_BINS = 8;
/** SPEC §9.2: four duration bins, `1`-`4`. */
export const TONE_DURATION_BINS = 4;

/** SPEC §9.1/§9.2 default inventory size for the two symbolic carriers. */
export const DEFAULT_SYMBOL_INVENTORY_SIZE = 32;

/**
 * Effective stroke cap: the configured `maxStrokes` clamped to the §9.2
 * ceiling, mirroring how `maxSymbolsFor` clamps `maxSymbolsPerMessage`. A
 * run that configures a larger value gets the ceiling, not an error, because
 * `RunConfigSchema` already refuses anything above 64.
 */
export function maxStrokesFor(config: Pick<RunConfig, 'maxStrokes'>): number {
  return Math.min(config.maxStrokes ?? DEFAULT_MAX_STROKES, ABSOLUTE_MAX_STROKES);
}

/** `true` for an integer inside the closed quantized grid range. */
export function isGridCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CANVAS_GRID_MIN &&
    value <= CANVAS_GRID_MAX
  );
}

/** `true` for one of the three quantized pen widths. */
export function isStrokeWidth(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

/** `true` for a `0`-`7` pitch bin. */
export function isPitchBin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < TONE_PITCH_BINS
  );
}

/** `true` for a `1`-`4` duration bin. */
export function isDurationBin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TONE_DURATION_BINS
  );
}

/** `true` for the literal bit values `0` and `1`. */
export function isBit(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}
