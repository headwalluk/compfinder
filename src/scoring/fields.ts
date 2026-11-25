import type { FieldName } from '../lookup/fields.js';
import {
  QUERY_SOURCE,
  type FieldValues,
  type LogoSource,
  type Query,
  type SourceName,
  type SourceRecord,
} from '../lookup/types.js';
import { compareNames, nameTokens } from '../normalise/name.js';
import { isSiteRoot, pagePath } from '../normalise/url.js';
import type { ProviderName } from '../providers/declarations.js';
import { fieldItems, type FieldItem } from './evidence.js';
import { listInWords, type IdentityResult } from './identity.js';
import { canonicalValue, valuesEqual } from './match.js';
import { ruleScore, type RuleId } from './rules.js';

/** Fields about one place, capped by the identity. */
const LOCATION_FIELDS: ReadonlySet<FieldName> = new Set(['name', 'address', 'phone', 'email', 'place_id']);
/** Fields a head-office record can't answer for a branch. */
const HEAD_OFFICE_CAPPED_FIELDS: ReadonlySet<FieldName> = new Set(['address', 'phone', 'email']);

const LOGO_RULES: Readonly<Record<LogoSource, RuleId>> = {
  'schema-org': 'logo.schema-org',
  'manifest-icon': 'logo.manifest-icon',
  'social-image': 'logo.social-image',
  favicon: 'logo.favicon',
};

export interface FieldContext {
  query: Query;
  priority: Readonly<Record<FieldName, readonly ProviderName[]>>;
  identity: IdentityResult;
  /** True when the query names a place (a branch), not a whole business. */
  isBranchQuery: boolean;
  /** Where the page asked about redirected to, when it moved to another page of one place; else null. */
  pageMovedTo: string | null;
}

/** A value with its own score: a whole field, or one social profile. */
export interface ScoredValue<Value> {
  value: Value;
  confidence: number;
  rules: RuleId[];
  reasons: string[];
  sources: SourceName[];
}

export interface Conflict<Value> {
  value: Value;
  sources: SourceName[];
}

export interface FieldResult<Field extends FieldName> {
  field: Field;
  /** The chosen value; for socials, every profile with its own score. Null when nothing was found. */
  value: Field extends 'socials' ? Array<ScoredValue<FieldValues['socials']>> : FieldValues[Field] | null;
  confidence: number;
  rules: RuleId[];
  reasons: string[];
  sources: SourceName[];
  /** The source the shown value was taken from. */
  valueSource: SourceName | null;
  conflicts: Array<Conflict<FieldValues[Field]>>;
  /** Every item considered, with whether it agreed with the chosen value; for --explain. */
  evidence: Array<{ item: FieldItem<Field>; isAgreed: boolean }>;
}

interface ValueGroup<Field extends FieldName> {
  items: Array<FieldItem<Field>>;
  /** Distinct non-query origins. */
  origins: string[];
  hasQuery: boolean;
  isStructured: boolean;
  /** Best (lowest) priority rank among the group's sources; the query ranks first. */
  priorityRank: number;
}

/** A source's rank in a field's priority list: the query first, unlisted sources last. */
function priorityRank(field: FieldName, source: SourceName, context: FieldContext): number {
  const order = context.priority[field];
  let rank: number;
  if (source === QUERY_SOURCE) {
    rank = -1;
  } else {
    const position = order.indexOf(source);
    rank = position === -1 ? order.length : position;
  }
  return rank;
}

/** Splits items into groups of equal values, keeping first-seen order. */
function groupItems<Field extends FieldName>(field: Field, items: Array<FieldItem<Field>>, context: FieldContext): Array<ValueGroup<Field>> {
  const buckets: Array<Array<FieldItem<Field>>> = [];
  for (const item of items) {
    const bucket = buckets.find((candidate) => candidate[0] !== undefined && valuesEqual(field, candidate[0].value, item.value));
    if (bucket === undefined) {
      buckets.push([item]);
    } else {
      bucket.push(item);
    }
  }
  return buckets.map((bucket) => ({
    items: bucket,
    origins: [...new Set(bucket.filter((item) => item.record.source !== QUERY_SOURCE).map((item) => item.record.origin))],
    hasQuery: bucket.some((item) => item.record.source === QUERY_SOURCE),
    isStructured: bucket.some((item) => item.record.source !== QUERY_SOURCE && item.quality === 'structured'),
    priorityRank: Math.min(...bucket.map((item) => priorityRank(field, item.record.source, context))),
  }));
}

