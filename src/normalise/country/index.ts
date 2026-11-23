import { GB_RULES } from './gb.js';
import type { CountryRules } from './types.js';

export type { CountryRules } from './types.js';

const COUNTRY_RULES: Readonly<Record<string, CountryRules>> = { GB: GB_RULES };

/** Rules that accept nothing, for countries without a module yet. */
const NO_RULES: Omit<CountryRules, 'countryCode'> = {
  normalisePostcode: () => null,
  findPostcodes: () => [],
};

/** Returns the address rules for a country; one without a module gets rules that find nothing. */
export function countryRules(countryCode: string): CountryRules {
  return COUNTRY_RULES[countryCode.toUpperCase()] ?? { countryCode: countryCode.toUpperCase(), ...NO_RULES };
}
