/**
 * Dependency-free PNG decoder for the observation-hygiene quarantine
 * (ALD-039; SPECIFICATION.md §10.2).
 *
 * §10.2 requires that "any future use of real images MUST pass through OCR
 * detection and quarantine". Detection needs pixels, so the filter needs a
 * decoder — and the decoder is the first place an adversarial asset can
 * attack (a truncated stream, a corrupt CRC, a header declaring 10^10 pixels,
 * or bytes that are not a PNG at all). This module therefore decodes with a
 * budget and fails closed: every malformed input raises a typed
 * `PngDecodeError`, which the caller records as a quarantine finding rather
 * than approving an asset it could not inspect.
 *
 * Deliberately built on `node:zlib` and nothing else. The scenario package
 * stays free of native dependencies (`sharp`, `@napi-rs/canvas`), so a
 * third party reproduces a quarantine decision with a stock Node install, and
 * the decode path is deterministic byte-for-byte.
 *
 * Supported: PNG signature + IHDR/PLTE/tRNS/IDAT/IEND, colour types 0, 2, 3,
 * 4, 6, bit depths 1/2/4/8/16, non-interlaced, all five scanline filters
 * (RFC 2083 §6), and the three text chunk kinds (tEXt, zTXt, iTXt) — which
 * exist here only so the filter can *find* hidden text, never to render it.
 * Interlaced images are rejected as `unsupported-format`: they are not
 * produced by the scenario pipeline, and an un-inspectable asset must
 * quarantine, not pass.
 */
import { inflateSync } from 'node:zlib';

/** Failure modes of {@link decodePng}. Closed union; each one quarantines. */
export type PngDecodeErrorCode =
  | 'not-png'
  | 'truncated'
  | 'crc-mismatch'
  | 'invalid-header'
  | 'dimensions-too-large'
  | 'unsupported-format'
  | 'inflate-failed'
  | 'missing-idat'
  | 'invalid-filter'
  | 'palette-missing'
  | 'data-size-mismatch'
  | 'chunk-invalid';

