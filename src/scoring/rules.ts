/**
 * Every confidence rule, with its number. The rules and the reasoning behind each number are in
 * docs/confidence.md; a test fails when a rule here is missing from that page or from the tests.
 */
export const RULES = {
  'identity.input-confirmed': { score: 100, summary: 'A place ID, phone, postcode or page URL from the query is confirmed by structured evidence' },
  'identity.independent-agreement': { score: 100, summary: 'Records from two or more independent sources describe the same place' },
  'identity.single-structured': { score: 60, summary: 'One source, with structured evidence' },
  'identity.single-loose': { score: 40, summary: 'One source, with loose evidence only' },
  'identity.none': { score: 0, summary: 'No candidate is consistent with the query' },
  'identity.tie': { score: null, summary: 'Several candidates are equally likely: the score is divided between them' },
  'identity.head-office': { score: null, summary: 'A chain\'s home page with no location: the identity is the head office' },

  'field.independent-agreement': { score: 100, summary: 'Two or more independent sources agree' },
  'field.input-confirmed': { score: 100, summary: 'One source confirms the query\'s value, with structured evidence' },
  'field.input-confirmed-loose': { score: 60, summary: 'One source confirms the query\'s value, with loose evidence only' },
  'field.single-structured': { score: 60, summary: 'One source only, read from structured data' },
  'field.single-loose': { score: 40, summary: 'One source only, read from loose page content' },
  'field.input-only': { score: 20, summary: 'Only the query gave this value; no source confirms it' },
  'field.none': { score: 0, summary: 'Nothing found' },
  'field.identity-record': { score: null, summary: 'A place ID from a record the identity rests on is as sure as the identity' },
  'field.conflict': { score: null, summary: 'Sources disagree: the winner\'s share of the independent sources scales the score' },
  'field.head-office': { score: 30, summary: 'A branch was asked for, but the value comes only from a head-office record' },
  'field.identity-cap': { score: null, summary: 'A value about one place can\'t be surer than the identity' },
  'field.brand-cap': { score: null, summary: 'A value about the whole brand can\'t be surer than the brand' },

  'logo.schema-org': { score: 100, summary: 'The site\'s own schema.org logo' },
  'logo.manifest-icon': { score: 60, summary: 'A large web app icon or apple-touch-icon' },
  'logo.social-image': { score: 40, summary: 'A social sharing image (og:image, twitter:image)' },
  'logo.favicon': { score: 40, summary: 'A favicon' },
  'logo.website-cap': { score: null, summary: 'A logo can\'t be surer than the website it came from' },
} as const satisfies Record<string, { score: number | null; summary: string }>;

export type RuleId = keyof typeof RULES;

/** Every rule ID, in definition order. */
export const RULE_IDS = Object.keys(RULES) as RuleId[];

/** The fixed score a rule awards, for rules that award one. */
export function ruleScore(rule: RuleId): number {
  const score: number | null = RULES[rule].score;
  if (score === null) {
    throw new Error(`Rule ${rule} adjusts a score; it doesn't award one`);
  }
  return score;
}
