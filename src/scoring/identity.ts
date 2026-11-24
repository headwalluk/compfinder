import type { Query, SourceRecord } from '../lookup/types.js';
import { compareNames, compareQueryName } from '../normalise/name.js';
import { isSameSite, isSiteRoot, pagePath } from '../normalise/url.js';
import { fieldItems, recordSite } from './evidence.js';
import type { Candidate } from './link.js';
import { ruleScore, type RuleId } from './rules.js';

export const QUERY_KEYS = ['place_id', 'phone', 'postcode', 'website-site', 'website-page', 'name', 'town'] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];
export type KeyState = 'confirmed' | 'contradicted' | 'silent';

/** Query keys that, confirmed by structured evidence, pin the identity down (identity.input-confirmed). */
const PINNING_KEYS: ReadonlySet<QueryKey> = new Set(['place_id', 'phone', 'postcode', 'website-page']);
const NON_WORD = /[^\p{L}\p{N}]+/gu;

export interface KeyMatch {
  key: QueryKey;
  state: KeyState;
  /** True when a structured record confirmed the key. */
  isStructured: boolean;
  /** The confirmed value, for reasons. */
  value: string | null;
  /** The sources that confirmed it, in record order. */
  sources: string[];
}

export interface CandidateAssessment {
  candidate: Candidate;
  keys: KeyMatch[];
  isConsistent: boolean;
  /** Distinct non-query origins among the candidate's own records. */
  origins: string[];
  /** The candidate's score before any tie is shared out, and the rule that gave it. */
  baseScore: number;
  baseRule: RuleId;
  baseReason: string;
  /** True when the query is a whole business (a home page, no location) and this candidate is its head office. */
  isPreferredHeadOffice: boolean;
  /** True when the query's site is confirmed and its name is the only contradiction (identity.name-mismatch). */
  isNameMismatch: boolean;
  /** True when one of the candidate's names equals the query's, not just contains it. */
  isNameExact: boolean;
  /** The candidate's postcodes, to tell listings in one building from branches elsewhere. */
  postcodes: Set<string>;
}

export interface IdentityResult {
  confidence: number;
  rules: RuleId[];
  reasons: string[];
  /** The candidates tied at the top, in deterministic order. The first provides the fields. */
  leaders: CandidateAssessment[];
  /** Candidates the query contradicts. */
  rejected: CandidateAssessment[];
  /** Ranked but beaten candidates. */
  others: CandidateAssessment[];
  /** The cap for brand-wide fields: the base score when every leader is on one site, else the identity. */
  brandConfidence: number;
  isHeadOffice: boolean;
  warnings: string[];
}

/** Names the sources in a list of records, in order, without repeats. */
export function sourceNames(records: readonly SourceRecord[]): string[] {
  return [...new Set(records.map((record) => record.source))];
}

/** Joins words as "a", "a and b", "a, b and c". */
export function listInWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** True when every word of one path's last segment is in the other's (/offices/chiswick and /offices/dexters-chiswick-estate-agents). */
function isRelatedPath(first: string, second: string): boolean {
  const segmentWords = (path: string): Set<string> => new Set((path.split('/').pop() ?? '').split(/[-_.+]+/).filter((word) => word !== ''));
  const firstWords = segmentWords(first);
  const secondWords = segmentWords(second);
  const isWithin = (inner: Set<string>, outer: Set<string>): boolean => inner.size > 0 && [...inner].every((word) => outer.has(word));
  return isWithin(firstWords, secondWords) || isWithin(secondWords, firstWords);
}

