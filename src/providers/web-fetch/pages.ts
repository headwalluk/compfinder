import { isSiteRoot, pagePath, siteHost } from '../../normalise/url.js';
import type { ParsedPage } from './document.js';

/** Scores for links worth reading, by what the path or link text mentions (docs/providers.md). */
const LINK_SCORES: ReadonlyArray<[RegExp, number]> = [
  [/\b(contact|contact-us|contactus|find-us|findus|get-in-touch)\b/i, 30],
  [/\b(branches|offices|office-locations|locations|our-branches|stores|find-a-branch|our-offices)\b/i, 20],
  [/\b(about|about-us|aboutus|who-we-are)\b/i, 10],
];
const CANONICAL_SCORE = 40;
const SITE_ROOT_SCORE = 25;
/** Paths that are files, not pages. */
const ASSET_PATH = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|docx?|xlsx?|mp4|mp3)$/i;
/** Cloudflare's own paths (email obfuscation, challenges): never a business's page. */
const CDN_PATH = /^\/cdn-cgi\//i;

/** Status codes that mean "you're refused": no retry, no workaround. */
export const REFUSING_STATUSES = new Set([401, 403, 429]);
const SERVICE_UNAVAILABLE = 503;
/** Markers of a bot-protection challenge page instead of real content. */
const CHALLENGE_MARKERS: ReadonlyArray<{ name: string; test: (page: ParsedPage) => boolean }> = [
  { name: 'Cloudflare challenge', test: (page) => /^just a moment\.{0,3}$/i.test(page.title) },
  { name: 'Cloudflare challenge', test: (page) => page.scripts.some((script) => /challenge-platform|cf-chl-|\/cdn-cgi\/challenge/i.test(`${script.src ?? ''} ${script.text}`)) },
  { name: 'Imperva challenge', test: (page) => page.scripts.some((script) => /_Incapsula_Resource/i.test(`${script.src ?? ''} ${script.text}`)) },
  { name: 'DataDome challenge', test: (page) => page.scripts.some((script) => /captcha-delivery\.com/i.test(`${script.src ?? ''} ${script.text}`)) },
];

/** Names the bot-protection challenge a page is, or null when it looks like real content. */
export function challengeName(page: ParsedPage): string | null {
  return CHALLENGE_MARKERS.find((marker) => marker.test(page))?.name ?? null;
}

/** True when a 503 is a CDN's bot protection rather than an outage. */
export function isProtected503(status: number, headers: Record<string, string>): boolean {
  return status === SERVICE_UNAVAILABLE && (headers['cf-mitigated'] !== undefined || /cloudflare/i.test(headers.server ?? ''));
}

/** A page with no business markup, almost no visible text, and no tel:/mailto: links: probably built by JavaScript. */
export function isUnreadable(page: ParsedPage, businessBlocks: number, minimumTextChars: number): boolean {
  const hasContactLinks = page.links.some((link) => /^(tel|mailto):/i.test(link.url));
  return businessBlocks === 0 && !hasContactLinks && page.visibleText.length < minimumTextChars;
}

/** Ranks the start page's links on its own host (ignoring www., not other subdomains) by how likely they are to hold contact details; best first. */
export function selectPages(start: ParsedPage, site: string, limit: number): string[] {
  const scores = new Map<string, number>();
  const startPath = pagePath(start.url);
  const add = (url: string, score: number): void => {
    const isEligible = URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)
      && siteHost(new URL(url).hostname) === site && !ASSET_PATH.test(new URL(url).pathname) && !CDN_PATH.test(new URL(url).pathname) && pagePath(url) !== startPath;
    if (isEligible && score > (scores.get(url) ?? 0)) {
      scores.set(url, score);
    }
  };
  const canonical = start.linkTags.find((link) => link.rel.includes('canonical'))?.href;
  if (canonical !== undefined) {
    add(canonical, CANONICAL_SCORE);
  }
  if (!isSiteRoot(start.url)) {
    add(new URL('/', start.url).href, SITE_ROOT_SCORE);
  }
  for (const link of start.links) {
    if (URL.canParse(link.url)) {
      // The last path segment only, so a branches index scores but each branch page under it doesn't.
      const lastSegment = new URL(link.url).pathname.split('/').filter((segment) => segment !== '').at(-1) ?? '';
      const subject = `${lastSegment} ${link.text}`;
      const score = LINK_SCORES.find(([pattern]) => pattern.test(subject))?.[1] ?? 0;
      if (score > 0) {
        const url = new URL(link.url);
        url.search = '';
        add(url.href, score);
      }
    }
  }
  return [...scores.entries()]
    .sort(([firstUrl, firstScore], [secondUrl, secondScore]) => secondScore - firstScore || firstUrl.localeCompare(secondUrl))
    .slice(0, limit)
    .map(([url]) => url);
}
