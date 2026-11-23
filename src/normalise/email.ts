import { nameTokens } from './name.js';
import { decodeEscapes } from './text.js';

/** Local parts that address a role, not a person. */
const ROLE_WORDS = new Set([
  'info', 'information', 'hello', 'hi', 'contact', 'contactus', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
  'office', 'admin', 'administration', 'reception', 'sales', 'lettings', 'letting', 'rentals', 'lets',
  'accounts', 'accounting', 'finance', 'billing', 'invoices', 'support', 'help', 'helpdesk', 'service',
  'customerservice', 'customerservices', 'bookings', 'booking', 'reservations', 'orders', 'shop', 'team',
  'mail', 'post', 'general', 'marketing', 'press', 'media', 'careers', 'jobs', 'recruitment', 'hr',
  'propertymanagement', 'management', 'valuations', 'surveys', 'mortgages', 'newhomes', 'auctions',
]);
const LOCAL_PART_SEPARATORS = /[._+-]+/;
/** A conservative address shape: no quoting, no comments, a dotted domain. */
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAILTO_SCHEME = /^mailto:/i;

export type EmailKind = 'role' | 'possibly-personal';

export interface EmailValue {
  address: string;
  kind: 'role';
}

/** Lower-cases and checks an address, dropping any mailto: and query; null when it isn't one. */
export function normaliseEmail(raw: string): string | null {
  const address = decodeEscapes(raw.replace(MAILTO_SCHEME, '').split('?')[0] ?? '').trim().toLowerCase();
  return EMAIL_PATTERN.test(address) ? address : null;
}

/** A role address uses a role word or a word from the business's name or town; anything else may be personal. */
export function classifyEmail(address: string, businessWords: readonly string[]): EmailKind {
  const localPart = address.split('@')[0] ?? '';
  const allowed = new Set([...ROLE_WORDS, ...businessWords.flatMap((word) => nameTokens(word))]);
  const parts = localPart.split(LOCAL_PART_SEPARATORS).filter((part) => part !== '');
  const isRole = parts.length > 0 && (allowed.has(localPart.replace(/[._+-]/g, '')) || parts.every((part) => allowed.has(part)));
  return isRole ? 'role' : 'possibly-personal';
}