/** Compares one query key with a candidate's values. */
function matchKey(key: QueryKey, query: Query, records: readonly SourceRecord[], isSiteRead: boolean): KeyMatch {
  let state: KeyState = 'silent';
  let isStructured = false;
  let value: string | null = null;
  const sources: string[] = [];
  const confirm = (found: string, structured: boolean, source: string): void => {
    state = 'confirmed';
    value = found;
    isStructured = isStructured || structured;
    if (!sources.includes(source)) {
      sources.push(source);
    }
  };

  if (key === 'place_id' && query.placeId !== null) {
    const items = fieldItems(records, 'place_id');
    for (const item of items.filter((candidate) => candidate.value === query.placeId)) {
      confirm(item.value, item.quality === 'structured', item.record.source);
    }
    state = state === 'silent' && items.length > 0 ? 'contradicted' : state;
  } else if (key === 'phone' && query.phone !== null) {
    const items = fieldItems(records, 'phone');
    for (const item of items.filter((candidate) => candidate.value.e164 === query.phone?.e164)) {
      confirm(item.value.e164, item.quality === 'structured', item.record.source);
    }
    state = state === 'silent' && items.length > 0 ? 'contradicted' : state;
  } else if (key === 'postcode' && query.postcode !== null) {
    const items = fieldItems(records, 'address').filter((item) => item.value.postcode !== null);
    for (const item of items.filter((candidate) => candidate.value.postcode === query.postcode)) {
      confirm(query.postcode, item.quality === 'structured', item.record.source);
    }
    state = state === 'silent' && items.length > 0 ? 'contradicted' : state;
  } else if (key === 'website-site' && query.website !== null) {
    const items = fieldItems(records, 'website');
    const querySite = query.website.domain;
    for (const item of items.filter((candidate) => isSameSite(candidate.value.domain, querySite))) {
      confirm(querySite, item.quality === 'structured', item.record.source);
    }
    state = state === 'silent' && items.length > 0 ? 'contradicted' : state;
  } else if (key === 'website-page' && query.website !== null && !isSiteRoot(query.website.url)) {
    const querySite = query.website.domain;
    const queryPath = pagePath(query.website.url);
    const onSite = fieldItems(records, 'website').filter((item) => isSameSite(item.value.domain, querySite) && !isSiteRoot(item.value.url));
    for (const item of onSite.filter((candidate) => pagePath(candidate.value.url) === queryPath)) {
      confirm(query.website.url, item.quality === 'structured', item.record.source);
    }
    // Unread, a page can't be told from an alias of it (/bookshops/reading, /bookshops/reading-broad-street): only a
    // clearly different page contradicts.
    const isContradiction = (url: string): boolean => isSiteRead || !isRelatedPath(pagePath(url), queryPath);
    state = state === 'silent' && onSite.some((item) => isContradiction(item.value.url)) ? 'contradicted' : state;
  } else if (key === 'name' && query.name !== null) {
    const items = fieldItems(records, 'name');
    const queryName = query.name;
    for (const item of items.filter((candidate) => compareQueryName(queryName, candidate.value) !== 'incompatible')) {
      confirm(item.value, item.quality === 'structured', item.record.source);
    }
    state = state === 'silent' && items.length > 0 ? 'contradicted' : state;
  } else if (key === 'town' && query.address !== null) {
    // Confirm-only: a free-text address may simply not mention the town.
    const queryWords = ` ${query.address.toLowerCase().replace(NON_WORD, ' ')} `;
    for (const item of fieldItems(records, 'address')) {
      const town = item.value.town?.toLowerCase().replace(NON_WORD, ' ').trim() ?? '';
      if (town !== '' && queryWords.includes(` ${town} `)) {
        confirm(item.value.town ?? town, item.quality === 'structured', item.record.source);
      }
    }
  }
  return { key, state, isStructured, value, sources };
}