/** Specificity of a group's value: more distinct words in a name wins a tie, so repeating a word gains nothing. */
function specificity<Field extends FieldName>(field: Field, group: ValueGroup<Field>): number {
  const first = group.items[0];
  return field === 'name' && first !== undefined ? new Set(nameTokens(first.value as string)).size : 0;
}

/** Orders value groups for a field, best first (docs/confidence.md: fields). */
function compareGroups<Field extends FieldName>(field: Field, first: ValueGroup<Field>, second: ValueGroup<Field>): number {
  const canonical = (group: ValueGroup<Field>): string => (group.items[0] === undefined ? '' : canonicalValue(field, group.items[0].value));
  const isNameClash = field === 'name' && first.items[0] !== undefined && second.items[0] !== undefined
    && compareNames(first.items[0].value as string, second.items[0].value as string) === 'incompatible';
  return second.origins.length - first.origins.length
    || Number(second.isStructured) - Number(first.isStructured)
    || (isNameClash ? Number(second.hasQuery) - Number(first.hasQuery) : 0)
    || specificity(field, second) - specificity(field, first)
    || first.priorityRank - second.priorityRank
    || canonical(first).localeCompare(canonical(second));
}

/** Sources of some items, in priority order, without repeats. */
function orderedSources<Field extends FieldName>(field: Field, items: Array<FieldItem<Field>>, context: FieldContext): SourceName[] {
  const sources = [...new Set(items.map((item) => item.record.source))];
  return sources.sort((first, second) => priorityRank(field, first, context) - priorityRank(field, second, context));
}

/** The base rule for a winning group (05: field rules). */
function baseRule<Field extends FieldName>(group: ValueGroup<Field>): RuleId {
  let rule: RuleId;
  if (group.origins.length >= 2) {
    rule = 'field.independent-agreement';
  } else if (group.origins.length === 1 && group.hasQuery) {
    rule = group.isStructured ? 'field.input-confirmed' : 'field.input-confirmed-loose';
  } else if (group.origins.length === 1) {
    rule = group.isStructured ? 'field.single-structured' : 'field.single-loose';
  } else {
    rule = 'field.input-only';
  }
  return rule;
}

/** The reason for a base rule, in words. */
function baseReason(rule: RuleId, sources: SourceName[]): string {
  const providers = sources.filter((source) => source !== QUERY_SOURCE);
  const reasons: Partial<Record<RuleId, string>> = {
    'field.independent-agreement': `${listInWords(providers)} agree`,
    'field.input-confirmed': `${listInWords(providers)} confirms the query's value`,
    'field.input-confirmed-loose': `${listInWords(providers)} confirms the query's value, from loose page content`,
    'field.single-structured': `one source only (${listInWords(providers)})`,
    'field.single-loose': `one source only (${listInWords(providers)}), from loose page content`,
    'field.input-only': 'from the query only; no source confirms it',
  };
  return reasons[rule] ?? rule;
}

/** Picks the value to show from the winning group: the most specific page for a website, else the top-priority source. */
function chooseValue<Field extends FieldName>(field: Field, group: ValueGroup<Field>, context: FieldContext): FieldItem<Field> | null {
  const sourced = group.items.filter((item) => item.record.source !== QUERY_SOURCE);
  const pool = sourced.length > 0 ? sourced : group.items;
  let chosen: FieldItem<Field> | undefined;
  const queryItem = group.items.find((item) => item.record.source === QUERY_SOURCE);
  const queryUrl = field === 'website' && queryItem !== undefined ? (queryItem.value as FieldValues['website']).url : null;
  // An inner page asked about that a source gives exactly; one that redirected to another URL shows where it went.
  const isConfirmedPage = queryUrl !== null && !isSiteRoot(queryUrl) && sourced.some((item) => item.quality === 'structured'
    && pagePath((item.value as FieldValues['website']).url) === pagePath(queryUrl));
  const movedPath = field === 'website' && context.pageMovedTo !== null ? pagePath(context.pageMovedTo) : null;
  const movedItem = movedPath === null ? undefined
    : sourced.find((item) => item.quality === 'structured' && pagePath((item.value as FieldValues['website']).url) === movedPath);
  if (field === 'website' && queryItem !== undefined && (context.identity.rules.includes('identity.chain') || isConfirmedPage)) {
    // A chain's website is the home page asked about; a page asked about and confirmed is shown as given.
    chosen = queryItem;
  } else if (movedItem !== undefined) {
    chosen = movedItem;
  } else if (field === 'website') {
    const trusted = group.items.filter((item) => item.record.source === QUERY_SOURCE || item.quality === 'structured');
    const choices = trusted.length > 0 ? trusted : group.items;
    chosen = [...choices].sort((first, second) => (
      pagePath((second.value as FieldValues['website']).url).length - pagePath((first.value as FieldValues['website']).url).length
    ))[0];
  } else {
    // Names that compare equal can still be spelt differently ("Estate Agents Estate Agents"): show the spelling most give.
    const spellingCount = (item: FieldItem<Field>): number => (field === 'name'
      ? pool.filter((other) => String(other.value).toLowerCase() === String(item.value).toLowerCase()).length
      : 0);
    chosen = [...pool].sort((first, second) => (
      spellingCount(second) - spellingCount(first)
      || priorityRank(field, first.record.source, context) - priorityRank(field, second.record.source, context)
    ))[0];
  }
  return chosen ?? null;
}

