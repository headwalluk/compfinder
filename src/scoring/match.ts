import type { FieldName } from '../lookup/fields.js';
import type { AddressValue, FieldValues } from '../lookup/types.js';
import { compareNames, comparableName } from '../normalise/name.js';
import { isSameSite, pagePath } from '../normalise/url.js';

/** A leading building number such as "1", "12a" or "3-5". */
const BUILDING_NUMBER = /^(\d+[a-z]?(?:-\d+[a-z]?)?)\b/i;
const WHITESPACE_RUN = /\s+/g;

/** Street words written out in full, and the short form each is compared as. */
const STREET_WORDS: Readonly<Record<string, string>> = {
  street: 'st', saint: 'st', road: 'rd', avenue: 'ave', drive: 'dr', lane: 'ln', place: 'pl', court: 'ct', crescent: 'cres',
  boulevard: 'blvd', terrace: 'ter', square: 'sq', parkway: 'pkwy', highway: 'hwy', west: 'w', east: 'e', north: 'n', south: 's',
};
/** A part of an address that is only a unit: "Ste 914", "Suite 2", "Unit 4", "Flat 3". */
const UNIT_PART = /^(?:ste|suite|unit|flat|apt|apartment|floor|fl)\.? ?\w+$/;
/** A building number followed by a street: "6 fern rd". */
const NUMBERED_STREET = /^(\d+[a-z]?(?:-\d+[a-z]?)?) (\D.*)$/;

/**
 * The building number and street of an address, in a form two spellings share ("329 W 18th St, Ste 914" and "Ste 914,
 * 329 West 18th Street" both give "329 w 18th st"); null without a numbered street. Units and postcodes are left out.
 */
export function streetAddress(address: AddressValue): string | null {
  const parts = address.lines.flatMap((line) => line.split(','))
    .map((part) => part.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').map((word) => STREET_WORDS[word] ?? word).join(' '))
    .filter((part) => part !== '' && !UNIT_PART.test(part));
  let street: string | null = null;
  for (const [index, part] of parts.entries()) {
    // Google may give the number as a line of its own: "25", then "Saint Peter's Park Road".
    const candidate = /^\d+[a-z]?$/.test(part) && parts[index + 1] !== undefined ? `${part} ${parts[index + 1] ?? ''}` : part;
    if (NUMBERED_STREET.test(candidate)) {
      street = candidate;
      break;
    }
  }
  return street;
}

/** The leading building number of an address's first line, lower-cased; null when there isn't one. */
export function buildingNumber(address: AddressValue): string | null {
  const firstLine = address.lines[0]?.trim() ?? '';
  const match = BUILDING_NUMBER.exec(firstLine);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Address lines and town, normalised for comparison. */
function comparableAddress(address: AddressValue): string {
  return [...address.lines, address.town ?? ''].join(' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(WHITESPACE_RUN, ' ').trim();
}

/** Same postcode, and the same building number when both have one; without postcodes, the same lines and town. */
export function addressesEqual(first: AddressValue, second: AddressValue): boolean {
  let isEqual: boolean;
  if (first.postcode !== null && second.postcode !== null) {
    const firstNumber = buildingNumber(first);
    const secondNumber = buildingNumber(second);
    isEqual = first.postcode === second.postcode && (firstNumber === null || secondNumber === null || firstNumber === secondNumber);
  } else if (first.postcode === null && second.postcode === null) {
    isEqual = comparableAddress(first) !== '' && comparableAddress(first) === comparableAddress(second);
  } else {
    isEqual = false;
  }
  return isEqual;
}

/** Whether two values of a field are the same fact (05: equality per field). */
export function valuesEqual<Field extends FieldName>(field: Field, first: FieldValues[Field], second: FieldValues[Field]): boolean {
  let isEqual: boolean;
  switch (field) {
    case 'name':
      isEqual = compareNames(first as string, second as string) === 'equal';
      break;
    case 'website':
      isEqual = isSameSite((first as FieldValues['website']).domain, (second as FieldValues['website']).domain);
      break;
    case 'address':
      isEqual = addressesEqual(first as AddressValue, second as AddressValue);
      break;
    case 'phone':
      isEqual = (first as FieldValues['phone']).e164 === (second as FieldValues['phone']).e164;
      break;
    case 'email':
      isEqual = (first as FieldValues['email']).address === (second as FieldValues['email']).address;
      break;
    case 'place_id':
      isEqual = first === second;
      break;
    case 'logo':
      isEqual = (first as FieldValues['logo']).source_url === (second as FieldValues['logo']).source_url;
      break;
    case 'socials': {
      const firstSocial = first as FieldValues['socials'];
      const secondSocial = second as FieldValues['socials'];
      isEqual = firstSocial.network === secondSocial.network && pagePath(firstSocial.url) === pagePath(secondSocial.url);
      break;
    }
    default: {
      const unhandled: never = field;
      throw new Error(`Unhandled field ${String(unhandled)}`);
    }
  }
  return isEqual;
}

/** A stable string for a value: the last tie-break between groups, and how a value is named in reasons. */
export function canonicalValue<Field extends FieldName>(field: Field, value: FieldValues[Field]): string {
  let canonical: string;
  switch (field) {
    case 'name':
      canonical = comparableName(value as string);
      break;
    case 'website':
      canonical = (value as FieldValues['website']).url;
      break;
    case 'address': {
      const address = value as AddressValue;
      canonical = [address.postcode ?? '', ...address.lines, address.town ?? ''].filter((part) => part !== '').join(', ');
      break;
    }
    case 'phone':
      canonical = (value as FieldValues['phone']).e164;
      break;
    case 'email':
      canonical = (value as FieldValues['email']).address;
      break;
    case 'logo':
      canonical = (value as FieldValues['logo']).source_url;
      break;
    case 'socials':
      canonical = (value as FieldValues['socials']).url;
      break;
    default:
      canonical = String(value);
  }
  return canonical;
}