/** Scores one candidate on its own (the identity base rules), before any tie. */
function assessCandidate(candidate: Candidate, query: Query, isSiteRead: boolean): CandidateAssessment {
  const keys = QUERY_KEYS.map((key) => matchKey(key, query, candidate.records, isSiteRead));
  const origins = [...new Set(candidate.records.map((record) => record.origin))];
  const hasStructured = candidate.records.some((record) => record.evidence.some((evidence) => evidence.quality === 'structured'));
  const pinned = keys.find((match) => PINNING_KEYS.has(match.key) && match.state === 'confirmed' && match.isStructured);
  const sources = listInWords(sourceNames(candidate.records));
  let baseRule: RuleId;
  let baseReason: string;
  if (pinned !== undefined) {
    baseRule = 'identity.input-confirmed';
    baseReason = `${listInWords(pinned.sources)} confirm${pinned.sources.length > 1 ? '' : 's'} the query's ${pinned.key.replace('website-', '')} ${pinned.value ?? ''}`.trim();
  } else if (origins.length >= 2) {
    baseRule = 'identity.independent-agreement';
    baseReason = `${sources} agree on ${candidate.linkedBy[0] ?? 'this place'}`;
  } else if (hasStructured) {
    baseRule = 'identity.single-structured';
    baseReason = `one source only (${sources}), with structured data`;
  } else {
    baseRule = 'identity.single-loose';
    baseReason = `one source only (${sources}), from loose page content`;
  }
  const isPinnedByQuery = keys.some((match) => PINNING_KEYS.has(match.key) && match.state === 'confirmed');
  const isWholeBusinessQuery = !queryHasLocation(query) && query.website !== null;
  const contradicted = keys.filter((match) => match.state === 'contradicted').map((match) => match.key);
  const querySite = query.website?.domain ?? null;
  const isSiteConfirmed = querySite !== null && candidate.records.some((record) => {
    const site = recordSite(record);
    return site !== null && isSameSite(site, querySite);
  });
  const isNameMismatch = !isPinnedByQuery && isSiteConfirmed && contradicted.length === 1 && contradicted[0] === 'name';
  return {
    candidate,
    keys,
    // A confirmed pinning key outweighs other mismatches: those are stale data, shown as field conflicts.
    isConsistent: isPinnedByQuery || isNameMismatch || contradicted.length === 0,
    origins,
    baseScore: ruleScore(baseRule),
    baseRule,
    baseReason,
    isPreferredHeadOffice: isWholeBusinessQuery && candidate.records.some((record) => record.role === 'head-office'),
    isNameMismatch,
    isNameExact: query.name !== null && fieldItems(candidate.records, 'name').some((item) => compareNames(item.value, query.name ?? '') === 'equal'),
    postcodes: new Set(fieldItems(candidate.records, 'address').map((item) => item.value.postcode).filter((postcode) => postcode !== null)),
  };
}

/**
 * Ranks how well two candidates match the query: a confirmed place ID, a matching name, the head office for a
 * whole-business query, most confirmed keys, fewest contradictions, then (in one building only) the exact name. 0 is a tie. How many sources back a candidate
 * isn't a match to the query, so it never breaks a tie (docs/confidence.md: identity.tie).
 */
function rankDifference(first: CandidateAssessment, second: CandidateAssessment): number {
  const placeIdRank = (assessment: CandidateAssessment): number => (
    assessment.keys.some((match) => match.key === 'place_id' && match.state === 'confirmed') ? 1 : 0
  );
  const count = (assessment: CandidateAssessment, state: KeyState): number => assessment.keys.filter((match) => match.state === state).length;
  return placeIdRank(second) - placeIdRank(first)
    || Number(first.isNameMismatch) - Number(second.isNameMismatch)
    || Number(second.isPreferredHeadOffice) - Number(first.isPreferredHeadOffice)
    || count(second, 'confirmed') - count(first, 'confirmed')
    || count(first, 'contradicted') - count(second, 'contradicted')
    || (isSameBuilding(first, second) ? Number(second.isNameExact) - Number(first.isNameExact) : 0);
}

/** True when every candidate shares one postcode and one phone: one place listed several times (sales and lettings). */
function isCoListed(assessments: readonly CandidateAssessment[]): boolean {
  const phonesOf = (assessment: CandidateAssessment): Set<string> => new Set(fieldItems(assessment.candidate.records, 'phone').map((item) => item.value.e164));
  const [first, ...rest] = assessments;
  const sharedPhones = first === undefined ? [] : [...phonesOf(first)].filter((phone) => rest.every((other) => phonesOf(other).has(phone)));
  const sharedPostcodes = first === undefined ? [] : [...first.postcodes].filter((postcode) => rest.every((other) => other.postcodes.has(postcode)));
  return sharedPhones.length > 0 && sharedPostcodes.length > 0;
}

/** True when two candidates share a postcode: listings in one building, which only their names tell apart. */
function isSameBuilding(first: CandidateAssessment, second: CandidateAssessment): boolean {
  return [...first.postcodes].some((postcode) => second.postcodes.has(postcode));
}

/** Names a rejected candidate and the query values it contradicts, for reasons. */
function describeRejection(assessment: CandidateAssessment): string {
  const name = fieldItems(assessment.candidate.records, 'name')[0]?.value ?? 'an unnamed place';
  const contradicted = assessment.keys.filter((match) => match.state === 'contradicted').map((match) => match.key.replace('website-', ''));
  return `${name} (different ${listInWords(contradicted)})`;
}

