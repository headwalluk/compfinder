import type { LookupResult } from '../../lookup/result.js';

/** The CSV columns, in order. Part of the schema version: add only at the end (docs/output.md). */
export const CSV_COLUMNS = [
  'id', 'input_name', 'input_url', 'input_postcode',
  'identity_confidence', 'candidate_count',
  'name', 'name_confidence',
  'website', 'website_confidence',
  'address_lines', 'address_town', 'address_county', 'address_postcode', 'address_country_code',
  'address_lat', 'address_lon', 'address_confidence',
  'phone', 'phone_display', 'phone_confidence',
  'email', 'email_confidence',
  'logo_url', 'logo_path', 'logo_confidence',
  'place_id', 'place_id_confidence',
  'socials', 'socials_confidence',
  'conflict_fields', 'failed_providers', 'warnings',
  'error_code',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

const LINE_END = '\r\n';
const MULTI_VALUE_SEPARATOR = '; ';
/** Cells a spreadsheet would run as a formula (OWASP CSV injection). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
/** Excel needs a byte-order mark to read UTF-8. Built from its code point so the source stays plain ASCII. */
export const UTF8_BOM = String.fromCodePoint(0xfeff);
const FAILURE_STATUSES_TO_SKIP = new Set(['ok', 'skipped', 'not_configured']);

/** Quotes a cell when it needs it, and defuses anything a spreadsheet would treat as a formula. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = FORMULA_TRIGGER.test(text) ? `'${text}` : text;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The header row, with its line ending. */
export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}${LINE_END}`;
}

/** The value of a field from a result, or null. */
function fieldValue(result: LookupResult, field: keyof LookupResult['fields']): unknown {
  return result.fields[field].value;
}

/** One lookup's row, with its line ending. A failed batch line has only its id and error code. */
export function csvRow(result: LookupResult | null, id: string | null, errorCode: string | null = null): string {
  const cells: Record<CsvColumn, string | number | null> = Object.fromEntries(CSV_COLUMNS.map((column) => [column, null])) as Record<CsvColumn, string | number | null>;
  cells.id = id;
  cells.error_code = errorCode ?? result?.error?.code ?? null;
  if (result !== null) {
    const address = fieldValue(result, 'address') as { lines: string[]; town: string | null; county: string | null; postcode: string | null; country_code: string | null; lat: number | null; lon: number | null } | null;
    const logo = fieldValue(result, 'logo') as { source_url: string; path: string | null } | null;
    const socials = fieldValue(result, 'socials') as Array<{ url: string }>;
    Object.assign(cells, {
      input_name: result.query.name,
      input_url: result.query.url,
      input_postcode: result.query.postcode,
      identity_confidence: result.identity.confidence,
      candidate_count: result.identity.candidates.length,
      name: fieldValue(result, 'name') as string | null,
      name_confidence: result.fields.name.confidence,
      website: fieldValue(result, 'website') as string | null,
      website_confidence: result.fields.website.confidence,
      address_lines: address?.lines.join(MULTI_VALUE_SEPARATOR) ?? null,
      address_town: address?.town ?? null,
      address_county: address?.county ?? null,
      address_postcode: address?.postcode ?? null,
      address_country_code: address?.country_code ?? null,
      address_lat: address?.lat ?? null,
      address_lon: address?.lon ?? null,
      address_confidence: result.fields.address.confidence,
      phone: fieldValue(result, 'phone') as string | null,
      phone_display: result.fields.phone.display as string | null,
      phone_confidence: result.fields.phone.confidence,
      email: fieldValue(result, 'email') as string | null,
      email_confidence: result.fields.email.confidence,
      logo_url: logo?.source_url ?? null,
      logo_path: logo?.path ?? null,
      logo_confidence: result.fields.logo.confidence,
      place_id: fieldValue(result, 'place_id') as string | null,
      place_id_confidence: result.fields.place_id.confidence,
      socials: socials.map((social) => social.url).join(MULTI_VALUE_SEPARATOR),
      socials_confidence: result.fields.socials.confidence,
      conflict_fields: Object.entries(result.fields).filter(([, field]) => field.conflicts.length > 0).map(([name]) => name).join(MULTI_VALUE_SEPARATOR),
      failed_providers: result.providers.filter((provider) => !FAILURE_STATUSES_TO_SKIP.has(provider.status)).map((provider) => `${provider.name}: ${provider.status}`).join(MULTI_VALUE_SEPARATOR),
      warnings: result.warnings.join(MULTI_VALUE_SEPARATOR),
    });
  }
  return `${CSV_COLUMNS.map((column) => csvCell(cells[column])).join(',')}${LINE_END}`;
}
