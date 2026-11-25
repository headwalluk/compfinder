export interface WebsiteValue {
  /** Absolute http(s) URL, without a fragment. */
  url: string;
  /** Host without a leading www. */
  domain: string;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_SCHEME = 'https://';
const WWW_PREFIX = 'www.';
/** Public suffixes removed from a domain to leave the business's own part (example.co.uk -> example). */
const PUBLIC_SUFFIXES = ['co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'com.au', 'co.nz', 'com', 'net', 'org', 'uk', 'io', 'co', 'biz', 'info', 'us', 'ie', 'eu'];

/** Query parameters that only track a click (Google Business Profile links carry utm_*); removed from every URL. */
const TRACKING_PARAMETER = /^(?:utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl)$/i;

/** Parses a web address, adding https:// when there's no scheme, dropping the fragment and tracking parameters; null unless it's http(s). */
export function normaliseUrl(raw: string): WebsiteValue | null {
  const trimmed = raw.trim();
  const candidate = SCHEME_PATTERN.test(trimmed) ? trimmed : `${DEFAULT_SCHEME}${trimmed}`;
  let website: WebsiteValue | null = null;
  if (URL.canParse(candidate)) {
    const parsed = new URL(candidate);
    if (WEB_PROTOCOLS.has(parsed.protocol) && parsed.hostname.includes('.')) {
      parsed.hash = '';
      for (const name of [...parsed.searchParams.keys()].filter((key) => TRACKING_PARAMETER.test(key))) {
        parsed.searchParams.delete(name);
      }
      website = { url: parsed.href, domain: siteHost(parsed.hostname) };
    }
  }
  return website;
}

/** The host with any leading www. removed, lower-cased. */
export function siteHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith(WWW_PREFIX) ? lower.slice(WWW_PREFIX.length) : lower;
}

/** True when two hosts are the same site: equal, or one a subdomain of the other, ignoring www. */
export function isSameSite(firstHost: string, secondHost: string): boolean {
  const first = siteHost(firstHost);
  const second = siteHost(secondHost);
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

/** The URL's path without a trailing slash, lower-cased; '' for the site root. */
export function pagePath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/\/+$/, '').toLowerCase();
}

/** True when the URL is the site's root page. */
export function isSiteRoot(url: string): boolean {
  return pagePath(url) === '';
}

/** The business's own part of a domain, as words: keenans-estateagents.co.uk -> "keenans estateagents". */
export function nameFromDomain(domain: string): string {
  const suffix = PUBLIC_SUFFIXES.find((candidate) => domain.endsWith(`.${candidate}`));
  const withoutSuffix = suffix === undefined ? domain : domain.slice(0, -suffix.length - 1);
  return (withoutSuffix.split('.').pop() ?? withoutSuffix).replace(/[-_]+/g, ' ');
}

/** Letters and digits only, lower-cased, for comparing a name with a domain: "Pure Gym" and "pure-gym" both read "puregym". */
export function compactWords(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** True when every word of one path's last segment is in the other's (/offices/chiswick and /offices/dexters-chiswick-estate-agents). */
export function isRelatedPath(first: string, second: string): boolean {
  const segmentWords = (path: string): Set<string> => new Set((path.split('/').pop() ?? '').split(/[-_.+]+/).filter((word) => word !== ''));
  const firstWords = segmentWords(first);
  const secondWords = segmentWords(second);
  const isWithin = (inner: Set<string>, outer: Set<string>): boolean => inner.size > 0 && [...inner].every((word) => outer.has(word));
  return isWithin(firstWords, secondWords) || isWithin(secondWords, firstWords);
}
