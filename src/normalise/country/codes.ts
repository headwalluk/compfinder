import { getCountries } from 'libphonenumber-js';

/** Country codes compfinder accepts: the regions libphonenumber-js knows, which are ISO 3166-1 alpha-2 codes (docs/configuration.md). */
const COUNTRY_CODES: ReadonlySet<string> = new Set(getCountries());
/** Codes people write that mean another: UK is GB's common name, not its ISO code. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = { UK: 'GB' };

/** A country code in upper case, with UK read as GB; null when it isn't a real two-letter code. */
export function normaliseCountryCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  const code = COUNTRY_ALIASES[upper] ?? upper;
  return COUNTRY_CODES.has(code) ? code : null;
}
