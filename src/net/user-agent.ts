import { packageVersion } from '../package-files.js';

const PROJECT_URL = 'https://github.com/headwalluk/compfinder';

/** The User-Agent for every request: the tool, its version and where to read about it. No operator details. */
export function userAgent(): string {
  return `compfinder/${packageVersion()} (+${PROJECT_URL})`;
}

/** The token robots.txt groups are matched against. */
export const ROBOTS_PRODUCT_TOKEN = 'compfinder';
