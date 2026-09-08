/**
 * Two embedded synthetic bitmap typefaces for the ALD-068 observation
 * fixtures.
 *
 * Rendering text needs glyph shapes. Taking them from a system font would
 * make the committed fixtures depend on which fonts a machine has installed,
 * and taking them from a canvas library would put a native dependency
 * (`@napi-rs/canvas`) into a package whose whole point is reproducibility. So
 * the glyph outlines live here as data: two hand-written bitmap typefaces,
 * `bitmap-5x7` and `bitmap-3x5`, plus a bold variant produced by horizontal
 * dilation. Combined with the scale factor, that gives the "several fonts and
 * sizes" ALD-068 criterion 1 asks for, with byte-identical output on every
 * machine.
 *
 * These are synthetic typefaces, not real ones. A detector calibrated only
 * against them is calibrated against synthetic text; the `redteam/README.md`
 * states that boundary, and the `TemplateGlyphDetector` seam in
 * `@ald/scenario` is where a real OCR engine plugs in.
 */

export type TypefaceName = 'bitmap-5x7' | 'bitmap-3x5';

export interface Typeface {
  name: TypefaceName;
  glyphWidth: number;
  glyphHeight: number;
  /** Blank columns between glyphs, in unscaled glyph pixels. */
  advance: number;
  glyphs: Readonly<Record<string, readonly string[]>>;
}

const GLYPHS_5X7: Record<string, readonly string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10011', '01111'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
};

const GLYPHS_3X5: Record<string, readonly string[]> = {
  ' ': ['000', '000', '000', '000', '000'],
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '011'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['110', '101', '101', '101', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '111', '011'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '011'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['110', '001', '010', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['011', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '110'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  '_': ['000', '000', '000', '000', '111'],
};

export const TYPEFACES: Readonly<Record<TypefaceName, Typeface>> = {
  'bitmap-5x7': {
    name: 'bitmap-5x7',
    glyphWidth: 5,
    glyphHeight: 7,
    advance: 1,
    glyphs: GLYPHS_5X7,
  },
  'bitmap-3x5': {
    name: 'bitmap-3x5',
    glyphWidth: 3,
    glyphHeight: 5,
    advance: 1,
    glyphs: GLYPHS_3X5,
  },
};

/** A 1-bit text mask: `mask[row * width + column]` is 1 where ink falls. */
export interface GlyphMask {
  width: number;
  height: number;
  mask: Uint8Array;
}

export interface TextMaskOptions {
  typeface?: TypefaceName;
  /** Integer pixel scale of one glyph pixel. */
  scale?: number;
  /** Dilate one pixel to the right, thickening every stroke. */
  bold?: boolean;
}

/**
 * Rasterize `text` into a tight 1-bit mask. Unknown characters render as a
 * blank advance rather than throwing: a fixture must never fail to build
 * because of a missing glyph.
 */
export function textMask(text: string, options: TextMaskOptions = {}): GlyphMask {
  const typeface = TYPEFACES[options.typeface ?? 'bitmap-5x7'];
  const scale = Math.max(1, Math.trunc(options.scale ?? 1));
  const bold = options.bold === true;
  const characters = [...text.toUpperCase()];
  const cell = typeface.glyphWidth + typeface.advance;
  const width = Math.max(1, (characters.length * cell - typeface.advance) * scale);
  const height = typeface.glyphHeight * scale;
  const mask = new Uint8Array(width * height);
  characters.forEach((character, position) => {
    const rows = typeface.glyphs[character] ?? typeface.glyphs[' '] ?? [];
    for (let glyphRow = 0; glyphRow < typeface.glyphHeight; glyphRow += 1) {
      const rowBits = rows[glyphRow] ?? '';
      for (let glyphColumn = 0; glyphColumn < typeface.glyphWidth; glyphColumn += 1) {
        const lit =
          rowBits[glyphColumn] === '1' ||
          (bold && glyphColumn > 0 && rowBits[glyphColumn - 1] === '1');
        if (!lit) {
          continue;
        }
        const originX = (position * cell + glyphColumn) * scale;
        const originY = glyphRow * scale;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = originX + dx;
            const y = originY + dy;
            if (x < width && y < height) {
              mask[y * width + x] = 1;
            }
          }
        }
      }
    }
  });
  return { width, height, mask };
}
