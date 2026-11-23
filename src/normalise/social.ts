import type { SocialNetwork, SocialValue } from '../lookup/types.js';
import { siteHost } from './url.js';

/** Hosts of each network. */
const NETWORK_HOSTS: ReadonlyArray<[SocialNetwork, readonly string[]]> = [
  ['facebook', ['facebook.com', 'fb.com', 'm.facebook.com']],
  ['instagram', ['instagram.com']],
  ['linkedin', ['linkedin.com', 'uk.linkedin.com']],
  ['x', ['x.com', 'twitter.com', 'mobile.twitter.com']],
  ['youtube', ['youtube.com', 'm.youtube.com']],
  ['tiktok', ['tiktok.com']],
];
/** Paths that share or log in rather than name a profile. */
const NOT_A_PROFILE = /^\/(?:sharer|share|intent|dialog|plugins|login|signup|home|search|hashtag|watch|embed|tr|privacy|legal|help|policies|about|explore)(?:[/.?]|$)/i;
/** LinkedIn pages that belong to organisations; anything else there (/in/) is a person. */
const LINKEDIN_ORGANISATION_PATH = /^\/(?:company|school|showcase)\/[^/]+/i;

export type SocialParse = { kind: 'profile'; value: SocialValue } | { kind: 'personal' } | { kind: 'none' };

/** Recognises an organisation's social profile URL; a person's profile is reported, never returned. */
export function parseSocialProfile(raw: string): SocialParse {
  let result: SocialParse = { kind: 'none' };
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    const host = siteHost(url.hostname);
    const network = NETWORK_HOSTS.find(([, hosts]) => hosts.includes(host))?.[0];
    const path = url.pathname.replace(/\/+$/, '');
    if (network !== undefined && path !== '' && !NOT_A_PROFILE.test(path) && ['http:', 'https:'].includes(url.protocol)) {
      if (network === 'linkedin' && !LINKEDIN_ORGANISATION_PATH.test(path)) {
        result = { kind: 'personal' };
      } else {
        result = { kind: 'profile', value: { network, url: `https://${host === 'twitter.com' ? 'x.com' : host}${path}` } };
      }
    }
  }
  return result;
}
