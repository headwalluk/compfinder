import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { makeTemporaryHome, runCli } from './helpers/cli.js';

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const TEST_API_KEY = 'test-key-not-real';
const OWNER_ONLY_MODE = 0o600;
const PERMISSION_BITS = 0o777;

/** Runs the CLI with an empty temporary home and any extra variables. */
function run(cliArguments: string[], variables: Record<string, string> = {}): ReturnType<typeof runCli> & { home: string } {
  const home = variables.HOME ?? makeTemporaryHome();
  return { ...runCli(cliArguments, { HOME: home, ...variables }), home };
}

/** Parses the single JSON line printed under --output=json. */
function jsonOutput(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'JSON output is one line');
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('compfinder CLI', () => {
  test('--help lists every command and exits 0', () => {
    const result = run(['--help']);
    assert.equal(result.exitCode, 0);
    for (const command of ['providers list', 'config init', 'config path', 'config show', 'version']) {
      assert.match(result.stdout, new RegExp(`compfinder ${command}`));
    }
  });

  test('version prints the package version', () => {
    const result = run(['version']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), PACKAGE_VERSION);
  });

  test('a bare business name is an unknown command: usage error, exit 2', () => {
    const result = run(['Example Estates']);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unknown command: "Example Estates"\. Every invocation starts with a command\./);
  });

  test('--json is not an option, and says to use --output=json', () => {
    const result = run(['providers', 'list', '--json']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Unknown option --json for providers list\. Use --output=json\./);
  });

  test('--output=csv on a command other than find is a usage error', () => {
    const result = run(['providers', 'list', '--output=csv']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--output=csv isn't available for providers list; use text or json\./);
  });

  test('an unknown --output value is a usage error', () => {
    const result = run(['providers', 'list', '--output=yaml']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--output must be one of text, json, csv; got "yaml"\./);
  });

  test('invalid configuration exits 3 and lists every problem', () => {
    const home = makeTemporaryHome();
    const configPath = path.join(home, 'bad.toml');
    writeFileSync(configPath, 'country = "GBR"\n[web_fetch]\nmax_pages = 50\n');
    const result = run(['providers', 'list', '--output=json', `--config=${configPath}`], {
      HOME: home,
      COMPFINDER_LOG_LEVEL: 'verbose',
    });
    assert.equal(result.exitCode, 3);
    const output = jsonOutput(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 3);
    assert.equal((output.problems as string[]).length, 3);
  });

  test('providers list --output=json describes every provider, and never prints an API key', () => {
    const result = run(['providers', 'list', '--output=json'], { COMPFINDER_GOOGLE_PLACES_API_KEY: TEST_API_KEY });
    assert.equal(result.exitCode, 0);
    const output = jsonOutput(result.stdout);
    assert.equal(output.ok, true);
    const providers = output.providers as Array<{ name: string; status: string; metered: boolean }>;
    assert.deepEqual(providers.map((provider) => provider.name), ['web-fetch', 'google-places-api', 'searchapi-io', 'brave-search-api', 'apollo-io']);
    assert.equal(providers.find((provider) => provider.name === 'google-places-api')?.status, 'configured');
    assert.equal(providers.find((provider) => provider.name === 'apollo-io')?.status, 'not-configured');
    assert.equal(providers.find((provider) => provider.name === 'web-fetch')?.metered, false);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_API_KEY));
  });

  test('config init writes an owner-only file once, then refuses with exit 4', () => {
    const first = run(['config', 'init']);
    assert.equal(first.exitCode, 0);
    const configPath = path.join(first.home, '.config', 'compfinder', 'config.toml');
    assert.equal(statSync(configPath).mode & PERMISSION_BITS, OWNER_ONLY_MODE);
    assert.equal(readFileSync(configPath, 'utf8'), readFileSync(new URL('../config.sample.toml', import.meta.url), 'utf8'));
    const second = run(['config', 'init'], { HOME: first.home });
    assert.equal(second.exitCode, 4);
    assert.match(second.stderr, /already exists/);
  });

  test('config show reports each setting\'s source, and API keys only as set or unset', () => {
    const result = run(['config', 'show', '--output=json', '--country=fr'], { COMPFINDER_APOLLO_API_KEY: TEST_API_KEY });
    assert.equal(result.exitCode, 0);
    const settings = jsonOutput(result.stdout).settings as Array<{ key: string; value: unknown; source: string }>;
    assert.deepEqual(settings.find((setting) => setting.key === 'country'), { key: 'country', value: 'FR', source: 'flag', env: 'COMPFINDER_COUNTRY' });
    assert.equal(settings.find((setting) => setting.key === 'providers.apollo-io.api_key')?.value, 'set');
    assert.equal(settings.find((setting) => setting.key === 'providers.searchapi-io.api_key')?.value, 'unset');
    assert.doesNotMatch(result.stdout, new RegExp(TEST_API_KEY));
  });
});
