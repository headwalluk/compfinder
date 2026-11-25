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
/** Rules kept per group, and the longest pattern read: together they bound the matching work (docs/security.md). */
const MAX_RULES_PER_GROUP = 1000;
const MAX_PATTERN_CHARS = 512;

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
          const group = groups.get(agent);
          if (group !== undefined && value !== '' && value.length <= MAX_PATTERN_CHARS && group.length < MAX_RULES_PER_GROUP) {
            group.push({ isAllow: field === 'allow', pattern: value });
          }
        }
      }
    }
  }
  return { groups };
}

/** True when a robots.txt pattern (with * and $) matches a path, in at most pattern × path steps (docs/security.md). */
function patternMatches(pattern: string, path: string): boolean {
  const isAnchored = pattern.endsWith('$');
  // Unanchored, a rule matches any path that starts with it: the same as a trailing *.
  const glob = isAnchored ? pattern.slice(0, -1) : `${pattern}*`;
  let patternIndex = 0;
  let pathIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;
  let isMatch = true;
  while (pathIndex < path.length) {
    if (patternIndex < glob.length && glob[patternIndex] === '*') {
      starIndex = patternIndex;
      resumeIndex = pathIndex;
      patternIndex += 1;
    } else if (patternIndex < glob.length && glob[patternIndex] === path[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (starIndex !== -1) {
      // Let the last * absorb one more character and retry from there.
      patternIndex = starIndex + 1;
      resumeIndex += 1;
      pathIndex = resumeIndex;
    } else {
      isMatch = false;
      break;
    }
  }
  while (isMatch && patternIndex < glob.length && glob[patternIndex] === '*') {
    patternIndex += 1;
  }
  return isMatch && patternIndex === glob.length;
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
