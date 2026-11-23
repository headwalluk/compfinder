import type { ProviderSettings } from '../config.js';
import type { ProviderDeclaration } from './declarations.js';

export const PROVIDER_STATUSES = ['configured', 'not-configured', 'disabled'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export interface ProviderStatusReport {
  status: ProviderStatus;
  /** What to set to configure the provider; null unless not-configured. */
  missing: string | null;
}

/** Works out a provider's status from its declaration and settings, without any network call. */
export function providerStatus(declaration: ProviderDeclaration, settings: ProviderSettings): ProviderStatusReport {
  let report: ProviderStatusReport;
  if (!settings.enabled) {
    report = { status: 'disabled', missing: null };
  } else if (declaration.credentialVariable !== null && settings.apiKey === null) {
    report = {
      status: 'not-configured',
      missing: `set ${declaration.credentialVariable} or providers.${declaration.name}.api_key`,
    };
  } else {
    report = { status: 'configured', missing: null };
  }
  return report;
}