export class PngDecodeError extends Error {
  constructor(
    readonly code: PngDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** One PNG text chunk. `text` is researcher-facing only (never delivered). */
export interface PngTextChunk {
  chunk: 'tEXt' | 'zTXt' | 'iTXt';
  keyword: string;
  text: string;
}

/**
 * A decoded raster reduced to the two planes a text detector needs:
 * `luminance` (ITU-R BT.601 luma of the colour channels) and `alpha` when the
 * image carries one. Text hidden in the alpha channel is as readable as text
 * hidden in colour, so both planes are exposed and both are scanned.
 */
export interface DecodedImage {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** Row-major luma, `width * height` bytes in `0..255`. */
  luminance: Uint8Array;
  /** Row-major alpha, `width * height` bytes, or `undefined` when opaque. */
  alpha?: Uint8Array;
  textChunks: PngTextChunk[];
}

export interface PngDecodeOptions {
  /** Reject an image declaring a larger width or height. Default 4096. */
  maxDimension?: number;
  /** Reject an image declaring more pixels than this. Default 2^22. */
  maxPixels?: number;
  /** Reject an inflated raster larger than this many bytes. Default 64 MiB. */
  maxRasterBytes?: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_DIMENSION = 4096;
const DEFAULT_MAX_PIXELS = 1 << 22;
const DEFAULT_MAX_RASTER_BYTES = 64 * 1024 * 1024;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 as specified by RFC 2083 §5 (chunk type + chunk data). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const slot = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = slot ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

interface RawChunk {
  type: string;
  data: Buffer;
}

function readChunks(bytes: Buffer): RawChunk[] {
  const chunks: RawChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new PngDecodeError('truncated', 'chunk header is incomplete');
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new PngDecodeError('chunk-invalid', 'chunk type is not four letters');
    }
    if (length > bytes.length) {
      throw new PngDecodeError('truncated', `chunk ${type} declares ${length} bytes`);
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new PngDecodeError('truncated', `chunk ${type} data is incomplete`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const declared = bytes.readUInt32BE(dataEnd);
    const actual = crc32(bytes.subarray(offset + 4, dataEnd));
    if (declared !== actual) {
      throw new PngDecodeError('crc-mismatch', `chunk ${type} CRC does not match`);
    }
    chunks.push({ type, data: Buffer.from(data) });
    offset = dataEnd + 4;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) {
    throw new PngDecodeError('truncated', 'stream ends before IEND');
  }
  return chunks;
}

function splitAtNul(data: Buffer, from: number): { head: string; next: number } {
  const index = data.indexOf(0, from);
  if (index < 0) {
    throw new PngDecodeError('chunk-invalid', 'text chunk has no NUL separator');
  }
  return { head: data.toString('latin1', from, index), next: index + 1 };
}

function decodeTextChunk(type: string, data: Buffer): PngTextChunk {
  if (type === 'tEXt') {
    const { head, next } = splitAtNul(data, 0);
    return { chunk: 'tEXt', keyword: head, text: data.toString('latin1', next) };
  }
  if (type === 'zTXt') {
    const { head, next } = splitAtNul(data, 0);
    const method = data[next];
    if (method !== 0) {
      throw new PngDecodeError('unsupported-format', 'zTXt compression method');
    }
    let text = '';
    try {
      text = inflateSync(data.subarray(next + 1)).toString('latin1');
    } catch {
      throw new PngDecodeError('inflate-failed', 'zTXt payload does not inflate');
    }
    return { chunk: 'zTXt', keyword: head, text };
  }
  // iTXt: keyword NUL flag method languageTag NUL translatedKeyword NUL text
  const keywordPart = splitAtNul(data, 0);
  const compressionFlag = data[keywordPart.next];
  const compressionMethod = data[keywordPart.next + 1];
  if (compressionFlag === undefined || compressionMethod === undefined) {
    throw new PngDecodeError('chunk-invalid', 'iTXt header is incomplete');
  }
  const language = splitAtNul(data, keywordPart.next + 2);
  const translated = splitAtNul(data, language.next);
  const payload = data.subarray(translated.next);
  let text: string;
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      throw new PngDecodeError('unsupported-format', 'iTXt compression method');
    }
    try {
      text = inflateSync(payload).toString('utf8');
    } catch {
      throw new PngDecodeError('inflate-failed', 'iTXt payload does not inflate');
    }
  } else {
    text = payload.toString('utf8');
  }
  return {
    chunk: 'iTXt',
    keyword: keywordPart.head,
    // The translated keyword is authored text too, so it is scanned as well.
    text: translated.head === '' ? text : `${translated.head} ${text}`,
  };
}

function unfilter(
  raster: Buffer,
  height: number,
  bytesPerLine: number,
  bytesPerPixel: number,
): Buffer {
  const expected = (bytesPerLine + 1) * height;
  if (raster.length < expected) {
    throw new PngDecodeError(
      'data-size-mismatch',
      `inflated raster is ${raster.length} bytes, expected ${expected}`,
    );
  }
  const out = Buffer.alloc(bytesPerLine * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raster[row * (bytesPerLine + 1)] ?? 0;
    const lineStart = row * (bytesPerLine + 1) + 1;
    const outStart = row * bytesPerLine;
    const prevStart = outStart - bytesPerLine;
    for (let index = 0; index < bytesPerLine; index += 1) {
      const value = raster[lineStart + index] ?? 0;
      const left = index >= bytesPerPixel ? (out[outStart + index - bytesPerPixel] ?? 0) : 0;
      const up = row > 0 ? (out[prevStart + index] ?? 0) : 0;
      const upLeft =
        row > 0 && index >= bytesPerPixel ? (out[prevStart + index - bytesPerPixel] ?? 0) : 0;
      let result: number;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4: {
          const predictor = left + up - upLeft;
          const distanceLeft = Math.abs(predictor - left);
          const distanceUp = Math.abs(predictor - up);
          const distanceUpLeft = Math.abs(predictor - upLeft);
          const paeth =
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft;
          result = value + paeth;
          break;
        }
        default:
          throw new PngDecodeError('invalid-filter', `scanline filter ${filter}`);
      }
      out[outStart + index] = result & 0xff;
    }
  }
  return out;
}

/** Read the `index`-th sample of a packed scanline (MSB-first, RFC 2083 §7). */
function sampleAt(line: Buffer, index: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return line[index] ?? 0;
  }
  if (bitDepth === 16) {
    return line[index * 2] ?? 0;
  }
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)] ?? 0;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  const mask = (1 << bitDepth) - 1;
  return (byte >> shift) & mask;
}

function scaleSample(value: number, bitDepth: number): number {
  switch (bitDepth) {
    case 1:
      return value === 0 ? 0 : 255;
    case 2:
      return value * 85;
    case 4:
      return value * 17;
    default:
      return value;
  }
}

function luma(red: number, green: number, blue: number): number {
  return (red * 77 + green * 150 + blue * 29) >> 8;
}

/**
 * Decode a PNG into luminance (and alpha) planes plus its text chunks.
 * Throws `PngDecodeError` for every malformed or unsupported input; the
 * quarantine treats each code as a finding (fail closed).
 */
