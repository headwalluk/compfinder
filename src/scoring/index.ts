import type { FieldName } from '../lookup/fields.js';
import type { Query, SourceRecord } from '../lookup/types.js';
import type { ProviderName } from '../providers/declarations.js';
import { scoreField, scoreLogo, scoreSocials, type FieldContext, type FieldResult } from './fields.js';
import { queryHasLocation, resolveIdentity, type IdentityResult } from './identity.js';
import { linkCandidates } from './link.js';

export type FieldResults = { [Field in FieldName]: FieldResult<Field> };

export interface ScoreResult {
  identity: IdentityResult;
  fields: FieldResults;
  warnings: string[];
}

/** Scores every record gathered for a lookup: identity first, then each field for the leading candidate. */
export function scoreLookup(
  records: readonly SourceRecord[],
  query: Query,
  queryRecord: SourceRecord,
  priority: Readonly<Record<FieldName, readonly ProviderName[]>>,
): ScoreResult {
  const identity = resolveIdentity(linkCandidates(records, query), query);
  const leader = identity.leaders[0]?.candidate;
  const fieldRecords = [queryRecord, ...(leader?.records ?? []), ...(leader?.brandRecords ?? [])];
  const context: FieldContext = { query, priority, identity, isBranchQuery: queryHasLocation(query) };
  const website = scoreField('website', fieldRecords, context);
  const fields: FieldResults = {
    name: scoreField('name', fieldRecords, context),
    website,
    address: scoreField('address', fieldRecords, context),
    phone: scoreField('phone', fieldRecords, context),
    email: scoreField('email', fieldRecords, context),
    logo: scoreLogo(fieldRecords, website.confidence, context),
    place_id: scoreField('place_id', fieldRecords, context),
    socials: scoreSocials(fieldRecords, context),
  };
  return { identity, fields, warnings: [...identity.warnings] };
}
