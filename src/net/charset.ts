import { TextDecoder } from 'node:util';

const CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([\w.:-]+)/i;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i;
const SNIFF_BYTES = 1024;
const DEFAULT_CHARSET = 'utf-8';

/** Turns a TextDecoder label into a decoder, or null when the label isn't one it knows. */
function decoderFor(label: string): TextDecoder | null {
  let decoder: TextDecoder | null;
  try {
    decoder = new TextDecoder(label);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    decoder = null; // Unknown label: fall back to the next source.
  }
  return decoder;
}

/** Decodes a body using the Content-Type charset, then a <meta charset> in the first 1 KiB, then UTF-8. */
export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const fromHeader = CHARSET_IN_CONTENT_TYPE.exec(contentType ?? '')?.[1];
  const fromMeta = META_CHARSET.exec(body.subarray(0, SNIFF_BYTES).toString('latin1'))?.[1];
  const decoder = (fromHeader === undefined ? null : decoderFor(fromHeader))
    ?? (fromMeta === undefined ? null : decoderFor(fromMeta))
    ?? new TextDecoder(DEFAULT_CHARSET);
  return decoder.decode(body);
}
