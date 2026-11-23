import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import { decodeEscapes } from './text.js';

export interface PhoneValue {
  /** E.164, such as +441184960000. */
  e164: string;
  /** The national format, such as 0118 496 0000. */
  display: string;
}

const TEL_SCHEME = /^tel:/i;

/** Parses a phone number for a country; null when it isn't a valid number. */
export function normalisePhone(raw: string, countryCode: string): PhoneValue | null {
  const cleaned = decodeEscapes(raw.replace(TEL_SCHEME, '')).trim();
  const parsed = parsePhoneNumberFromString(cleaned, countryCode.toUpperCase() as CountryCode);
  return parsed !== undefined && parsed.isValid() ? { e164: parsed.number, display: parsed.formatNational() } : null;
}
