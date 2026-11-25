import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CSV_COLUMNS } from '../src/cli/output/csv.js';
import { makeTemporaryHome, runCliAsync } from './helpers/cli.js';

const FIXTURES = new URL('./fixtures/web-fetch/', import.meta.url);
const SLOW_RESPONSE_MS = 400;
const PAGES: Record<string, { file?: string; body?: string; type?: string; delayMs?: number }> = {
  '/robots.txt': { body: 'User-agent: *\nAllow: /\n', type: 'text/plain' },
  '/branches/reading/': { file: 'branch-page/reading.html', delayMs: SLOW_RESPONSE_MS },
  '/': { file: 'chain/home.html' },
  '/contact/': { file: 'branch-page/contact.html' },
  '/branches/': { file: 'chain/branches.html' },
};
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

let server: Server;
let baseUrl: string;

/** Writes a JSONL file in a temporary home, and returns its path and the home. */
function inputFile(lines: string[]): { inputPath: string; home: string } {
  const home = makeTemporaryHome();
  const inputPath = path.join(home, 'input.jsonl');
  writeFileSync(inputPath, `${lines.join('\n')}\n`);
  return { inputPath, home };
}

/** Three lines: a slow branch page, a malformed line, and the fast home page, plus a blank line. */
function mixedLines(): string[] {
  return [
    JSON.stringify({ id: 'reading', url: `${baseUrl}/branches/reading/` }),
    '{ not json',
    '',
    JSON.stringify({ id: 7, url: `${baseUrl}/` }),
    JSON.stringify({ id: 'empty' }),
  ];
}

before(async () => {
  server = createServer((request, response) => {
    const page = PAGES[request.url ?? ''];
    const respond = (): void => {
      if (page === undefined) {
        response.writeHead(404);
        response.end();
      } else {
        response.writeHead(200, { 'content-type': `${page.type ?? 'text/html'}; charset=utf-8` });
        response.end(page.file === undefined ? page.body : readFileSync(new URL(page.file, FIXTURES)));
      }
    };
    if (page?.delayMs === undefined) {
      respond();
    } else {
      void delay(page.delayMs).then(respond);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('find --input (batch)', () => {
  test('writes one JSON line per input line, in input order even when run concurrently, each with its id', async () => {
    const { inputPath, home } = inputFile(mixedLines());
    const result = await runCliAsync(['find', `--input=${inputPath}`, '--output=json', '--concurrency=3', '--allow-private-addresses', '--no-download'], { HOME: home });
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: string | null; ok: boolean; error: { code: string } | null });
    assert.deepEqual(lines.map((line) => [line.id, line.ok, line.error?.code ?? null]), [
      ['reading', true, null],
      [null, false, 'input.bad_json'],
      ['7', true, null],
      ['empty', false, 'input.no_query'],
    ]);
    assert.match(result.stderr, /Batch: 4 lines, 2 with errors, 0 metered calls\./);
  });

  test('CSV output has one byte-order mark and one header, then a row per line', async () => {
    const { inputPath, home } = inputFile(mixedLines());
    const result = await runCliAsync(['find', `--input=${inputPath}`, '--output=csv', '--allow-private-addresses', '--no-download'], { HOME: home });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.startsWith(BYTE_ORDER_MARK));
    assert.equal(result.stdout.split(BYTE_ORDER_MARK).length, 2, 'exactly one byte-order mark');
    const rows = result.stdout.slice(BYTE_ORDER_MARK.length).split('\r\n').filter((row) => row !== '');
    assert.equal(rows[0], CSV_COLUMNS.join(','));
    assert.equal(rows.length, 5);
    assert.match(rows[2] ?? '', /,input\.bad_json,$/);
    assert.match(rows[3] ?? '', /^7,/);
  });

  test('text output is one block per line, headed by its id', async () => {
    const { inputPath, home } = inputFile(mixedLines());
    const result = await runCliAsync(['find', `--input=${inputPath}`, '--allow-private-addresses', '--no-download'], { HOME: home });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^\[reading\]\nExample Estates Reading/m);
    assert.match(result.stdout, /^\[line 2\]\n {2}The input line is not valid JSON\./m);
    assert.match(result.stdout, /^\[7\]\n/m);
  });

  test('reads JSONL from stdin with --input=-', async () => {
    const home = makeTemporaryHome();
    const result = await runCliAsync(['find', '--input=-', '--output=json', '--allow-private-addresses', '--no-download'], { HOME: home },
      `${JSON.stringify({ id: 'stdin', url: `${baseUrl}/` })}\n`);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout.trim()) as { id: string }).id, 'stdin');
  });

  test('--dry-run plans every line without making any call, for costing a big job', async () => {
    const { inputPath, home } = inputFile([JSON.stringify({ id: 'a', url: 'https://example.com/' }), JSON.stringify({ id: 'b', name: 'Example', postcode: 'RG1 1AA' })]);
    const result = await runCliAsync(['find', `--input=${inputPath}`, '--dry-run', '--output=json'], { HOME: home, COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key' });
    assert.equal(result.exitCode, 0, result.stderr);
    const plans = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: string; max_metered_calls: number });
    assert.deepEqual(plans.map((plan) => [plan.id, plan.max_metered_calls]), [['a', 1], ['b', 1]]);
    assert.match(result.stderr, /Batch: 2 lines, 0 with errors, at most 2 metered calls\./);
  });

  test('a dry run\'s total is capped by the batch\'s metered-call budget; CSV is refused', async () => {
    const { inputPath, home } = inputFile([JSON.stringify({ id: 'a', url: 'https://example.com/' }), JSON.stringify({ id: 'b', name: 'Example', postcode: 'RG1 1AA' })]);
    const environment = { HOME: home, COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key' };
    const capped = await runCliAsync(['find', `--input=${inputPath}`, '--dry-run', '--output=json', '--max-metered-calls-total=1'], environment);
    assert.equal(capped.exitCode, 0, capped.stderr);
    assert.match(capped.stderr, /Batch: 2 lines, 0 with errors, at most 1 metered calls\./);
    const csv = await runCliAsync(['find', `--input=${inputPath}`, '--dry-run', '--output=csv'], environment);
    assert.equal(csv.exitCode, 2);
    assert.match(csv.stderr, /--dry-run needs --output=text or json/);
  });

  test('unknown keys and non-string values in a line are input.bad_value', async () => {
    const { inputPath, home } = inputFile([JSON.stringify({ id: 'x', url: 'https://example.com/', colour: 'red', phone: 1184960000 })]);
    const result = await runCliAsync(['find', `--input=${inputPath}`, '--output=json', '--dry-run'], { HOME: home });
    const line = JSON.parse(result.stdout.trim()) as { error: { code: string }; problems: string[] };
    assert.equal(line.error.code, 'input.bad_value');
    assert.equal(line.problems.length, 2);
  });

  test('an unreadable input file is a usage error; a query on the command line too', async () => {
    const home = makeTemporaryHome();
    const missing = await runCliAsync(['find', `--input=${path.join(home, 'missing.jsonl')}`], { HOME: home });
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /Can't read the input file/);
    const { inputPath } = inputFile([]);
    const withName = await runCliAsync(['find', 'Example', `--input=${inputPath}`], { HOME: home });
    assert.equal(withName.exitCode, 2);
    assert.match(withName.stderr, /each line is the query/);
    const badConcurrency = await runCliAsync(['find', `--input=${inputPath}`, '--concurrency=99'], { HOME: home });
    assert.equal(badConcurrency.exitCode, 2);
  });
});
