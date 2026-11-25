import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { CSV_COLUMNS, csvCell } from '../src/cli/output/csv.js';
import { terminalSafe } from '../src/cli/output/text.js';
import { makeTemporaryHome, runCli, runCliAsync, type CliRun } from './helpers/cli.js';

const FIXTURES = new URL('./fixtures/web-fetch/', import.meta.url);
const PAGES: Record<string, { file?: string; body?: string; type?: string }> = {
  '/robots.txt': { body: 'User-agent: *\nDisallow: /admin\n', type: 'text/plain' },
  '/branches/reading/': { file: 'branch-page/reading.html' },
  '/': { file: 'branch-page/home.html' },
  '/contact/': { file: 'branch-page/contact.html' },
  '/branches/': { file: 'chain/branches.html' },
};
const SCHEMA = JSON.parse(readFileSync(new URL('../schema/result-1.0.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true }).compile(SCHEMA);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

let server: Server;
let baseUrl: string;

/** Runs `compfinder find` against the local fixture site. */
function find(cliArguments: string[]): Promise<CliRun> {
  return runCliAsync(['find', ...cliArguments, '--allow-private-addresses', '--no-download'], { HOME: makeTemporaryHome() });
}

before(async () => {
  server = createServer((request, response) => {
    const page = PAGES[request.url ?? ''];
    if (page === undefined) {
      response.writeHead(404);
      response.end();
    } else {
      response.writeHead(200, { 'content-type': `${page.type ?? 'text/html'}; charset=utf-8` });
      response.end(page.file === undefined ? page.body : readFileSync(new URL(page.file, FIXTURES)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('compfinder find', () => {
  test('prints a finger-style summary by default', async () => {
    const result = await find(['Example Estates', `--url=${baseUrl}/branches/reading/`]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^Example Estates Reading\s+identity 100$/m);
    assert.match(result.stdout, /^ {2}Phone\s+0118 496 0000 {2}\(\+441184960000\)\s+60 {2}web-fetch$/m);
    assert.match(result.stdout, /^ {2}Providers\s+web-fetch ok \(5 calls\)/m);
  });

  test('--explain in text lists each piece of evidence, socials included', async () => {
    const result = await find(['Example Estates', `--url=${baseUrl}/branches/reading/`, '--explain']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /· web-fetch: facebook\.com\//);
  });

  test('a wrong name with a confirmed site keeps the business, capped at 40 with a warning', async () => {
    const result = await find(['Totally Different Agents', `--url=${baseUrl}/`, '--output=json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { identity: { confidence: number; rules: string[] }; fields: { phone: { value: string; confidence: number } }; warnings: string[] };
    assert.equal(output.identity.confidence, 40);
    assert.ok(output.identity.rules.includes('identity.name-mismatch'));
    assert.notEqual(output.fields.phone.value, null, 'the data is still there');
    assert.ok(output.fields.phone.confidence <= 40);
    assert.ok(output.warnings.some((warning) => warning.includes('"Totally Different Agents" doesn\'t match')));
  });

  test('--output=json prints one line that validates against the published schema', async () => {
    const result = await find([`--url=${baseUrl}/branches/reading/`, '--output=json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const output = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    assert.ok(validate(output), JSON.stringify(validate.errors));
    assert.equal(output.ok, true);
  });

  test('--output=csv writes a byte-order mark, the header and one row, with CRLF line endings', async () => {
    const result = await find([`--url=${baseUrl}/branches/reading/`, '--output=csv']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.startsWith(BYTE_ORDER_MARK));
    const rows = result.stdout.slice(BYTE_ORDER_MARK.length).split('\r\n');
    assert.equal(rows.length, 3, 'header, row, and the empty string after the final CRLF');
    assert.equal(rows[0], CSV_COLUMNS.join(','));
    assert.match(rows[1] ?? '', /,'\+441184960000,0118 496 0000,60,/, 'the E.164 number is defused for spreadsheets');
  });

  test('--dry-run plans the lookup without making any call', async () => {
    const result = await find([`--url=${baseUrl}/`, '--dry-run', '--output=json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { providers: Array<{ name: string; status: string }>; max_metered_calls: number };
    assert.deepEqual(output.providers.map((provider) => `${provider.name}: ${provider.status}`), [
      'brave-search-api: not_configured', 'web-fetch: would_run', 'google-places-api: not_configured',
    ]);
    assert.equal(output.max_metered_calls, 0);
  });

  test('nothing to look up is a usage error with input.no_query', () => {
    const result = runCli(['find', '--output=json'], { HOME: makeTemporaryHome() });
    assert.equal(result.exitCode, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'input.no_query');
  });

  test('every bad input is listed at once, with input.bad_value', () => {
    const result = runCli(['find', '--postcode=nowhere', '--url=ftp://x', '--fields=logo,colour', '--output=json'], { HOME: makeTemporaryHome() });
    assert.equal(result.exitCode, 2);
    const output = JSON.parse(result.stdout) as { error: { code: string }; problems: string[] };
    assert.equal(output.error.code, 'input.bad_value');
    assert.equal(output.problems.length, 3);
  });

  test('a name alone, with only web-fetch available, exits 3: no provider could serve the query', () => {
    const result = runCli(['find', 'Example Estates', '--output=json'], { HOME: makeTemporaryHome() });
    assert.equal(result.exitCode, 3);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'lookup.no_provider');
  });

  test('--explain needs text or JSON output', () => {
    const result = runCli(['find', '--url=example.com', '--explain', '--output=csv'], { HOME: makeTemporaryHome() });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--explain needs --output=text or json/);
  });

  test('a second name is an unexpected argument', () => {
    const result = runCli(['find', 'Example', 'Estates'], { HOME: makeTemporaryHome() });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Unexpected argument: "Estates"/);
  });
});

describe('CSV cells', () => {
  test('cells starting with =, +, -, @, tab or CR are defused with a leading quote', () => {
    for (const dangerous of ['=SUM(A1)', '+441184960000', '-1', '@cmd', '\tx', '\rx']) {
      assert.ok(csvCell(dangerous).replace(/^"/, '').startsWith('\''), JSON.stringify(dangerous));
    }
    assert.equal(csvCell('Example Estates'), 'Example Estates');
    assert.equal(csvCell(60), '60');
    assert.equal(csvCell(null), '');
  });

  test('cells with commas, quotes or line breaks are quoted, with quotes doubled', () => {
    assert.equal(csvCell('1 Broad St, Reading'), '"1 Broad St, Reading"');
    assert.equal(csvCell('The "Best" Agents'), '"The ""Best"" Agents"');
    assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  });

  test('the column list is pinned: changing it is a schema version change (docs/output.md)', () => {
    assert.equal(CSV_COLUMNS.length, 35);
    assert.equal(CSV_COLUMNS[0], 'id');
    assert.equal(CSV_COLUMNS[CSV_COLUMNS.length - 1], 'business_status');
  });
});

describe('text output', () => {
  test('strips terminal escape sequences and control characters from page text', () => {
    const escape = String.fromCodePoint(0x1b);
    assert.equal(terminalSafe(`Example${escape}[31m Estates${escape}]0;title${String.fromCodePoint(7)}`), 'Example Estates0;title');
  });
});