export function decodePng(bytes: Uint8Array, options: PngDecodeOptions = {}): DecodedImage {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxRasterBytes = options.maxRasterBytes ?? DEFAULT_MAX_RASTER_BYTES;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (buffer.length < PNG_SIGNATURE.length + 12) {
    throw new PngDecodeError('not-png', 'input is shorter than a minimal PNG');
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new PngDecodeError('not-png', 'PNG signature is absent');
  }

  const chunks = readChunks(buffer);
  const header = chunks[0];
  if (header === undefined || header.type !== 'IHDR' || header.data.length !== 13) {
    throw new PngDecodeError('invalid-header', 'first chunk is not a 13-byte IHDR');
  }
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8] ?? 0;
  const colorType = header.data[9] ?? 0;
  const compression = header.data[10] ?? 0;
  const filterMethod = header.data[11] ?? 0;
  const interlace = header.data[12] ?? 0;

  if (width === 0 || height === 0) {
    throw new PngDecodeError('invalid-header', 'IHDR declares a zero dimension');
  }
  if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
    throw new PngDecodeError(
      'dimensions-too-large',
      `IHDR declares ${width}x${height}, beyond the decode budget`,
    );
  }
  if (compression !== 0 || filterMethod !== 0) {
    throw new PngDecodeError('unsupported-format', 'non-zero compression/filter method');
  }
  if (interlace !== 0) {
    throw new PngDecodeError('unsupported-format', 'interlaced PNG is not inspected');
  }

  const channelsByColorType: Record<number, number | undefined> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) {
    throw new PngDecodeError('unsupported-format', `colour type ${colorType}`);
  }
  const allowedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!(allowedDepths[colorType] ?? []).includes(bitDepth)) {
    throw new PngDecodeError(
      'unsupported-format',
      `bit depth ${bitDepth} for colour type ${colorType}`,
    );
  }

  const idatParts: Buffer[] = [];
  const textChunks: PngTextChunk[] = [];
  let palette: Buffer | undefined;
  let paletteAlpha: Buffer | undefined;
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'IDAT':
        idatParts.push(chunk.data);
        break;
      case 'PLTE':
        palette = chunk.data;
        break;
      case 'tRNS':
        paletteAlpha = chunk.data;
        break;
      case 'tEXt':
      case 'zTXt':
      case 'iTXt':
        textChunks.push(decodeTextChunk(chunk.type, chunk.data));
        break;
      default:
        break;
    }
  }
  if (idatParts.length === 0) {
    throw new PngDecodeError('missing-idat', 'no IDAT chunk');
  }
  if (colorType === 3 && palette === undefined) {
    throw new PngDecodeError('palette-missing', 'colour type 3 without PLTE');
  }

  const bitsPerPixel = channels * bitDepth;
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  if ((bytesPerLine + 1) * height > maxRasterBytes) {
    throw new PngDecodeError('dimensions-too-large', 'raster exceeds the decode budget');
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts), { maxOutputLength: maxRasterBytes });
  } catch {
    throw new PngDecodeError('inflate-failed', 'IDAT stream does not inflate');
  }

  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const raster = unfilter(inflated, height, bytesPerLine, bytesPerPixel);

  const luminance = new Uint8Array(width * height);
  const alpha = new Uint8Array(width * height);
  let sawAlpha = false;
  for (let row = 0; row < height; row += 1) {
    const line = raster.subarray(row * bytesPerLine, (row + 1) * bytesPerLine);
    for (let column = 0; column < width; column += 1) {
      const base = column * channels;
      const target = row * width + column;
      let value = 0;
      let opacity = 255;
      switch (colorType) {
        case 0:
          value = scaleSample(sampleAt(line, base, bitDepth), bitDepth);
          break;
        case 4:
          value = scaleSample(sampleAt(line, base, bitDepth), bitDepth);
          opacity = scaleSample(sampleAt(line, base + 1, bitDepth), bitDepth);
          break;
        case 2:
          value = luma(
            scaleSample(sampleAt(line, base, bitDepth), bitDepth),
            scaleSample(sampleAt(line, base + 1, bitDepth), bitDepth),
            scaleSample(sampleAt(line, base + 2, bitDepth), bitDepth),
          );
          break;
        case 6:
          value = luma(
            scaleSample(sampleAt(line, base, bitDepth), bitDepth),
            scaleSample(sampleAt(line, base + 1, bitDepth), bitDepth),
            scaleSample(sampleAt(line, base + 2, bitDepth), bitDepth),
          );
          opacity = scaleSample(sampleAt(line, base + 3, bitDepth), bitDepth);
          break;
        default: {
          const index = sampleAt(line, base, bitDepth);
          const entry = (palette ?? Buffer.alloc(0)).subarray(index * 3, index * 3 + 3);
          if (entry.length < 3) {
            throw new PngDecodeError('palette-missing', `palette index ${index} is absent`);
          }
          value = luma(entry[0] ?? 0, entry[1] ?? 0, entry[2] ?? 0);
          opacity = paletteAlpha?.[index] ?? 255;
          break;
        }
      }
      luminance[target] = value;
      alpha[target] = opacity;
      if (opacity !== 255) {
        sawAlpha = true;
      }
    }
  }

  const image: DecodedImage = {
    width,
    height,
    bitDepth,
    colorType,
    luminance,
    textChunks,
  };
  if (sawAlpha) {
    image.alpha = alpha;
  }
  return image;
}
