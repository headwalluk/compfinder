import { FAILURE_STATUSES } from './errors.js';
import { outputError, type OutputError } from '../messages/error-codes.js';
import type { CandidateAssessment } from '../scoring/identity.js';
import type { FieldResult } from '../scoring/fields.js';
import type { RuleId } from '../scoring/rules.js';
import { fieldItems } from '../scoring/evidence.js';
import type { LookupOutcome, ProviderReport } from './engine.js';
import { FIELD_NAMES, type FieldName } from './fields.js';
import type { FieldValues, SourceName } from './types.js';

/** The output contract's version (semver): docs/output.md. */
export const SCHEMA_VERSION = '1.0';

export interface OutputField {
  value: unknown;
  confidence: number;
  sources: SourceName[];
  rules: RuleId[];
  reasons: string[];
  conflicts: Array<{ value: unknown; sources: SourceName[] }>;
  evidence?: OutputEvidence[];
  [extra: string]: unknown;
}

export interface OutputEvidence {
  source: SourceName;
  value: unknown;
  quality: string;
  reference: { url: string | null; record_id: string | null; detail: string };
  agreed: boolean;
}

export interface OutputCandidate {
  name: string | null;
  address: string | null;
  place_id: string | null;
  website: string | null;
  confidence: number;
}

export interface LookupResult {
  schema_version: string;
  query: Record<string, string | null>;
  identity: {
    confidence: number;
    rules: RuleId[];
    reasons: string[];
    candidates: OutputCandidate[];
    considered?: Array<OutputCandidate & { status: 'leader' | 'beaten' | 'rejected'; keys: Record<string, string> }>;
  };
  fields: Record<FieldName, OutputField>;
  providers: Array<Omit<ProviderReport, 'name'> & { name: string }>;
  warnings: string[];
  error: OutputError | null;
}

/** The JSON form of a field's value, plus the extra keys each field carries beside it. */
function shapeValue(field: FieldName, value: unknown): { value: unknown; extras: Record<string, unknown> } {
  let shaped: { value: unknown; extras: Record<string, unknown> };
  if (value === null) {
    shaped = { value: field === 'socials' ? [] : null, extras: {} };
  } else if (field === 'website') {
    const website = value as FieldValues['website'];
    shaped = { value: website.url, extras: { domain: website.domain } };
  } else if (field === 'phone') {
    const phone = value as FieldValues['phone'];
    shaped = { value: phone.e164, extras: { display: phone.display } };
  } else if (field === 'email') {
    const email = value as FieldValues['email'];
    shaped = { value: email.address, extras: { kind: email.kind } };
  } else if (field === 'logo') {
    const logo = value as FieldValues['logo'];
    shaped = {
      value: {
        source_url: logo.source_url, kind: logo.kind, path: logo.path, mime: logo.mime,
        width: logo.width, height: logo.height, converted_from: logo.converted_from,
      },
      extras: {},
    };
  } else {
    shaped = { value, extras: {} };
  }
  return shaped;
}

/** Fills in the empty extras a field always carries, so every key is present even with nothing found. */
function emptyExtras(field: FieldName): Record<string, unknown> {
  const extras: Partial<Record<FieldName, Record<string, unknown>>> = {
    website: { domain: null },
    phone: { display: null },
    email: { kind: null },
    address: { normalised_by: null },
  };
  return extras[field] ?? {};
}

