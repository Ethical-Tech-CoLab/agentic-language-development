/**
 * Deterministic PNG writer for the ALD-068 fixture generator.
 *
 * Every byte of a committed fixture must be reproducible by a third party on
 * any machine, because the fixture hashes are what the red-team result object
 * cites (ALD-068 criterion 3). So this writer avoids compression entirely:
 * the zlib stream is built from *stored* (uncompressed) DEFLATE blocks, whose
 * bytes are fixed by the format rather than by the zlib version that happens
 * to be linked into Node. A `deflateSync` at level 9 would also be
 * deterministic on one machine and is not guaranteed to be across zlib
 * releases; stored blocks are. Fixtures stay small (a few KiB each) because
 * they are small images.
 *
 * The writer also emits the malformed variants ALD-068 pre-registers as an
 * attack category — truncated streams, a corrupted CRC, a header declaring
 * absurd dimensions — because a quarantine that only handles well-formed
 * input is not a quarantine.
 */
import { crc32 } from '@ald/scenario';

export type PngTextChunkKind = 'tEXt' | 'zTXt' | 'iTXt';

export interface PngTextChunkInput {
  kind: PngTextChunkKind;
  keyword: string;
  text: string;
  /** iTXt only: the translated-keyword slot, another place text can hide. */
  translatedKeyword?: string;
}

export interface EncodePngOptions {
  /** `IHDR` values written instead of the true ones (giant-dimension attack). */
  declaredDimensions?: { width: number; height: number };
  textChunks?: PngTextChunkInput[];
  /** Flip one bit of the IDAT CRC after the fact. */
  corruptIdatCrc?: boolean;
  /** Keep only the first `n` bytes of the finished file. */
  truncateTo?: number;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const STORED_BLOCK_MAX = 0xff_ff;

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    a = (a + (bytes[index] ?? 0)) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream made of stored DEFLATE blocks: byte-stable everywhere. */
export function storedZlibStream(payload: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  if (payload.length === 0) {
    const empty = Buffer.alloc(5);
    empty[0] = 1;
    empty.writeUInt16LE(0, 1);
    empty.writeUInt16LE(0xff_ff, 3);
    parts.push(empty);
  }
  for (let offset = 0; offset < payload.length; offset += STORED_BLOCK_MAX) {
    const length = Math.min(STORED_BLOCK_MAX, payload.length - offset);
    const header = Buffer.alloc(5);
    header[0] = offset + length >= payload.length ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(length ^ 0xff_ff, 3);
    parts.push(header, Buffer.from(payload.subarray(offset, offset + length)));
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(payload));
  parts.push(checksum);
  return Buffer.concat(parts);
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function textChunkBytes(input: PngTextChunkInput): Buffer {
  const keyword = Buffer.from(input.keyword, 'latin1');
  if (input.kind === 'tEXt') {
    return Buffer.concat([
      keyword,
      Buffer.from([0]),
      Buffer.from(input.text, 'latin1'),
    ]);
  }
  if (input.kind === 'zTXt') {
    return Buffer.concat([
      keyword,
      Buffer.from([0, 0]),
      storedZlibStream(Buffer.from(input.text, 'latin1')),
    ]);
  }
  // iTXt, uncompressed: keyword NUL 0 0 language NUL translated NUL text
  return Buffer.concat([
    keyword,
    Buffer.from([0, 0, 0]),
    Buffer.from('', 'latin1'),
    Buffer.from([0]),
    Buffer.from(input.translatedKeyword ?? '', 'utf8'),
    Buffer.from([0]),
    Buffer.from(input.text, 'utf8'),
  ]);
}

function assemble(
  width: number,
  height: number,
  colorType: 0 | 2,
  raster: Buffer,
  options: EncodePngOptions,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.declaredDimensions?.width ?? width, 0);
  header.writeUInt32BE(options.declaredDimensions?.height ?? height, 4);
  header[8] = 8;
  header[9] = colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const idat = chunk('IDAT', storedZlibStream(raster));
  if (options.corruptIdatCrc === true) {
    const last = idat.length - 1;
    idat[last] = (idat[last] ?? 0) ^ 0x01;
  }
  const parts: Buffer[] = [SIGNATURE, chunk('IHDR', header)];
  for (const text of options.textChunks ?? []) {
    parts.push(chunk(text.kind, textChunkBytes(text)));
  }
  parts.push(idat, chunk('IEND', Buffer.alloc(0)));
  const file = Buffer.concat(parts);
  return options.truncateTo === undefined ? file : file.subarray(0, options.truncateTo);
}

/** Encode an 8-bit grayscale plane (`width * height` bytes) as a PNG. */
export function encodeGrayscalePng(
  width: number,
  height: number,
  plane: Uint8Array,
  options: EncodePngOptions = {},
): Buffer {
  if (plane.length !== width * height) {
    throw new Error(`plane must be ${width * height} bytes, received ${plane.length}`);
  }
  const raster = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raster[row * (width + 1)] = 0; // filter: None, so the bytes stay readable
    for (let column = 0; column < width; column += 1) {
      raster[row * (width + 1) + 1 + column] = plane[row * width + column] ?? 0;
    }
  }
  return assemble(width, height, 0, raster, options);
}

/** Encode an 8-bit RGB image (`width * height * 3` bytes) as a PNG. */
export function encodeRgbPng(
  width: number,
  height: number,
  pixels: Uint8Array,
  options: EncodePngOptions = {},
): Buffer {
  if (pixels.length !== width * height * 3) {
    throw new Error(`pixels must be ${width * height * 3} bytes`);
  }
  const stride = width * 3;
  const raster = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raster[row * (stride + 1)] = 0;
    for (let index = 0; index < stride; index += 1) {
      raster[row * (stride + 1) + 1 + index] = pixels[row * stride + index] ?? 0;
    }
  }
  return assemble(width, height, 2, raster, options);
}
