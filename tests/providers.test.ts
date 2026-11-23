import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FIELD_NAMES } from '../src/lookup/fields.js';
import { DEFAULT_FIELD_PRIORITY, PROVIDER_DECLARATIONS, PROVIDER_NAMES } from '../src/providers/declarations.js';
import { providerStatus } from '../src/providers/status.js';

describe('provider declarations', () => {
  test('each field\'s default priority lists exactly the providers that can supply it', () => {
    for (const field of FIELD_NAMES) {
      const suppliers = PROVIDER_NAMES.filter((name) => PROVIDER_DECLARATIONS[name].supplies.includes(field));
      assert.deepEqual([...DEFAULT_FIELD_PRIORITY[field]].sort(), [...suppliers].sort(), `priority for ${field}`);
    }
  });

  test('only web-fetch is free, and every metered provider needs a COMPFINDER_ credential', () => {
    for (const name of PROVIDER_NAMES) {
      const declaration = PROVIDER_DECLARATIONS[name];
      assert.equal(declaration.metered, name !== 'web-fetch', `${name} metered`);
      if (declaration.metered) {
        assert.match(declaration.credentialVariable ?? '', /^COMPFINDER_[A-Z_]+_API_KEY$/);
      }
    }
  });
});

describe('providerStatus', () => {
  test('a provider is disabled, not-configured or configured, in that order of precedence', () => {
    const google = PROVIDER_DECLARATIONS['google-places-api'];
    assert.equal(providerStatus(google, { enabled: false, apiKey: 'key' }).status, 'disabled');
    assert.deepEqual(providerStatus(google, { enabled: true, apiKey: null }), {
      status: 'not-configured',
      missing: 'set COMPFINDER_GOOGLE_PLACES_API_KEY or providers.google-places-api.api_key',
    });
    assert.equal(providerStatus(google, { enabled: true, apiKey: 'key' }).status, 'configured');
    assert.equal(providerStatus(PROVIDER_DECLARATIONS['web-fetch'], { enabled: true, apiKey: null }).status, 'configured');
  });
});
