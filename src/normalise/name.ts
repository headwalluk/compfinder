/** Legal suffixes dropped from the end of a name before comparing. */
const LEGAL_SUFFIXES = new Set(['ltd', 'limited', 'plc', 'llp', 'inc', 'llc', 'gmbh', 'co', 'company']);
/** Suffixes that may follow "and" ("& Co"), which goes with them. */
const JOINED_SUFFIXES = new Set(['co', 'company']);
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_RUN = /\s+/g;
/** Connecting words that don't tell two names apart ("Agents in Reading", "Reading Agents"). */
const CONNECTING_WORDS = new Set(['and', 'in', 'at', 'of', 'the', 'for']);
/** Words at least this long lose a plain plural "s" before comparing ("Lettings" and "Letting"). */
const MIN_PLURAL_WORD_LENGTH = 4;
/** Words shorter than this must match exactly when comparing a typed name. */
const MIN_TYPO_WORD_LENGTH = 5;

export type NameRelation = 'equal' | 'compatible' | 'incompatible';

/** Normalises a business name for comparison only, never for output. */
export function comparableName(name: string): string {
  const tokens = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? '')) {
    const removed = tokens.pop() ?? '';
    if (JOINED_SUFFIXES.has(removed) && tokens.length > 1 && tokens[tokens.length - 1] === 'and') {
      tokens.pop();
    }
  }
  const words = tokens.filter((token) => !CONNECTING_WORDS.has(token));
  return (words.length > 0 ? words : tokens).map(singular).join(' ');
}

/** A word without a plain plural "s" (agents -> agent), leaving "ss" and short words alone. */
function singular(word: string): string {
  return word.length >= MIN_PLURAL_WORD_LENGTH && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** The words of a comparable name. */
export function nameTokens(name: string): string[] {
  const comparable = comparableName(name);
  return comparable === '' ? [] : comparable.split(' ');
}

/** Equal when the same words remain after normalising, in any order; compatible when one name's words are all in the other; else incompatible. */
export function compareNames(first: string, second: string): NameRelation {
  const firstTokens = new Set(nameTokens(first));
  const secondTokens = new Set(nameTokens(second));
  let relation: NameRelation;
  const isSameWords = firstTokens.size === secondTokens.size && [...firstTokens].every((token) => secondTokens.has(token));
  if (comparableName(first) === comparableName(second) || (firstTokens.size > 0 && isSameWords)) {
    relation = 'equal';
  } else if (firstTokens.size > 0 && secondTokens.size > 0
    && ([...firstTokens].every((token) => secondTokens.has(token)) || [...secondTokens].every((token) => firstTokens.has(token)))) {
    relation = 'compatible';
  } else {
    relation = 'incompatible';
  }
  return relation;
}

/** True when two words differ by at most one edit: a substitution, insertion, deletion or swap of neighbours. */
export function isOneEditApart(first: string, second: string): boolean {
  let isNear = first === second;
  if (!isNear && Math.abs(first.length - second.length) <= 1) {
    let start = 0;
    while (start < first.length && first[start] === second[start]) {
      start += 1;
    }
    const firstRest = first.slice(start);
    const secondRest = second.slice(start);
    const isSwap = firstRest.length === secondRest.length && firstRest.length >= 2
      && firstRest[0] === secondRest[1] && firstRest[1] === secondRest[0] && firstRest.slice(2) === secondRest.slice(2);
    isNear = isSwap || firstRest.slice(1) === secondRest.slice(1) || firstRest === secondRest.slice(1) || firstRest.slice(1) === secondRest;
  }
  return isNear;
}

/** Compares a name typed into the query with a source's name, forgiving one typo in each longer word. */
export function compareQueryName(queryName: string, sourceName: string): NameRelation {
  let relation = compareNames(queryName, sourceName);
  const queryTokens = nameTokens(queryName);
  const sourceTokens = nameTokens(sourceName);
  const isNearMatch = (token: string, others: readonly string[]): boolean => others.some((other) => (
    token === other || (Math.min(token.length, other.length) >= MIN_TYPO_WORD_LENGTH && isOneEditApart(token, other))
  ));
  if (relation === 'incompatible' && queryTokens.length > 0 && sourceTokens.length > 0
    && (queryTokens.every((token) => isNearMatch(token, sourceTokens)) || sourceTokens.every((token) => isNearMatch(token, queryTokens)))) {
    relation = 'compatible';
  }
  return relation;
}
