/** Image types compfinder accepts, identified by their first bytes, never by Content-Type. */
export const IMAGE_TYPES = {
  png: { mime: 'image/png', extension: 'png' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  gif: { mime: 'image/gif', extension: 'gif' },
  webp: { mime: 'image/webp', extension: 'webp' },
  ico: { mime: 'image/x-icon', extension: 'ico' },
  svg: { mime: 'image/svg+xml', extension: 'svg' },
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);
const RIFF = 'RIFF';
const WEBP = 'WEBP';
const WEBP_TAG_OFFSET = 8;
const SVG_SNIFF_BYTES = 1024;
const SVG_START = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Identifies an image from its bytes; null when it isn't one of the accepted types. */
export function sniffImage(bytes: Buffer): ImageType | null {
  const ascii = (start: number, end: number): string => bytes.subarray(start, end).toString('latin1');
  let type: ImageType | null = null;
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    type = 'png';
  } else if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    type = 'jpeg';
  } else if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    type = 'gif';
  } else if (ascii(0, 4) === RIFF && ascii(WEBP_TAG_OFFSET, WEBP_TAG_OFFSET + 4) === WEBP) {
    type = 'webp';
  } else if (bytes.subarray(0, ICO_SIGNATURE.length).equals(ICO_SIGNATURE)) {
    type = 'ico';
  } else {
    const start = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? UTF8_BOM.length : 0;
    if (SVG_START.test(bytes.subarray(start, SVG_SNIFF_BYTES).toString('utf8'))) {
      type = 'svg';
    }
  }
  return type;
}
