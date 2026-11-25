import type { AddressValue, Evidence, EvidenceQuality, LogoSource, LogoKind } from '../../lookup/types.js';
import { countryRules } from '../../normalise/country/index.js';
import { classifyEmail, normaliseEmail } from '../../normalise/email.js';
import { nameTokens } from '../../normalise/name.js';
import { normalisePhone } from '../../normalise/phone.js';
import { mapsCid } from '../../normalise/maps.js';
import { parseSocialProfile } from '../../normalise/social.js';
import { sanitiseText, type TextKind } from '../../normalise/text.js';
import { compactWords, nameFromDomain, normaliseUrl, siteHost } from '../../normalise/url.js';
import { resolveUrl, type ParsedPage } from './document.js';
import type { BusinessBlock } from './structured.js';

/** Icons at least this wide count as a manifest-quality logo (docs/confidence.md). */
export const MANIFEST_ICON_MIN_PX = 192;
const APPLE_TOUCH_ICON_DEFAULT_PX = 180;
const FAVICON_PATH = '/favicon.ico';
const SIZE_PATTERN = /(\d+)\s*x\s*(\d+)/i;
const LINE_BREAKS = /\s*(?:\r?\n|<br\s*\/?>)\s*/i;
/** The detail on a brand name read from a page title. */
export const TITLE_NAME_DETAIL = 'page title, matching the domain';
/** What sits between a page title's parts: "Cheap Gyms | ExampleGym", "Home - Acme", "Acme · Plumbers". */
const TITLE_SEPARATOR = /\s+[|\-–—:·•]\s+|\s*[|·•]\s*/u;
/** Marks a website taken from the page a LocalBusiness block sits on, rather than its own url property. */
export const PAGE_FALLBACK_DETAIL = 'the page holding the';

/** Counts of things seen but deliberately not returned. */
export interface Withheld {
  personalEmails: number;
  personalProfiles: number;
}

/** What one business block says: location facts, brand facts, and how it was typed. */
export interface BlockEvidence {
  location: Evidence[];
  brand: Evidence[];
  isLocalBusiness: boolean;
  hasAddress: boolean;
  /** Google Maps listing CIDs from hasMap and sameAs links. */
  mapsCids: string[];
}

/** The first string (or number) in a value that may be a list, sanitised; null when there's none. */
function firstText(value: unknown, kind: TextKind): string | null {
  const first = Array.isArray(value) ? value.find((entry) => typeof entry === 'string' || typeof entry === 'number') : value;
  const text = typeof first === 'string' || typeof first === 'number' ? sanitiseText(String(first), kind) : '';
  return text === '' ? null : text;
}

/** Every string in a value that may be a list. */
function allTexts(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string');
}

/** A number from a number or a numeric string such as "512px"; null otherwise. */
function numberFrom(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(number) ? number : null;
}

/** A region that is only a country code and a hyphen. */
const EMPTY_SUBDIVISION = /^[A-Za-z]{2}-$/;
/** The UK nations' ISO 3166-2 codes, written with or without the GB- prefix, as names. */
const UK_NATION_CODES: Readonly<Record<string, string>> = { ENG: 'England', SCT: 'Scotland', WLS: 'Wales', NIR: 'Northern Ireland' };
const UK_NATION_CODE = /^(?:GB-)?(ENG|SCT|WLS|NIR)$/i;

/** A schema.org region as written for an address: an empty subdivision is none, and a UK nation's code is its name. */
function regionName(region: string | null): string | null {
  const nation = region === null ? null : UK_NATION_CODE.exec(region)?.[1]?.toUpperCase() ?? null;
  let name = region;
  if (region !== null && EMPTY_SUBDIVISION.test(region)) {
    name = null;
  } else if (nation !== null) {
    name = UK_NATION_CODES[nation] ?? region;
  }
  return name;
}

/** A line with a postcode (in any case or spacing) taken out, and the commas around it tidied. */
function withoutPostcode(line: string, postcode: string): string {
  const pattern = new RegExp(postcode.replace(/\s+/g, '').split('').join('\\s*'), 'gi');
  return line.replace(pattern, '').replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
}