/** Lowers a score to a cap, recording the rule and reason only when it changes the score. */
function applyCap(scored: { confidence: number; rules: RuleId[]; reasons: string[] }, rule: RuleId, cap: number, reason: string): void {
  if (scored.confidence > cap) {
    scored.confidence = cap;
    scored.rules.push(rule);
    scored.reasons.push(reason);
  }
}

/** True when every non-query record behind a group is a head-office record. */
function isHeadOfficeOnly<Field extends FieldName>(group: ValueGroup<Field>): boolean {
  const sourced = group.items.filter((item) => item.record.source !== QUERY_SOURCE);
  return sourced.length > 0 && sourced.every((item) => item.record.role === 'head-office');
}

/** Scores one ordinary field (not logo or socials) for the leading candidate. */
export function scoreField<Field extends Exclude<FieldName, 'logo' | 'socials'>>(
  field: Field,
  records: readonly SourceRecord[],
  context: FieldContext,
): FieldResult<Field> {
  const items = fieldItems(records, field);
  const groups = groupItems(field, items, context).sort((first, second) => compareGroups(field, first, second));
  const winner = groups[0];
  const result: FieldResult<Field> = {
    field,
    value: null as FieldResult<Field>['value'],
    confidence: 0,
    rules: [],
    reasons: [],
    sources: [],
    valueSource: null,
    conflicts: [],
    evidence: items.map((item) => ({ item, isAgreed: winner?.items.includes(item) ?? false })),
  };

  if (winner === undefined) {
    result.rules.push('field.none');
  } else {
    const rule = baseRule(winner);
    const chosen = chooseValue(field, winner, context);
    result.value = (chosen?.value ?? null) as FieldResult<Field>['value'];
    result.valueSource = chosen?.record.source ?? null;
    result.sources = orderedSources(field, winner.items, context);
    result.confidence = ruleScore(rule);
    result.rules.push(rule);
    result.reasons.push(baseReason(rule, result.sources));

    const winnerFirst = winner.items[0];
    const losers = groups.slice(1).filter((group) => !(field === 'name' && winnerFirst !== undefined && group.items[0] !== undefined
      && compareNames(group.items[0].value as string, winnerFirst.value as string) === 'compatible'));
    if (losers.length > 0) {
      const allOrigins = new Set([winner, ...losers].flatMap((group) => group.origins));
      if (allOrigins.size > 0) {
        result.confidence = Math.floor((result.confidence * winner.origins.length) / allOrigins.size);
      }
      result.rules.push('field.conflict');
      for (const loser of losers) {
        const loserFirst = loser.items[0];
        if (loserFirst !== undefined) {
          const sources = orderedSources(field, loser.items, context);
          result.conflicts.push({ value: loserFirst.value, sources });
          result.reasons.push(`${listInWords(sources)} give${sources.length === 1 ? 's' : ''} ${canonicalValue(field, loserFirst.value)}`);
        }
      }
    }
    const leaderRecords = context.identity.leaders[0]?.candidate.records ?? [];
    const isIdentityRecord = field === 'place_id' && (rule === 'field.single-structured' || rule === 'field.single-loose')
      && winner.items.some((item) => leaderRecords.includes(item.record));
    if (isIdentityRecord) {
      result.confidence = context.identity.confidence;
      result.rules.push('field.identity-record');
      result.reasons.push(`the place ID of a record the identity rests on (identity ${context.identity.confidence})`);
    }
    if (rule !== 'field.input-only') {
      if (context.isBranchQuery && HEAD_OFFICE_CAPPED_FIELDS.has(field) && isHeadOfficeOnly(winner)) {
        applyCap(result, 'field.head-office', ruleScore('field.head-office'), 'head-office page, not the branch\'s');
      }
      const isBranchPage = field === 'website' && result.value !== null && !isSiteRoot((result.value as FieldValues['website']).url);
      // A chain's identity is its brand: even its name and email belong to the brand, not to one place.
      const isChain = context.identity.rules.includes('identity.chain');
      if ((LOCATION_FIELDS.has(field) && !isChain) || isBranchPage) {
        applyCap(result, 'field.identity-cap', context.identity.confidence, `capped at the identity's confidence (${context.identity.confidence})`);
      } else {
        applyCap(result, 'field.brand-cap', context.identity.brandConfidence, `capped at the brand's confidence (${context.identity.brandConfidence})`);
      }
    }
  }
  return result;
}