/** Orders candidates by rank, then the best-sourced first (it supplies the fields in a tie), then by position. */
function compareAssessments(first: CandidateAssessment, second: CandidateAssessment): number {
  return rankDifference(first, second)
    || second.origins.length - first.origins.length
    || second.candidate.brandRecords.length - first.candidate.brandRecords.length
    || first.candidate.index - second.candidate.index;
}

/** True when the query names a specific place rather than a whole business. */
export function queryHasLocation(query: Query): boolean {
  return query.placeId !== null || query.phone !== null || query.postcode !== null || query.address !== null
    || (query.website !== null && !isSiteRoot(query.website.url));
}

/** Resolves which candidate the lookup is about, and how sure the tool is (05: identity). */
export function resolveIdentity(candidates: readonly Candidate[], query: Query): IdentityResult {
  const querySite = query.website?.domain ?? null;
  const isSiteRead = querySite !== null && candidates.some((candidate) => [...candidate.records, ...candidate.brandRecords].some((record) => {
    const site = record.source === 'web-fetch' ? recordSite(record) : null;
    return site !== null && isSameSite(site, querySite);
  }));
  const assessments = candidates.map((candidate) => assessCandidate(candidate, query, isSiteRead));
  const consistent = assessments.filter((assessment) => assessment.isConsistent).sort(compareAssessments);
  const rejected = assessments.filter((assessment) => !assessment.isConsistent);
  const first = consistent[0];
  const leaders = first === undefined ? [] : consistent.filter((assessment) => rankDifference(first, assessment) === 0);
  const others = consistent.slice(leaders.length);
  const rules: RuleId[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  let confidence = 0;
  let brandConfidence = 0;
  let isHeadOffice = false;

  if (first === undefined) {
    rules.push('identity.none');
    reasons.push(candidates.length === 0 ? 'no source described the business' : `every candidate contradicts the query: ${listInWords(rejected.map(describeRejection))}`);
  } else {
    rules.push(first.baseRule);
    reasons.push(first.baseReason);
    confidence = first.baseScore;
    if (leaders.length > 1 && isCoListed(leaders)) {
      rules.push('identity.co-listed');
      reasons.push(`${leaders.length} listings share this address and phone, so they're one place; the first is shown`);
    } else if (leaders.length > 1) {
      confidence = Math.floor(first.baseScore / leaders.length);
      rules.push('identity.tie');
      const isFromSearch = leaders.some((leader) => leader.candidate.records.some((record) => record.source === 'google-places-api'));
      // A search returns only its best few places, so a tie built from one may not list every match.
      reasons.push(`${leaders.length} candidates match equally; each is listed${isFromSearch ? ' (a place search returns only its best few matches, so there may be more)' : ''}`);
    }
    const leaderSites = new Set(leaders.flatMap((leader) => fieldItems(leader.candidate.records, 'website').map((item) => item.value.domain)));
    brandConfidence = leaderSites.size === 1 ? first.baseScore : confidence;
    if (first.isNameMismatch) {
      const cap = ruleScore('identity.name-mismatch');
      const siteName = fieldItems(first.candidate.records, 'name')[0]?.value ?? 'another name';
      confidence = Math.min(confidence, cap);
      brandConfidence = Math.min(brandConfidence, cap);
      rules.push('identity.name-mismatch');
      reasons.push(`the query's site is confirmed, but its name isn't (the sources say ${siteName}); capped at ${cap}`);
      warnings.push(`The query's name "${query.name ?? ''}" doesn't match the site's name "${siteName}". Check that this is the business you meant.`);
    }
    if (rules.includes('identity.tie') && !queryHasLocation(query) && query.website !== null && leaderSites.size === 1) {
      rules.push('identity.chain');
      reasons.push('a chain\'s home page with no location given: the identity is the chain, and these are some of its places');
      warnings.push('The query is a chain\'s home page with no location, and several of its places match. The brand\'s details (name, website, logo, socials) stand for the chain; the candidates are some of its places.');
    }
    isHeadOffice = !queryHasLocation(query) && first.candidate.records.some((record) => record.role === 'head-office');
    if (isHeadOffice) {
      rules.push('identity.head-office');
      reasons.push('a chain\'s home page with no location given: this is the head office');
      warnings.push('The query is a chain\'s home page with no location, so the identity is the head office, not a branch.');
    }
  }
  return { confidence, rules, reasons, leaders, rejected, others, brandConfidence, isHeadOffice, warnings };
}