/** A PostalAddress object or address string, as an AddressValue; null when it has nothing usable. */
export function addressFrom(value: unknown, geo: unknown, countryCode: string): AddressValue | null {
  const rules = countryRules(countryCode);
  const node = Array.isArray(value) ? value[0] : value;
  let address: AddressValue | null = null;
  if (typeof node === 'string' || (typeof node === 'object' && node !== null)) {
    const fields = typeof node === 'string' ? { streetAddress: node } : node as Record<string, unknown>;
    const street = firstText(fields.streetAddress, 'identifier') ?? '';
    const lines = street.split(LINE_BREAKS).map((line) => sanitiseText(line, 'addressLine')).filter((line) => line !== '');
    const rawPostcode = firstText(fields.postalCode, 'addressLine');
    const postcode = (rawPostcode === null ? null : rules.normalisePostcode(rawPostcode)) ?? rules.findPostcodes(street)[0] ?? null;
    const countryField = fields.addressCountry;
    const countryName = typeof countryField === 'object' && countryField !== null ? (countryField as Record<string, unknown>).name : countryField;
    const country = firstText(countryName, 'town');
    const geoFields = typeof geo === 'object' && geo !== null ? geo as Record<string, unknown> : {};
    // A street line that already ends in the postcode would repeat it when the address is written out.
    const streetLines = postcode === null ? lines : lines.map((line) => withoutPostcode(line, postcode)).filter((line) => line !== '');
    const town = firstText(fields.addressLocality, 'town');
    const county = regionName(firstText(fields.addressRegion, 'town'));
    address = {
      lines: streetLines,
      town,
      county,
      postcode,
      country_code: country !== null && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : countryCode,
      formatted: null,
      lat: numberFrom(geoFields.latitude),
      lon: numberFrom(geoFields.longitude),
    };
    if (streetLines.length === 0 && town === null && postcode === null) {
      address = null;
    }
  }
  return address;
}

/** A logo from a URL string or an ImageObject. */
function logoFrom(value: unknown, pageUrl: string, source: LogoSource, kind: LogoKind): Evidence | null {
  const node = Array.isArray(value) ? value[0] : value;
  const fields: Record<string, unknown> = typeof node === 'object' && node !== null ? node as Record<string, unknown> : { url: node };
  const raw = firstText(fields.url ?? fields.contentUrl, 'url');
  const url = raw === null ? null : resolveUrl(raw, pageUrl);
  return url === null || normaliseUrl(url) === null ? null : {
    field: 'logo',
    value: { source_url: url, kind, source, width: numberFrom(fields.width), height: numberFrom(fields.height), path: null, mime: null, converted_from: null },
    quality: 'structured',
    reference: { url: pageUrl, detail: `${source === 'schema-org' ? 'schema.org logo' : source} on the page` },
  };
}

/** Adds an email to evidence when it's a role address; counts it as withheld otherwise. */
export function addEmail(raw: string, businessWords: readonly string[], quality: EvidenceQuality, detail: string, pageUrl: string, into: Evidence[], withheld: Withheld): void {
  const address = normaliseEmail(raw);
  if (address !== null && classifyEmail(address, businessWords) === 'role') {
    into.push({ field: 'email', value: { address, kind: 'role' }, quality, reference: { url: pageUrl, detail } });
  } else if (address !== null) {
    withheld.personalEmails += 1;
  }
}

/** Adds a social profile to evidence; a person's profile is counted as withheld. */
export function addSocial(raw: string, quality: EvidenceQuality, detail: string, pageUrl: string, into: Evidence[], withheld: Withheld): void {
  const parsed = parseSocialProfile(raw);
  if (parsed.kind === 'profile') {
    into.push({ field: 'socials', value: parsed.value, quality, reference: { url: pageUrl, detail } });
  } else if (parsed.kind === 'personal') {
    withheld.personalProfiles += 1;
  }
}