/** Orders logo candidates best first: highest ceiling, then the widest. */
export function rankLogoItems(items: ReadonlyArray<FieldItem<'logo'>>): Array<FieldItem<'logo'>> {
  const ceiling = (item: FieldItem<'logo'>): number => ruleScore(LOGO_RULES[item.value.source]);
  return [...items].sort((first, second) => ceiling(second) - ceiling(first) || (second.value.width ?? 0) - (first.value.width ?? 0));
}

/** Scores the logo: the best candidate's ceiling, capped by the website's confidence (05: logo rules). */
export function scoreLogo(records: readonly SourceRecord[], websiteConfidence: number, context: FieldContext): FieldResult<'logo'> {
  const items = fieldItems(records, 'logo');
  const best = rankLogoItems(items)[0];
  const result: FieldResult<'logo'> = {
    field: 'logo',
    value: best?.value ?? null,
    confidence: 0,
    rules: [],
    reasons: [],
    sources: best === undefined ? [] : [best.record.source],
    valueSource: best?.record.source ?? null,
    conflicts: [],
    evidence: items.map((item) => ({ item, isAgreed: item === best })),
  };
  if (best === undefined) {
    result.rules.push('field.none');
  } else {
    const rule = LOGO_RULES[best.value.source];
    result.confidence = ruleScore(rule);
    result.rules.push(rule);
    result.reasons.push(best.evidence.reference.detail);
    applyCap(result, 'logo.website-cap', websiteConfidence, `capped at the website's confidence (${websiteConfidence})`);
    applyCap(result, 'field.brand-cap', context.identity.brandConfidence, `capped at the brand's confidence (${context.identity.brandConfidence})`);
  }
  return result;
}

/** Scores each social profile on its own; the field's confidence is the best profile's (05: socials). */
export function scoreSocials(records: readonly SourceRecord[], context: FieldContext): FieldResult<'socials'> {
  const items = fieldItems(records, 'socials');
  const groups = groupItems('socials', items, context);
  const profiles: Array<ScoredValue<FieldValues['socials']>> = [];
  for (const group of groups) {
    const first = group.items[0];
    if (first !== undefined) {
      const rule = baseRule(group);
      const sources = orderedSources('socials', group.items, context);
      const profile = { value: first.value, confidence: ruleScore(rule), rules: [rule], reasons: [baseReason(rule, sources)], sources };
      if (rule !== 'field.input-only') {
        applyCap(profile, 'field.brand-cap', context.identity.brandConfidence, `capped at the brand's confidence (${context.identity.brandConfidence})`);
      }
      profiles.push(profile);
    }
  }
  profiles.sort((first, second) => first.value.network.localeCompare(second.value.network) || first.value.url.localeCompare(second.value.url));
  const best = [...profiles].sort((first, second) => second.confidence - first.confidence)[0];
  return {
    field: 'socials',
    value: profiles,
    confidence: best?.confidence ?? 0,
    rules: best?.rules ?? ['field.none'],
    reasons: best?.reasons ?? [],
    sources: [...new Set(profiles.flatMap((profile) => profile.sources))],
    valueSource: null,
    conflicts: [],
    evidence: items.map((item) => ({ item, isAgreed: true })),
  };
}

