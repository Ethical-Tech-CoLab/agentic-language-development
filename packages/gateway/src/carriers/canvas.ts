/**
 * `generative-canvas` protocol module (SPECIFICATION.md §9.2, ALD-031).
 *
 * §9.2's default grammar, verbatim: a stroke is
 * `{ startX, startY, endX, endY }` as integers on the 0-15 quantized grid
 * plus `width: 1 | 2 | 3` ("quantized pen width, no color channel"), and a
 * proposal is `{ strokes: Stroke[] }` with `strokes.length <= maxStrokes`
 * (default 8, absolute ceiling 64).
 *
 * Two decisions worth stating outright, both recorded as BACKLOG §15
 * decisions:
 *
 * 1. **Degenerate zero-length strokes are accepted.** A stroke whose start
 *    equals its end is a dot of the given pen width. §9.2's grammar "only
 *    bounds what can be physically expressed" and a dot is inside those
 *    bounds; rejecting it would be the Gateway making a judgement about the
 *    *content* of a mark rather than its form, which §9.2 and §4.2 both
 *    forbid. A dot is also the smallest mark a Baby can invent, so refusing
 *    it would quietly remove the lowest rung of the E13 form inventory. The
 *    normalized artifact keeps such a stroke verbatim, so its `markHash` is
 *    stable and analysis can count dots like any other form.
 * 2. **Per-stroke extra fields are rejected, never stripped.** A `color`,
 *    `pressure`, or `label` key on a stroke is `free-text-present` when it
 *    holds a string anywhere and `unexpected-artifact-field` otherwise. §9.2
 *    is explicit that this carrier has no color or text field, and §10.2
 *    forbids sanitizing prohibited content and passing it through.
 */
import type { CarrierModule } from '../carrier-modules.js';
import { extraFieldFailure, fail } from '../carrier-modules.js';
import {
  ABSOLUTE_MAX_STROKES,
  CANVAS_GRID_MAX,
  CANVAS_GRID_MIN,
  isGridCoordinate,
  isStrokeWidth,
  maxStrokesFor,
} from './bounds.js';
import { assertNoStrings, readCarrierArtifact } from './marks.js';
import { isPlainObject } from '../inspect.js';

/** Exactly the five fields SPEC §9.2's `Stroke` declares, in that order. */
const STROKE_FIELDS = ['startX', 'startY', 'endX', 'endY', 'width'] as const;

const COORDINATE_FIELDS = ['startX', 'startY', 'endX', 'endY'] as const;

interface NormalizedStroke {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: 1 | 2 | 3;
}

export const generativeCanvasModule: CarrierModule = {
  carrier: 'generative-canvas',
  allowedKinds: ['emit_canvas'],

  validate(proposal, context) {
    const read = readCarrierArtifact(proposal, 'strokes');
    if (!read.ok) {
      return read.failure;
    }

    // SPEC §9.2: "no color channel", and §9.1 rejects any accompanying free
    // text. The stroke grammar is numeric only, so a string anywhere inside
    // the stroke list is free text whatever key it hides under.
    const text = assertNoStrings(read.value, 'publicArtifact.strokes');
    if (text !== undefined) {
      return text;
    }

    const strokes = read.value;
    if (!Array.isArray(strokes)) {
      return fail('invalid-envelope', 'publicArtifact.strokes is not an array');
    }
    if (strokes.length === 0) {
      return fail('empty-message', 'publicArtifact.strokes is empty');
    }
    const cap = maxStrokesFor(context.runContext.config);
    if (strokes.length > cap) {
      return fail(
        'too-many-strokes',
        `message carries ${strokes.length} strokes; the cap is ${cap} (ceiling ${ABSOLUTE_MAX_STROKES})`,
      );
    }

    const normalized: NormalizedStroke[] = [];
    for (let index = 0; index < strokes.length; index += 1) {
      const stroke: unknown = strokes[index];
      if (!isPlainObject(stroke)) {
        return fail('invalid-envelope', `stroke at index ${index} is not an object`);
      }
      const extraKeys = Object.keys(stroke).filter(
        (key) => !(STROKE_FIELDS as readonly string[]).includes(key),
      );
      if (extraKeys.length > 0) {
        return extraFieldFailure(stroke, extraKeys, `strokes[${index}]`);
      }
      for (const field of COORDINATE_FIELDS) {
        if (!isGridCoordinate(stroke[field])) {
          return fail(
            'stroke-out-of-range',
            `strokes[${index}].${field} is outside the integer grid [${CANVAS_GRID_MIN}, ${CANVAS_GRID_MAX}]`,
          );
        }
      }
      if (!isStrokeWidth(stroke.width)) {
        return fail(
          'stroke-width-invalid',
          `strokes[${index}].width is not one of the quantized widths 1, 2, 3`,
        );
      }
      normalized.push({
        startX: stroke.startX as number,
        startY: stroke.startY as number,
        endX: stroke.endX as number,
        endY: stroke.endY as number,
        width: stroke.width,
      });
    }

    return { ok: true, artifact: { strokes: normalized } };
  },

  /**
   * Uniform stroke count in `[1, maxStrokes]`, then uniform endpoints and pen
   * width per stroke — count first, exactly as the fixed-token module draws
   * its length first, so one seed gives comparable §9.6 `random` streams
   * across runs that differ only in `maxStrokes`.
   */
  randomArtifact(prng, context) {
    const cap = maxStrokesFor(context.runContext.config);
    const count = 1 + prng.nextInt(cap);
    const strokes = Array.from({ length: count }, () => ({
      startX: prng.nextInt(CANVAS_GRID_MAX + 1),
      startY: prng.nextInt(CANVAS_GRID_MAX + 1),
      endX: prng.nextInt(CANVAS_GRID_MAX + 1),
      endY: prng.nextInt(CANVAS_GRID_MAX + 1),
      width: (prng.nextInt(3) + 1) as 1 | 2 | 3,
    }));
    return { strokes };
  },

  /**
   * SPEC §9.6 `constant` default: one minimal stroke — a width-1 dot at the
   * grid origin. It is the smallest artifact the grammar admits, and it makes
   * the `constant` control visibly distinct from any drawn form. Recorded as a
   * BACKLOG §15 decision.
   */
  constantArtifact() {
    return {
      strokes: [
        {
          startX: CANVAS_GRID_MIN,
          startY: CANVAS_GRID_MIN,
          endX: CANVAS_GRID_MIN,
          endY: CANVAS_GRID_MIN,
          width: 1 as const,
        },
      ],
    };
  },
};
