import type { Config } from '../config.js';
import type { Provider } from './contract.js';
import { createBraveSearchProvider } from './brave-search-api/index.js';
import { createGooglePlacesProvider } from './google-places-api/index.js';
import { createWebFetchProvider } from './web-fetch/index.js';

/** Every built-in provider, built from config. Declared providers without one are skipped. */
export function builtInProviders(config: Config): Provider[] {
  return [
    createWebFetchProvider({
      maxPages: config.webFetch.maxPages,
      honourRobots: config.webFetch.honourRobots,
      unreadableTextChars: config.webFetch.unreadableTextChars,
    }),
    createGooglePlacesProvider(),
    createBraveSearchProvider({ directoryHosts: config.discover.directoryHosts }),
  ];
}