/** Turns one scored field into its output form. */
function outputField(result: FieldResult<FieldName>, isExplain: boolean): OutputField {
  const field = result.field;
  let shapedValue: unknown;
  let extras: Record<string, unknown> = emptyExtras(field);
  if (field === 'socials') {
    const profiles = (result as FieldResult<'socials'>).value;
    shapedValue = profiles.map((profile) => ({ network: profile.value.network, url: profile.value.url, confidence: profile.confidence }));
  } else {
    const shaped = shapeValue(field, result.value);
    shapedValue = shaped.value;
    extras = { ...extras, ...shaped.extras };
  }
  if (field === 'address' && result.value !== null) {
    extras.normalised_by = result.valueSource === 'google-places-api' ? 'google-places-api' : null;
  }
  const output: OutputField = {
    value: shapedValue,
    ...extras,
    confidence: result.confidence,
    sources: result.sources,
    rules: result.rules,
    reasons: result.reasons,
    conflicts: result.conflicts.map((conflict) => ({ value: shapeValue(field, conflict.value).value, sources: conflict.sources })),
  };
  if (isExplain) {
    output.evidence = result.evidence.map(({ item, isAgreed }) => ({
      source: item.record.source,
      value: shapeValue(field, item.value).value,
      quality: item.quality,
      reference: {
        url: item.evidence.reference.url ?? null,
        record_id: item.evidence.reference.recordId ?? null,
        detail: item.evidence.reference.detail,
      },
      agreed: isAgreed,
    }));
  }
  return output;
}

/** A one-line summary of a candidate place, for the candidates list. */
function summariseCandidate(assessment: CandidateAssessment, confidence: number): OutputCandidate {
  const records = assessment.candidate.records;
  const address = fieldItems(records, 'address')[0]?.value;
  return {
    name: fieldItems(records, 'name')[0]?.value ?? null,
    address: address === undefined ? null : address.formatted ?? [...address.lines, address.town, address.postcode].filter((part) => part !== null && part !== '').join(', '),
    place_id: fieldItems(records, 'place_id')[0]?.value ?? null,
    website: fieldItems(records, 'website')[0]?.value.url ?? null,
    confidence,
  };
}

/** Decides whether a lookup as a whole failed: nothing could be tried, or everything tried failed. */
export function lookupError(reports: readonly ProviderReport[]): OutputError | null {
  const failures: readonly string[] = FAILURE_STATUSES;
  const tried = reports.filter((report) => report.status !== 'skipped' && report.status !== 'not_configured');
  let error: OutputError | null = null;
  if (tried.length === 0) {
    const reasons = reports.map((report) => `${report.name}: ${report.reason ?? report.status}`).join('; ');
    error = outputError('lookup.no_provider', reasons);
  } else if (tried.every((report) => failures.includes(report.status))) {
    error = outputError('lookup.all_failed', tried.map((report) => `${report.name}: ${report.status}`).join('; '));
  }
  return error;
}

/** Builds the schema 1.0 result for a finished lookup. */
export function buildResult(outcome: LookupOutcome, options: { isExplain: boolean }): LookupResult {
  const { query, score } = outcome;
  const identity = score.identity;
  const isTie = identity.leaders.length > 1;
  const fields = {} as Record<FieldName, OutputField>;
  for (const field of FIELD_NAMES) {
    fields[field] = outputField(score.fields[field] as FieldResult<FieldName>, options.isExplain);
  }
  const result: LookupResult = {
    schema_version: SCHEMA_VERSION,
    query: {
      name: query.name,
      url: query.website?.url ?? null,
      address: query.address,
      postcode: query.postcode,
      phone: query.phone?.e164 ?? null,
      place_id: query.placeId,
      country: query.country,
    },
    identity: {
      confidence: identity.confidence,
      rules: identity.rules,
      reasons: identity.reasons,
      candidates: isTie ? identity.leaders.map((leader) => summariseCandidate(leader, identity.confidence)) : [],
    },
    fields,
    providers: outcome.reports.map((report) => ({ ...report })),
    warnings: outcome.warnings,
    error: lookupError(outcome.reports),
  };
  if (options.isExplain) {
    const consider = (assessment: CandidateAssessment, status: 'leader' | 'beaten' | 'rejected'): NonNullable<LookupResult['identity']['considered']>[number] => ({
      ...summariseCandidate(assessment, status === 'leader' ? identity.confidence : 0),
      status,
      keys: Object.fromEntries(assessment.keys.filter((match) => match.state !== 'silent').map((match) => [match.key, match.state])),
    });
    result.identity.considered = [
      ...identity.leaders.map((assessment) => consider(assessment, 'leader')),
      ...identity.others.map((assessment) => consider(assessment, 'beaten')),
      ...identity.rejected.map((assessment) => consider(assessment, 'rejected')),
    ];
  }
  return result;
}
