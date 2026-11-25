import type { EmailValue } from '../normalise/email.js';
import type { PhoneValue } from '../normalise/phone.js';
import type { WebsiteValue } from '../normalise/url.js';
import type { ProviderName } from '../providers/declarations.js';
import type { FieldName } from './fields.js';

export type { EmailValue } from '../normalise/email.js';
export type { PhoneValue } from '../normalise/phone.js';
export type { WebsiteValue } from '../normalise/url.js';

export interface AddressValue {
  lines: string[];
  town: string | null;
  county: string | null;
  postcode: string | null;
  country_code: string | null;
  formatted: string | null;
  lat: number | null;
  lon: number | null;
}

/** Where a logo candidate was found; decides its confidence ceiling. */
export const LOGO_SOURCES = ['schema-org', 'manifest-icon', 'social-image', 'favicon'] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

export const LOGO_KINDS = ['logo', 'social-image', 'icon'] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

export interface LogoValue {
  source_url: string;
  kind: LogoKind;
  source: LogoSource;
  /** Declared or measured pixel size, when known. */
  width: number | null;
  height: number | null;
  /** Set once downloaded into the logo cache. */
  path: string | null;
  mime: string | null;
  converted_from: string | null;
}

export const SOCIAL_NETWORKS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export interface SocialValue {
  network: SocialNetwork;
  url: string;
}

/** The value type of each field. */
export interface FieldValues {
  name: string;
  website: WebsiteValue;
  address: AddressValue;
  phone: PhoneValue;
  email: EmailValue;
  logo: LogoValue;
  place_id: string;
  socials: SocialValue;
}

export type EvidenceQuality = 'structured' | 'loose';

export interface EvidenceReference {
  url?: string;
  recordId?: string;
  /** What the value was read from, such as "LocalBusiness JSON-LD". */
  detail: string;
}

/** One fact from one source. Socials carry one profile per piece of evidence. */
export type Evidence = {
  [Field in FieldName]: {
    field: Field;
    value: FieldValues[Field];
    quality: EvidenceQuality;
    reference: EvidenceReference;
  };
}[FieldName];

export type EvidenceFor<Field extends FieldName> = Extract<Evidence, { field: Field }>;

export type RecordScope = 'brand' | 'location';
export type RecordRole = 'branch' | 'head-office' | 'unknown';
export type SourceName = ProviderName | 'query';

export const QUERY_SOURCE = 'query';
export const QUERY_ORIGIN = 'query';

/** One entity as one source saw it: a LocalBusiness block, a Google place, the caller's query. */
export interface SourceRecord {
  source: SourceName;
  /** Independence key: values from the same origin count once. */
  origin: string;
  /** Stable reference within the source: page URL and block index, place ID, API record id. */
  subject: string;
  scope: RecordScope;
  role: RecordRole;
  evidence: Evidence[];
  /** Google Maps listing CIDs the record names (a ?cid= link). They link records only; never output. */
  mapsCids?: string[];
  /** For a site read after the query's site redirected to it: the domain it redirected from. */
  redirectedFrom?: string;
  /** For a listing page asked about (one with no place of its own): the paths of the site's pages it links to. */
  listedPages?: string[];
}

/** The caller's inputs, normalised. Any may be null. */
export interface Query {
  name: string | null;
  website: WebsiteValue | null;
  /** Free-text address as given, sanitised. */
  address: string | null;
  postcode: string | null;
  phone: PhoneValue | null;
  placeId: string | null;
  country: string;
  /** How the input was read, when it needed reading (country UK read as GB): passed on as warnings. */
  notes?: string[];
}
