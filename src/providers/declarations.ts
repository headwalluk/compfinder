import type { FieldName } from '../lookup/fields.js';

/** Built-in providers, in the order they are listed. */
export const PROVIDER_NAMES = ['web-fetch', 'google-places-api', 'brave-search-api'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const PROVIDER_STAGES = ['discover', 'site', 'place'] as const;

export type ProviderStage = (typeof PROVIDER_STAGES)[number];

/** What a provider is and needs, known without running it. */
export interface ProviderDeclaration {
  name: ProviderName;
  summary: string;
  stage: ProviderStage;
  metered: boolean;
  /** Environment variable holding the provider's API key; null when it needs none. */
  credentialVariable: string | null;
  /** Query inputs or earlier evidence the provider can work from. */
  inputs: readonly string[];
  supplies: readonly FieldName[];
}

export const PROVIDER_DECLARATIONS: Readonly<Record<ProviderName, ProviderDeclaration>> = {
  'web-fetch': {
    name: 'web-fetch',
    summary: 'Reads the business\'s own pages: schema.org markup, links, icons and text.',
    stage: 'site',
    metered: false,
    credentialVariable: null,
    inputs: ['url'],
    supplies: ['name', 'website', 'address', 'phone', 'email', 'logo', 'socials'],
  },
  'google-places-api': {
    name: 'google-places-api',
    summary: 'Google Places API (New): place candidates, details and normalised addresses.',
    stage: 'place',
    metered: true,
    credentialVariable: 'COMPFINDER_GOOGLE_PLACES_API_KEY',
    inputs: ['place_id', 'name', 'postcode', 'address', 'phone'],
    supplies: ['name', 'website', 'address', 'phone', 'place_id'],
  },
  'brave-search-api': {
    name: 'brave-search-api',
    summary: 'Brave Search API web results: the likely website and branch pages.',
    stage: 'discover',
    metered: true,
    credentialVariable: 'COMPFINDER_BRAVE_SEARCH_API_KEY',
    inputs: ['name', 'postcode', 'address'],
    supplies: ['website'],
  },
};

/** Default order in which providers win a field when nothing else settles it; first wins. */
export const DEFAULT_FIELD_PRIORITY: Readonly<Record<FieldName, readonly ProviderName[]>> = {
  name: ['web-fetch', 'google-places-api'],
  website: ['web-fetch', 'google-places-api', 'brave-search-api'],
  address: ['google-places-api', 'web-fetch'],
  phone: ['web-fetch', 'google-places-api'],
  email: ['web-fetch'],
  logo: ['web-fetch'],
  place_id: ['google-places-api'],
  socials: ['web-fetch'],
};

/** Narrows a string to a ProviderName. */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}
