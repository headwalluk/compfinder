import type { FieldName } from '../lookup/fields.js';
import type { EvidenceFor, EvidenceQuality, FieldValues, SourceRecord } from '../lookup/types.js';

/** One value of a field, with the record it came from. */
export interface FieldItem<Field extends FieldName> {
  value: FieldValues[Field];
  quality: EvidenceQuality;
  evidence: EvidenceFor<Field>;
  record: SourceRecord;
}

/** Every value of one field across some records, in record order. */
export function fieldItems<Field extends FieldName>(records: readonly SourceRecord[], field: Field): FieldItem<Field>[] {
  const items: FieldItem<Field>[] = [];
  for (const record of records) {
    for (const evidence of record.evidence) {
      if (evidence.field === field) {
        const typed = evidence as EvidenceFor<Field>;
        items.push({ value: typed.value as FieldValues[Field], quality: typed.quality, evidence: typed, record });
      }
    }
  }
  return items;
}

/** The host a record's site is on: from a site: origin, else its first website value; null when neither. */
export function recordSite(record: SourceRecord): string | null {
  const SITE_ORIGIN_PREFIX = 'site:';
  let site: string | null;
  if (record.origin.startsWith(SITE_ORIGIN_PREFIX)) {
    site = record.origin.slice(SITE_ORIGIN_PREFIX.length);
  } else {
    site = fieldItems([record], 'website')[0]?.value.domain ?? null;
  }
  return site;
}
