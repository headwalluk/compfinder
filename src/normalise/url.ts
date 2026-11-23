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

/** Parses a web address, adding https:// when there's no scheme; null unless it's http(s). */
export function normaliseUrl(raw: string): WebsiteValue | null {
  const trimmed = raw.trim();
  const candidate = SCHEME_PATTERN.test(trimmed) ? trimmed : `${DEFAULT_SCHEME}${trimmed}`;
  let website: WebsiteValue | null = null;
  if (URL.canParse(candidate)) {
    const parsed = new URL(candidate);
    if (WEB_PROTOCOLS.has(parsed.protocol) && parsed.hostname.includes('.')) {
      parsed.hash = '';
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