/** Reads one schema.org business block into location and brand evidence. */
export function blockEvidence(block: BusinessBlock, page: ParsedPage, countryCode: string, withheld: Withheld): BlockEvidence {
  const properties = block.properties;
  const detail = `${block.types[0] ?? 'Organization'} ${block.syntax === 'json-ld' ? 'JSON-LD' : 'microdata'}`;
  const reference = { url: page.url, detail };
  const location: Evidence[] = [];
  const brand: Evidence[] = [];
  const name = firstText(properties.name ?? properties.legalName, 'name');
  const address = addressFrom(properties.address, properties.geo, countryCode);
  const businessWords = [name ?? '', address?.town ?? ''].filter((word) => nameTokens(word).length > 0);

  if (name !== null) {
    (block.isLocalBusiness || address !== null ? location : brand).push({ field: 'name', value: name, quality: 'structured', reference });
  }
  if (address !== null) {
    location.push({ field: 'address', value: address, quality: 'structured', reference });
  }
  for (const telephone of allTexts(properties.telephone)) {
    const phone = normalisePhone(sanitiseText(telephone, 'phone'), countryCode);
    if (phone !== null) {
      (block.isLocalBusiness || address !== null ? location : brand).push({ field: 'phone', value: phone, quality: 'structured', reference });
    }
  }
  for (const email of allTexts(properties.email)) {
    addEmail(email, businessWords, 'structured', detail, page.url, block.isLocalBusiness || address !== null ? location : brand, withheld);
  }
  const blockUrl = firstText(properties.url, 'url');
  const website = blockUrl === null ? null : normaliseUrl(resolveUrl(blockUrl, page.baseUrl) ?? blockUrl);
  if (website !== null) {
    (block.isLocalBusiness ? location : brand).push({ field: 'website', value: website, quality: 'structured', reference });
  } else if (block.isLocalBusiness) {
    const pageWebsite = normaliseUrl(page.url);
    if (pageWebsite !== null) {
      location.push({ field: 'website', value: pageWebsite, quality: 'structured', reference: { url: page.url, detail: `${PAGE_FALLBACK_DETAIL} ${detail}` } });
    }
  }
  const logo = logoFrom(properties.logo, page.url, 'schema-org', 'logo');
  if (logo !== null) {
    brand.push(logo);
  }
  for (const sameAs of allTexts(properties.sameAs)) {
    addSocial(sameAs, 'structured', `${detail} sameAs`, page.url, brand, withheld);
  }
  const mapsCids = [...new Set([...allTexts(properties.hasMap), ...allTexts(properties.sameAs)].map(mapsCid).filter((cid) => cid !== null))];
  return { location, brand, isLocalBusiness: block.isLocalBusiness, hasAddress: address !== null, mapsCids };
}

/** The pixel width declared in a sizes attribute such as "192x192", the largest when there are several. */
function declaredWidth(sizes: string | null): number | null {
  const widths = (sizes ?? '').split(/\s+/).map((size) => SIZE_PATTERN.exec(size)?.[1]).filter((width) => width !== undefined).map(Number);
  return widths.length === 0 ? null : Math.max(...widths);
}

/** The part of a page title that spells the site's domain ("Cheap Gyms | ExampleGym" on examplegym.com -> "ExampleGym"); else null. */
function titleBrandName(page: ParsedPage): string | null {
  const domainName = compactWords(nameFromDomain(siteHost(new URL(page.url).hostname)));
  const segments = page.title.split(TITLE_SEPARATOR).map((segment) => sanitiseText(segment, 'name'));
  return domainName === '' ? null : segments.find((segment) => compactWords(segment) === domainName) ?? null;
}

