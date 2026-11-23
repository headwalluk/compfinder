/** Country-specific address handling. Phone numbers are per country through libphonenumber-js. */
export interface CountryRules {
  countryCode: string;
  /** The postcode in its canonical form, or null when it isn't valid for the country. */
  normalisePostcode(value: string): string | null;
  /** Every distinct postcode found in running text, in order. */
  findPostcodes(text: string): string[];
}
