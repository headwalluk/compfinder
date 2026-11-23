import type { Config } from '../config.js';
import type { Provider } from './contract.js';
import { createGooglePlacesProvider } from './google-places-api/index.js';
import { createWebFetchProvider } from './web-fetch/index.js';

/** Every provider implemented so far, built from config. Declared providers without one are skipped. */
export function builtInProviders(config: Config): Provider[] {
  return [
    createWebFetchProvider({
      maxPages: config.webFetch.maxPages,
      honourRobots: config.webFetch.honourRobots,
      unreadableTextChars: config.webFetch.unreadableTextChars,
    }),
    createGooglePlacesProvider(),
  ];
}
