import { QUERY_SOURCE, type Query, type SourceRecord } from '../lookup/types.js';
import { compareNames, compareQueryName, nameTokens } from '../normalise/name.js';
import { isRelatedPath, isSameSite, isSiteRoot, normaliseUrl, pagePath } from '../normalise/url.js';
import { fieldItems, recordSite } from './evidence.js';
import { addressesEqual } from './match.js';
import { countryRules } from '../normalise/country/index.js';
import type { Candidate } from './link.js';
import { ruleScore, type RuleId } from './rules.js';
import { PROVIDER_DECLARATIONS, PROVIDER_NAMES } from '../providers/declarations.js';

export const QUERY_KEYS = ['place_id', 'phone', 'postcode', 'website-site', 'website-page', 'name', 'town'] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];
export type KeyState = 'confirmed' | 'contradicted' | 'silent';

/** Query keys that, confirmed by structured evidence, pin the identity down (identity.input-confirmed). */
const PINNING_KEYS: ReadonlySet<QueryKey> = new Set(['place_id', 'phone', 'postcode', 'website-page']);
const NON_WORD = /[^\p{L}\p{N}]+/gu;
/** Providers that discover a website by searching the web (stage "discover"). */
const SEARCH_SOURCES: ReadonlySet<string> = new Set(PROVIDER_NAMES.filter((name) => PROVIDER_DECLARATIONS[name].stage === 'discover'));

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
  /** For a whole-business query: 2 for the site's head office, 1 for another place its markup describes, else 0. */
  sitePlaceRank: number;
  /** A search's first result that is exactly the candidate's own inner page (identity.independent-agreement); null when none. */
  searchPage: SearchPage | null;
  /** For a branch-page query: the candidate's own page is another URL for it (an alias), neither confirmed nor contradicted. */
  isAliasPage: boolean;
  /** True when the query's site is confirmed and its name is the only contradiction (identity.name-mismatch). */
  isNameMismatch: boolean;
  /** True when one of the candidate's names equals the query's, not just contains it. */
  isNameExact: boolean;
  /** The candidate's postcodes, to tell listings in one building from branches elsewhere. */
  postcodes: Set<string>;
}