/** Brand evidence from a page's head: site name, social images, icons; plus the manifest URL if any. */
export function metaEvidence(page: ParsedPage): { brand: Evidence[]; manifestUrl: string | null } {
  const brand: Evidence[] = [];
  const reference = (detail: string) => ({ url: page.url, detail });
  const siteName = page.meta.get('og:site_name');
  if (siteName !== undefined && sanitiseText(siteName, 'name') !== '') {
    brand.push({ field: 'name', value: sanitiseText(siteName, 'name'), quality: 'loose', reference: reference('og:site_name') });
  }
  const titleName = titleBrandName(page);
  if (titleName !== null && !brand.some((entry) => entry.field === 'name')) {
    brand.push({ field: 'name', value: titleName, quality: 'loose', reference: reference(TITLE_NAME_DETAIL) });
  }
  for (const key of ['og:image', 'og:image:url', 'twitter:image']) {
    const image = page.meta.get(key);
    const url = image === undefined ? null : resolveUrl(image, page.baseUrl);
    if (url !== null && normaliseUrl(url) !== null && !brand.some((entry) => entry.field === 'logo' && entry.value.source_url === url)) {
      const width = key.startsWith('og:') ? numberFrom(page.meta.get('og:image:width')) : null;
      brand.push({
        field: 'logo',
        value: { source_url: url, kind: 'social-image', source: 'social-image', width, height: null, path: null, mime: null, converted_from: null },
        quality: 'structured',
        reference: reference(key),
      });
    }
  }
  let hasIcon = false;
  for (const link of page.linkTags) {
    const isAppleTouch = link.rel.includes('apple-touch-icon') || link.rel.includes('apple-touch-icon-precomposed');
    if (isAppleTouch || link.rel.includes('icon')) {
      hasIcon = true;
      const width = declaredWidth(link.sizes) ?? (isAppleTouch ? APPLE_TOUCH_ICON_DEFAULT_PX : null);
      const source: LogoSource = isAppleTouch || (width ?? 0) >= MANIFEST_ICON_MIN_PX ? 'manifest-icon' : 'favicon';
      brand.push({
        field: 'logo',
        value: { source_url: link.href, kind: 'icon', source, width, height: width, path: null, mime: link.type, converted_from: null },
        quality: 'structured',
        reference: reference(isAppleTouch ? 'apple-touch-icon' : 'link rel=icon'),
      });
    }
  }
  if (!hasIcon) {
    const favicon = resolveUrl(FAVICON_PATH, page.url);
    if (favicon !== null) {
      brand.push({
        field: 'logo',
        value: { source_url: favicon, kind: 'icon', source: 'favicon', width: null, height: null, path: null, mime: null, converted_from: null },
        quality: 'loose',
        reference: reference('/favicon.ico (not declared)'),
      });
    }
  }
  const manifest = page.linkTags.find((link) => link.rel.includes('manifest'));
  return { brand, manifestUrl: manifest?.href ?? null };
}

/** Logo evidence from a web app manifest's icons. */
export function manifestEvidence(manifestText: string, manifestUrl: string): Evidence[] {
  const evidence: Evidence[] = [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    manifest = null; // An unreadable manifest just adds no icons.
  }
  const icons = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>).icons : null;
  for (const icon of Array.isArray(icons) ? icons : []) {
    const fields = typeof icon === 'object' && icon !== null ? icon as Record<string, unknown> : {};
    const url = typeof fields.src === 'string' ? resolveUrl(fields.src, manifestUrl) : null;
    const width = declaredWidth(typeof fields.sizes === 'string' ? fields.sizes : null);
    if (url !== null && normaliseUrl(url) !== null) {
      evidence.push({
        field: 'logo',
        value: {
          source_url: url, kind: 'icon', source: (width ?? 0) >= MANIFEST_ICON_MIN_PX ? 'manifest-icon' : 'favicon',
          width, height: width, path: null, mime: typeof fields.type === 'string' ? fields.type : null, converted_from: null,
        },
        quality: 'structured',
        reference: { url: manifestUrl, detail: 'web app manifest icon' },
      });
    }
  }
  return evidence;
}

/** Loose facts from a page's links and text: tel: and mailto: links, social links, and a lone postcode. */
export function looseEvidence(page: ParsedPage, countryCode: string, businessWords: readonly string[], withheld: Withheld): { location: Evidence[]; brand: Evidence[] } {
  const location: Evidence[] = [];
  const brand: Evidence[] = [];
  for (const link of page.links) {
    if (/^tel:/i.test(link.url)) {
      const phone = normalisePhone(link.url, countryCode);
      if (phone !== null && !location.some((entry) => entry.field === 'phone' && entry.value.e164 === phone.e164)) {
        location.push({ field: 'phone', value: phone, quality: 'loose', reference: { url: page.url, detail: 'tel: link' } });
      }
    } else if (/^mailto:/i.test(link.url)) {
      addEmail(link.url, businessWords, 'loose', 'mailto: link', page.url, location, withheld);
    } else {
      addSocial(link.url, 'loose', 'link on the page', page.url, brand, withheld);
    }
  }
  const postcodes = countryRules(countryCode).findPostcodes(page.visibleText);
  if (postcodes.length === 1 && postcodes[0] !== undefined) {
    location.push({
      field: 'address',
      value: { lines: [], town: null, county: null, postcode: postcodes[0], country_code: countryCode, formatted: null, lat: null, lon: null },
      quality: 'loose',
      reference: { url: page.url, detail: 'postcode in the page text' },
    });
  }
  return { location, brand };
}
