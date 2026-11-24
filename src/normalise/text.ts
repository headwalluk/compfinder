/** Kinds of untrusted string, each with its own length cap. */
export const TEXT_LIMITS = {
  name: 200,
  addressLine: 200,
  town: 100,
  email: 254,
  url: 2048,
  phone: 32,
  identifier: 300,
} as const;

export type TextKind = keyof typeof TEXT_LIMITS;

/** C0 and C1 controls, bidi overrides and isolates, and zero-width characters. */
// eslint-disable-next-line no-control-regex -- matching control characters is this pattern's purpose
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const TAG_PATTERN = /<[^>]*>/g;
/** HTML character references: named (&amp;), decimal (&#38;) or hex (&#x26;). */
const ENTITY_PATTERN = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
/** The named references schema.org text and page titles actually carry; others are left as written. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™',
};
const MAX_CODE_POINT = 0x10ffff;

/** Decodes HTML character references, which JSON-LD text often carries undecoded (Hunters &amp; …). */
export function decodeEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match: string, decimal?: string, hex?: string, named?: string) => {
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : hex !== undefined ? Number.parseInt(hex, 16) : null;
    let decoded = match;
    if (codePoint !== null && codePoint > 0 && codePoint <= MAX_CODE_POINT) {
      decoded = String.fromCodePoint(codePoint);
    } else if (named !== undefined) {
      decoded = NAMED_ENTITIES[named.toLowerCase()] ?? match;
    }
    return decoded;
  });
}
const WHITESPACE_RUN = /\s+/g;

/** Decodes character references, then strips markup, control and invisible characters, collapses whitespace, and caps the length. */
export function sanitiseText(value: string, kind: TextKind): string {
  const cleaned = decodeEntities(value)
    .normalize('NFC')
    .replace(TAG_PATTERN, ' ')
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  return Array.from(cleaned).slice(0, TEXT_LIMITS[kind]).join('').trim();
}

/** Decodes %-escapes, leaving the text as it was when an escape is malformed. */
export function decodeEscapes(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }
    decoded = value; // Malformed escape; compare the text as given.
  }
  return decoded;
}