/** A search provider's first own-site result agreeing with a candidate's listed page. */
export interface SearchPage {
  url: string;
  sources: string[];
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

/** Compares one query key with a candidate's values. */
function matchKey(key: QueryKey, query: Query, records: readonly SourceRecord[], listedPaths: ReadonlySet<string>): KeyMatch {
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
    // Another URL for the same branch (/bookshops/reading-broad-street, an old /healthandfitness/york that redirects),
    // or a page the query's listing page links to, is neither: only a clearly different page contradicts.
    const isOtherPage = (path: string): boolean => !isRelatedPath(path, queryPath) && !listedPaths.has(path);
    state = state === 'silent' && onSite.some((item) => isOtherPage(pagePath(item.value.url))) ? 'contradicted' : state;
  } else if (key === 'name' && query.name !== null) {
    const items = fieldItems(records, 'name');
    // A query's town that the place's name leaves out ("Michael Poole Nunthorpe" for a listing in Nunthorpe) isn't a mismatch.
    const placeWords = new Set(fieldItems(records, 'address').flatMap((item) => [
      ...item.value.lines, item.value.town ?? '', item.value.county ?? '', item.value.formatted ?? '',
    ].flatMap((part) => nameTokens(part))));
    const withoutPlace = nameTokens(query.name).filter((word) => !placeWords.has(word)).join(' ');
    const queryName = query.name;
    const isCompatible = (name: string): boolean => compareQueryName(queryName, name) !== 'incompatible'
      || (withoutPlace !== '' && compareQueryName(withoutPlace, name) !== 'incompatible');
    for (const item of items.filter((candidate) => isCompatible(candidate.value))) {
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
function assessCandidate(candidate: Candidate, query: Query, listedPaths: ReadonlySet<string>): CandidateAssessment {
  const keys = QUERY_KEYS.map((key) => matchKey(key, query, candidate.records, listedPaths));
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
    isAliasPage: isAliasPage(candidate, query),
    searchPage: searchPageFor(candidate, query),
    sitePlaceRank: !isWholeBusinessQuery ? 0
      : candidate.records.some((record) => record.role === 'head-office') ? 2
        : candidate.records.some((record) => isSiteMarkupPlace(record, querySite)) ? 1 : 0,
    isNameMismatch,
    isNameExact: query.name !== null && fieldItems(candidate.records, 'name').some((item) => compareNames(item.value, query.name ?? '') === 'equal'),
    postcodes: new Set(fieldItems(candidate.records, 'address').map((item) => item.value.postcode).filter((postcode) => postcode !== null)),
  };
}

/** With no website asked about, a search's first result that is exactly an inner page a structured record of the candidate gives. */
function searchPageFor(candidate: Candidate, query: Query): SearchPage | null {
  const pages = new Map(fieldItems(candidate.records, 'website')
    .filter((item) => item.quality === 'structured' && !isSiteRoot(item.value.url))
    .map((item) => [`${item.value.domain}${pagePath(item.value.url)}`, item.value.url]));
  const ownOrigins = new Set(candidate.records.map((record) => record.origin));
  const searches = query.website !== null ? [] : candidate.brandRecords.filter((record) => SEARCH_SOURCES.has(record.source) && !ownOrigins.has(record.origin));
  const matches = searches.flatMap((record) => fieldItems([record], 'website')
    .map((item) => ({ url: pages.get(`${item.value.domain}${pagePath(item.value.url)}`), source: record.source })))
    .filter((match) => match.url !== undefined);
  const url = matches[0]?.url;
  return url === undefined ? null : { url, sources: [...new Set(matches.map((match) => match.source))] };
}

/**
 * A sole leader known from one origin, whose listed page a search found first, has a second, independent origin: the
 * search stands in for a website given in the query (docs/confidence.md).
 */
function withSearchAgreement(assessment: CandidateAssessment): CandidateAssessment {
  const page = assessment.searchPage;
  const isSingleOrigin = assessment.baseRule === 'identity.single-structured' || assessment.baseRule === 'identity.single-loose';
  return page === null || !isSingleOrigin ? assessment : {
    ...assessment,
    baseRule: 'identity.independent-agreement',
    baseScore: ruleScore('identity.independent-agreement'),
    baseReason: `${listInWords(sourceNames(assessment.candidate.records))}'s listing and ${listInWords(page.sources)}'s first result agree on the page ${page.url}`,
  };
}

/** True when, for a branch page asked about, a candidate's page on the site is an alias of it rather than the page itself. */
function isAliasPage(candidate: Candidate, query: Query): boolean {
  const website = query.website;
  const queryPath = website === null || isSiteRoot(website.url) ? null : pagePath(website.url);
  return website !== null && queryPath !== null && fieldItems(candidate.records, 'website').some((item) => isSameSite(item.value.domain, website.domain)
    && !isSiteRoot(item.value.url) && pagePath(item.value.url) !== queryPath && isRelatedPath(pagePath(item.value.url), queryPath));
}

/** True when a record is the query's own site describing a place in its markup: a structured address or phone. */
function isSiteMarkupPlace(record: SourceRecord, querySite: string | null): boolean {
  const site = recordSite(record);
  return record.source === 'web-fetch' && querySite !== null && site !== null && isSameSite(site, querySite)
    && record.evidence.some((item) => (item.field === 'address' || item.field === 'phone') && item.quality === 'structured');
}

/**
 * Ranks how well two candidates match the query: a confirmed place ID, a matching name, for a whole-business query the
 * site's head office and then a place its markup describes, an alias of a branch page asked about, most confirmed keys, fewest contradictions, then (in one building only) the exact name. 0 is a tie. How many sources back a candidate
 * isn't a match to the query, so it never breaks a tie (docs/confidence.md: identity.tie).
 */
function rankDifference(first: CandidateAssessment, second: CandidateAssessment): number {
  const placeIdRank = (assessment: CandidateAssessment): number => (
    assessment.keys.some((match) => match.key === 'place_id' && match.state === 'confirmed') ? 1 : 0
  );
  const count = (assessment: CandidateAssessment, state: KeyState): number => assessment.keys.filter((match) => match.state === state).length;
  return placeIdRank(second) - placeIdRank(first)
    || Number(first.isNameMismatch) - Number(second.isNameMismatch)
    || second.sitePlaceRank - first.sitePlaceRank
    || count(second, 'confirmed') - count(first, 'confirmed')
    || count(first, 'contradicted') - count(second, 'contradicted')
    || Number(second.isAliasPage) - Number(first.isAliasPage)
    || (isSameBuilding(first, second) ? Number(second.isNameExact) - Number(first.isNameExact) : 0);
}

/**
 * True when the candidates are one place listed several times: all in one building, and sharing a phone (a branch's
 * sales and lettings listings) or all named alike (a thin duplicate listing with only a postcode).
 */
function isCoListed(assessments: readonly CandidateAssessment[], countryCode: string): boolean {
  const [first, ...rest] = assessments;
  return first !== undefined && rest.every((other) => (
    (isSameBuilding(first, other) && (sharesPhone(first, other) || isNamedAlike(first, other))) || isDuplicateListing(first, other, countryCode)
  ));
}

/** The phone numbers a candidate's records give. */
function phonesOf(assessment: CandidateAssessment): Set<string> {
  return new Set(fieldItems(assessment.candidate.records, 'phone').map((item) => item.value.e164));
}

/** True when two candidates give a phone number in common. */
function sharesPhone(first: CandidateAssessment, second: CandidateAssessment): boolean {
  const secondPhones = phonesOf(second);
  return [...phonesOf(first)].some((phone) => secondPhones.has(phone));
}

/** True when two candidates have a name in common, compared as names. */
function isNamedAlike(first: CandidateAssessment, second: CandidateAssessment): boolean {
  const namesOf = (assessment: CandidateAssessment): string[] => fieldItems(assessment.candidate.records, 'name').map((item) => item.value);
  return namesOf(first).some((name) => namesOf(second).some((otherName) => compareNames(name, otherName) === 'equal'));
}

/** The website pages a candidate's records give, as site and path, ignoring the scheme and www. */
function pagesOf(assessment: CandidateAssessment): Set<string> {
  return new Set(fieldItems(assessment.candidate.records, 'website').map((item) => `${item.value.domain}${pagePath(item.value.url)}`));
}

/**
 * True when two candidates are one place listed twice: the same name and website page, postcodes in one sector (one
 * street or two), and no phone numbers that differ. Separate branches of a chain each have their own number.
 */
function isDuplicateListing(first: CandidateAssessment, second: CandidateAssessment, countryCode: string): boolean {
  const rules = countryRules(countryCode);
  const sectorsOf = (assessment: CandidateAssessment): Set<string> => new Set(fieldItems(assessment.candidate.records, 'address')
    .flatMap((item) => (item.value.postcode === null ? [] : [rules.postcodeSector(item.value.postcode)])));
  const secondPages = pagesOf(second);
  const secondSectors = sectorsOf(second);
  const hasPhones = phonesOf(first).size > 0 && phonesOf(second).size > 0;
  return isNamedAlike(first, second)
    && [...pagesOf(first)].some((page) => secondPages.has(page))
    && [...sectorsOf(first)].some((sector) => secondSectors.has(sector))
    && (!hasPhones || sharesPhone(first, second));
}

/**
 * Leaders the business's own site doesn't stand behind: when the site that was read agrees with some leaders, a leader
 * with no record from that site whose website is on another site (a listing body's page about the place) drops out.
 */
function offSiteLeaders(leaders: readonly CandidateAssessment[]): CandidateAssessment[] {
  const ownSites = new Set(leaders.flatMap((leader) => leader.candidate.records)
    .filter((record) => record.source === 'web-fetch').map(recordSite).filter((site) => site !== null));
  const isOffSite = (leader: CandidateAssessment): boolean => {
    const websites = fieldItems(leader.candidate.records, 'website');
    return !leader.candidate.records.some((record) => record.source === 'web-fetch') && websites.length > 0
      && websites.every((item) => ![...ownSites].some((site) => isSameSite(site, item.value.domain)));
  };
  return ownSites.size === 0 ? [] : leaders.filter(isOffSite);
}

/**
 * True when two candidates share an address: the same postcode and building number. A postcode alone isn't a building
 * everywhere (a US ZIP code covers a district), so a different building number keeps them apart.
 */
function isSameBuilding(first: CandidateAssessment, second: CandidateAssessment): boolean {
  const secondAddresses = fieldItems(second.candidate.records, 'address').map((item) => item.value);
  return fieldItems(first.candidate.records, 'address').some((item) => item.value.postcode !== null
    && secondAddresses.some((other) => addressesEqual(item.value, other)));
}

/** The pages the query's own page links to, when it's a listing page on the query's site (docs/confidence.md). */
function queryListedPaths(candidates: readonly Candidate[], query: Query): Set<string> {
  const website = query.website;
  const paths = website === null ? [] : candidates.flatMap((candidate) => [...candidate.records, ...candidate.brandRecords])
    .filter((record) => record.source === 'web-fetch' && isSameSite(recordSite(record) ?? '', website.domain))
    .flatMap((record) => record.listedPages ?? []);
  return new Set(paths);
}

/**
 * The query as the site answered it: when its site redirected to another domain, that domain, with the same path; when
 * its page moved to another page of one place, that page.
 */
function queryAfterRedirect(candidates: readonly Candidate[], query: Query): Query {
  const website = query.website;
  const siteRecords = candidates.flatMap((candidate) => [...candidate.records, ...candidate.brandRecords]).filter((record) => record.source === 'web-fetch');
  const redirected = website === null ? undefined : siteRecords.find((record) => record.redirectedFrom !== undefined && isSameSite(record.redirectedFrom, website.domain));
  const site = redirected === undefined ? null : recordSite(redirected);
  const movedTo = siteRecords.find((record) => record.movedTo !== undefined)?.movedTo;
  const moved = movedTo === undefined ? null : normaliseUrl(movedTo);
  let answered = query;
  if (website !== null && moved !== null) {
    answered = { ...query, website: moved };
  } else if (website !== null && site !== null) {
    const url = new URL(website.url);
    url.hostname = site;
    answered = { ...query, website: { url: url.href, domain: site } };
  }
  return answered;
}

/** True when a candidate is only a listing with a branch page on the query's site, which nothing the site says joins: one of a chain's places. */
function isBranchOnly(assessment: CandidateAssessment, query: Query): boolean {
  const querySite = query.website?.domain ?? '';
  const websites = fieldItems(assessment.candidate.records, 'website').map((item) => item.value);
  const isFromSite = assessment.candidate.records.some((record) => record.source === 'web-fetch');
  return !isFromSite && websites.length > 0 && websites.every((website) => isSameSite(website.domain, querySite) && !isSiteRoot(website.url));
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
  query = queryAfterRedirect(candidates, query);
  const listedPaths = queryListedPaths(candidates, query);
  const assessments = candidates.map((candidate) => assessCandidate(candidate, query, listedPaths));
  const consistent = assessments.filter((assessment) => assessment.isConsistent).sort(compareAssessments);
  const rejected = assessments.filter((assessment) => !assessment.isConsistent);
  const ranked = consistent[0];
  const tied = ranked === undefined ? [] : consistent.filter((assessment) => rankDifference(ranked, assessment) === 0);
  const offSite = tied.length > 1 ? offSiteLeaders(tied) : [];
  const leaders = tied.filter((assessment) => !offSite.includes(assessment));
  // In a tie, a search's pick of one listing's page doesn't choose between them.
  const first = ranked !== undefined && leaders.length === 1 && leaders[0] === ranked ? withSearchAgreement(ranked) : ranked;
  const others = [...offSite, ...consistent.slice(tied.length)];
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
    if (offSite.length > 0) {
      const offSiteNames = offSite.map((assessment) => {
        const name = fieldItems(assessment.candidate.records, 'name')[0]?.value ?? 'an unnamed place';
        return `${name} (${fieldItems(assessment.candidate.records, 'website')[0]?.value.domain ?? 'another site'})`;
      });
      reasons.push(`${listInWords(offSiteNames)} matched as well, but ${offSite.length === 1 ? 'its website isn\'t' : 'their websites aren\'t'} on the business's own site, which agrees with the others`);
    }
    if (leaders.length > 1 && isCoListed(leaders, query.country)) {
      rules.push('identity.co-listed');
      reasons.push(leaders.every((leader) => isSameBuilding(first, leader))
        ? `${leaders.length} listings share this address and phone, so they're one place; the first is shown`
        : `${leaders.length} listings share a name and website page, close together and with no differing phone, so they're one place; the first is shown`);
    } else if (leaders.length > 1) {
      confidence = Math.floor(first.baseScore / leaders.length);
      rules.push('identity.tie');
      const isFromSearch = leaders.some((leader) => leader.candidate.records.some((record) => record.source === 'google-places-api'));
      // A search returns only its best few places, so a tie built from one may not list every match.
      reasons.push(`${leaders.length} candidates match equally; each is listed${isFromSearch ? ' (a place search returns only its best few matches, so there may be more)' : ''}`);
      const isListedTie = leaders.every((leader) => fieldItems(leader.candidate.records, 'website').some((item) => listedPaths.has(pagePath(item.value.url))));
      if (isListedTie) {
        warnings.push('The query\'s page lists several places rather than describing one. The candidates are the places it links to that a search found.');
      }
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
    const isWholeBusiness = !queryHasLocation(query) && query.website !== null;
    if (isWholeBusiness && leaderSites.size === 1 && (rules.includes('identity.tie') || leaders.every((leader) => isBranchOnly(leader, query)))) {
      rules.push('identity.chain');
      reasons.push('a chain\'s home page with no location given: the identity is the chain, and these are some of its places');
      const placesMatched = leaders.length === 1 ? 'one of its places matched' : 'several of its places match';
      warnings.push(`The query is a chain's home page with no location, and ${placesMatched}. The brand's details (name, website, logo, socials) stand for the chain; the candidates are some of its places.`);
    }
    isHeadOffice = !queryHasLocation(query) && first.candidate.records.some((record) => record.role === 'head-office');
    if (isHeadOffice) {
      rules.push('identity.head-office');
      reasons.push('a chain\'s home page with no location given: this is the head office');
      warnings.push('The query is a chain\'s home page with no location, so the identity is the head office, not a branch.');
    }
    const sourced = first.candidate.records.filter((record) => record.source !== QUERY_SOURCE);
    if (queryHasLocation(query) && sourced.length > 0 && sourced.every((record) => record.role === 'head-office')) {
      const cap = ruleScore('identity.head-office-only');
      const office = fieldItems(sourced, 'address')[0]?.value;
      const place = office?.town ?? office?.postcode ?? null;
      const where = place === null ? '' : ` (${place})`;
      confidence = Math.min(confidence, cap);
      rules.push('identity.head-office-only');
      reasons.push(`every source describes the head office${where}, not the branch asked about; capped at ${cap}`);
      warnings.push(`A branch was asked for, but the site only gives its head office's details${where}. The address and phone are the head office's, not the branch's.`);
    }
    // A site-wide Organization on a network's agent page names the network, not the agent (docs/confidence.md).
    const isInnerPage = query.website !== null && !isSiteRoot(query.website.url);
    if (isInnerPage && sourced.length > 0 && sourced.every((record) => record.scope === 'brand')) {
      const cap = ruleScore('identity.site-brand-only');
      const siteName = fieldItems(sourced, 'name')[0]?.value ?? null;
      confidence = Math.min(confidence, cap);
      brandConfidence = Math.min(brandConfidence, cap);
      rules.push('identity.site-brand-only');
      reasons.push(`the page asked about gives only the site's own brand${siteName === null ? '' : ` (${siteName})`}, not a place; capped at ${cap}`);
      warnings.push(`The page asked about gives no address or phone, only the site's own brand${siteName === null ? '' : ` "${siteName}"`}, which may be a network's or a parent's rather than this business's.`);
    }
  }
  return { confidence, rules, reasons, leaders, rejected, others, brandConfidence, isHeadOffice, warnings };
}
