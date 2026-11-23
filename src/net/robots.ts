/** One Allow or Disallow line. */
interface RobotsRule {
  isAllow: boolean;
  pattern: string;
}

/** The groups of a robots.txt file, by lower-case user-agent token. */
export interface RobotsRules {
  groups: Map<string, RobotsRule[]>;
}

const COMMENT = /#.*$/;
const WILDCARD_AGENT = '*';

/** Parses robots.txt (RFC 9309): user-agent groups of allow and disallow rules. */
export function parseRobots(text: string): RobotsRules {
  const groups = new Map<string, RobotsRule[]>();
  let agents: string[] = [];
  let isCollectingAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(COMMENT, '').trim();
    const separator = line.indexOf(':');
    if (separator !== -1) {
      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (field === 'user-agent') {
        agents = isCollectingAgents ? [...agents, value.toLowerCase()] : [value.toLowerCase()];
        isCollectingAgents = true;
        for (const agent of agents) {
          groups.set(agent, groups.get(agent) ?? []);
        }
      } else if (field === 'allow' || field === 'disallow') {
        isCollectingAgents = false;
        for (const agent of agents) {
          if (value !== '') {
            groups.get(agent)?.push({ isAllow: field === 'allow', pattern: value });
          }
        }
      }
    }
  }
  return { groups };
}

/** True when a robots.txt pattern (with * and $ wildcards) matches a path. */
function patternMatches(pattern: string, path: string): boolean {
  const isAnchored = pattern.endsWith('$');
  const body = isAnchored ? pattern.slice(0, -1) : pattern;
  const expression = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}${isAnchored ? '$' : ''}`).test(path);
}

/** Whether a user agent may fetch a path: its own group (else *), the longest matching rule, allow on a tie. */
export function isPathAllowed(rules: RobotsRules, productToken: string, path: string): boolean {
  const group = rules.groups.get(productToken.toLowerCase()) ?? rules.groups.get(WILDCARD_AGENT) ?? [];
  let best: RobotsRule | null = null;
  for (const rule of group) {
    const isBetter = best === null || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.isAllow);
    if (patternMatches(rule.pattern, path) && isBetter) {
      best = rule;
    }
  }
  return best === null || best.isAllow;
}
