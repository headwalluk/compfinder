/** Legal suffixes dropped from the end of a name before comparing. */
const LEGAL_SUFFIXES = new Set(['ltd', 'limited', 'plc', 'llp', 'inc', 'llc', 'gmbh']);
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_RUN = /\s+/g;

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
    tokens.pop();
  }
  return tokens.join(' ');
}

/** The words of a comparable name. */
export function nameTokens(name: string): string[] {
  const comparable = comparableName(name);
  return comparable === '' ? [] : comparable.split(' ');
}

/** Equal after normalising; compatible when one name's words are all in the other; else incompatible. */
export function compareNames(first: string, second: string): NameRelation {
  const firstTokens = new Set(nameTokens(first));
  const secondTokens = new Set(nameTokens(second));
  let relation: NameRelation;
  if (comparableName(first) === comparableName(second)) {
    relation = 'equal';
  } else if (firstTokens.size > 0 && secondTokens.size > 0
    && ([...firstTokens].every((token) => secondTokens.has(token)) || [...secondTokens].every((token) => firstTokens.has(token)))) {
    relation = 'compatible';
  } else {
    relation = 'incompatible';
  }
  return relation;
}
