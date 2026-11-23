import type { ImageType } from './sniff.js';

export interface Dimensions {
  width: number;
  height: number;
}

const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const GIF_WIDTH_OFFSET = 6;
const GIF_HEIGHT_OFFSET = 8;
const ICO_COUNT_OFFSET = 4;
const ICO_ENTRIES_OFFSET = 6;
const ICO_ENTRY_SIZE = 16;
/** In an ICO directory, a stored size of 0 means 256 pixels. */
const ICO_ZERO_MEANS = 256;
const JPEG_MARKER_PREFIX = 0xff;
/** JPEG start-of-frame markers, which carry the image size; C4, C8 and CC are other segment types. */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_FIRST_SEGMENT = 2;
const WEBP_CHUNK_OFFSET = 12;
const WEBP_DATA_OFFSET = 20;
const FOURTEEN_BITS = 0x3fff;
const TWENTY_FOUR_BIT_MULTIPLIER = 0x10000;

/** Width and height of a PNG, from its IHDR chunk. */
function pngDimensions(bytes: Buffer): Dimensions | null {
  return bytes.length >= PNG_HEIGHT_OFFSET + 4
    ? { width: bytes.readUInt32BE(PNG_WIDTH_OFFSET), height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET) }
    : null;
}

/** Width and height of a GIF, from its logical screen descriptor. */
function gifDimensions(bytes: Buffer): Dimensions | null {
  return bytes.length >= GIF_HEIGHT_OFFSET + 2
    ? { width: bytes.readUInt16LE(GIF_WIDTH_OFFSET), height: bytes.readUInt16LE(GIF_HEIGHT_OFFSET) }
    : null;
}

/** Width and height of the largest image in an ICO file. */
function icoDimensions(bytes: Buffer): Dimensions | null {
  let largest: Dimensions | null = null;
  const count = bytes.length >= ICO_ENTRIES_OFFSET ? bytes.readUInt16LE(ICO_COUNT_OFFSET) : 0;
  for (let index = 0; index < count; index += 1) {
    const offset = ICO_ENTRIES_OFFSET + (index * ICO_ENTRY_SIZE);
    if (offset + 2 <= bytes.length) {
      const width = bytes.readUInt8(offset) || ICO_ZERO_MEANS;
      const height = bytes.readUInt8(offset + 1) || ICO_ZERO_MEANS;
      if (largest === null || width * height > largest.width * largest.height) {
        largest = { width, height };
      }
    }
  }
  return largest;
}

/** Width and height of a JPEG, from its first start-of-frame segment. */
function jpegDimensions(bytes: Buffer): Dimensions | null {
  let offset = JPEG_FIRST_SEGMENT;
  let found: Dimensions | null = null;
  while (found === null && offset + 9 < bytes.length) {
    if (bytes.readUInt8(offset) !== JPEG_MARKER_PREFIX) {
      break;
    }
    const marker = bytes.readUInt8(offset + 1);
    const length = bytes.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      found = { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return found;
}

/** Width and height of a WebP, from its VP8, VP8L or VP8X chunk. */
function webpDimensions(bytes: Buffer): Dimensions | null {
  const chunk = bytes.subarray(WEBP_CHUNK_OFFSET, WEBP_CHUNK_OFFSET + 4).toString('latin1');
  const data = WEBP_DATA_OFFSET;
  let dimensions: Dimensions | null = null;
  if (chunk === 'VP8 ' && bytes.length >= data + 10) {
    dimensions = { width: bytes.readUInt16LE(data + 6) & FOURTEEN_BITS, height: bytes.readUInt16LE(data + 8) & FOURTEEN_BITS };
  } else if (chunk === 'VP8L' && bytes.length >= data + 5) {
    const bits = bytes.readUInt32LE(data + 1);
    dimensions = { width: (bits & FOURTEEN_BITS) + 1, height: ((bits >>> 14) & FOURTEEN_BITS) + 1 };
  } else if (chunk === 'VP8X' && bytes.length >= data + 10) {
    const readUInt24 = (at: number): number => bytes.readUInt16LE(at) + (bytes.readUInt8(at + 2) * TWENTY_FOUR_BIT_MULTIPLIER);
    dimensions = { width: readUInt24(data + 4) + 1, height: readUInt24(data + 7) + 1 };
  }
  return dimensions;
}

/** Reads an image's pixel size from its header, without decoding it. Null for SVG (it has no fixed size) or a bad header. */
export function imageDimensions(bytes: Buffer, type: ImageType): Dimensions | null {
  const readers: Record<Exclude<ImageType, 'svg'>, (data: Buffer) => Dimensions | null> = {
    png: pngDimensions,
    gif: gifDimensions,
    ico: icoDimensions,
    jpeg: jpegDimensions,
    webp: webpDimensions,
  };
  return type === 'svg' ? null : readers[type](bytes);
}
