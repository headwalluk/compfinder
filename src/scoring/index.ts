import type { FieldName } from '../lookup/fields.js';
import type { Query, SourceRecord } from '../lookup/types.js';
import type { ProviderName } from '../providers/declarations.js';
import { scoreField, scoreLogo, scoreSocials, type FieldContext, type FieldResult } from './fields.js';
import { queryHasLocation, resolveIdentity, type IdentityResult } from './identity.js';
import { linkCandidates } from './link.js';
import { recordSite } from './evidence.js';
import { isSameSite } from '../normalise/url.js';

export type FieldResults = { [Field in FieldName]: FieldResult<Field> };

export interface ScoreResult {
  identity: IdentityResult;
  fields: FieldResults;
  warnings: string[];
}

/**
 * For a home page asked about, when the leading place has nothing from the site itself: the site's own location records
 * that matched no place. They're the business's own word, so where they differ from the leader they show as conflicts;
 * they aren't part of the identity, so they can't raise its score.
 */
function unmatchedSiteRecords(identity: IdentityResult, query: Query): SourceRecord[] {
  const website = query.website;
  const leader = identity.leaders[0]?.candidate;
  const isFromSite = (record: SourceRecord): boolean => {
    const site = recordSite(record);
    return website !== null && record.source === 'web-fetch' && record.scope === 'location' && site !== null && isSameSite(site, website.domain);
  };
  const isWholeBusiness = website !== null && !queryHasLocation(query);
  return !isWholeBusiness || leader === undefined || leader.records.some(isFromSite) ? []
    : identity.others.filter((other) => other.candidate.records.every(isFromSite)).flatMap((other) => other.candidate.records);
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
  // A chain's identity is the brand: its fields come from the brand's own records, not from one of its places.
  const isChain = identity.rules.includes('identity.chain');
  const brandRecords = [...new Set(identity.leaders.flatMap((assessment) => assessment.candidate.brandRecords))];
  const fieldRecords = isChain
    ? [queryRecord, ...brandRecords]
    : [queryRecord, ...(leader?.records ?? []), ...(leader?.brandRecords ?? []), ...unmatchedSiteRecords(identity, query)];
  const pageMovedTo = records.find((record) => record.movedTo !== undefined)?.movedTo ?? null;
  const context: FieldContext = { query, priority, identity, isBranchQuery: queryHasLocation(query), pageMovedTo };
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
