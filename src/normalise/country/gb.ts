import type { CountryRules } from './types.js';

/** A full UK postcode, space optional: outward code (area, district) then inward code. */
const POSTCODE_PATTERN = /^([A-Z]{1,2}[0-9][A-Z0-9]?) ?([0-9][A-Z]{2})$/;
/** The same shape, found inside running text. */
const POSTCODE_IN_TEXT = /\b([A-Z]{1,2}[0-9][A-Z0-9]?) ?([0-9][A-Z]{2})\b/gi;

/** Returns the postcode in capitals with one space, or null when it isn't a valid UK postcode. */
function normalisePostcode(value: string): string | null {
  const match = POSTCODE_PATTERN.exec(value.trim().toUpperCase().replace(/\s+/g, ' '));
  return match === null ? null : `${match[1]} ${match[2]}`;
}

/** Finds every distinct postcode in a piece of text, in order of appearance. */
function findPostcodes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(POSTCODE_IN_TEXT)) {
    const postcode = normalisePostcode(`${match[1]} ${match[2]}`);
    if (postcode !== null && !found.includes(postcode)) {
      found.push(postcode);
    }
  }
  return found;
}

export const GB_RULES: CountryRules = {
  countryCode: 'GB',
  normalisePostcode,
  findPostcodes,
};
