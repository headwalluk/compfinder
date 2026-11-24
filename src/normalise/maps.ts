import { siteHost } from './url.js';

/** Hosts whose ?cid= links name a Google Maps listing; country domains (google.co.uk) included by pattern. */
const MAPS_HOSTS = new Set(['maps.google.com', 'google.com']);
const GOOGLE_COUNTRY_HOST = /^google\.(?:com?\.)?[a-z]{2}$/;
/** Digits only; the range check below bounds the value, so leading zeros are allowed. */
const CID_PATTERN = /^\d{1,32}$/;
/** A CID is an unsigned 64-bit number. */
const MAX_CID = 2n ** 64n - 1n;

/** True for a host that serves Google Maps links. */
function isMapsHost(host: string): boolean {
  return MAPS_HOSTS.has(host) || GOOGLE_COUNTRY_HOST.test(host) || host.startsWith('maps.google.');
}

/** The listing's CID from a Google Maps link such as https://maps.google.com/?cid=123; null for anything else. */
export function mapsCid(raw: string): string | null {
  let cid: string | null = null;
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    const value = url.searchParams.get('cid')?.trim() ?? '';
    const isMapsPath = url.hostname.startsWith('maps.') || url.pathname === '/' || url.pathname.startsWith('/maps');
    if (['http:', 'https:'].includes(url.protocol) && isMapsHost(siteHost(url.hostname)) && isMapsPath
      && CID_PATTERN.test(value) && BigInt(value) > 0n && BigInt(value) <= MAX_CID) {
      cid = BigInt(value).toString();
    }
  }
  return cid;
}
