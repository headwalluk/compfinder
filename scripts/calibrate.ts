/**
 * Records a batch's live HTTP exchanges, or replays a batch against them with no network calls.
 *
 *   tsx scripts/calibrate.ts record <input.jsonl> <recording-dir>
 *   tsx scripts/calibrate.ts replay <input.jsonl> <recording-dir> [results.jsonl]
 *
 * Recordings hold third-party pages and API answers, so they live under recordings/, which is
 * never committed (docs/development.md, Calibration).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { loadConfigFromEnvironment } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { runLookup } from '../src/lookup/engine.js';
import { normaliseQuery, readQueryInput } from '../src/lookup/query.js';
import { buildResult } from '../src/lookup/result.js';
import { redact } from '../src/net/redact.js';
import { LIVE_TRANSPORT, type Transport, type TransportRequest } from '../src/net/transport.js';
import { builtInProviders } from '../src/providers/registry.js';

const MODES = ['record', 'replay'] as const;
type Mode = (typeof MODES)[number];
const RESPONSES_DIRECTORY = 'responses';
const NOT_RECORDED = 'ENOTRECORDED';

/** One saved exchange: enough to answer the same request again, byte for byte. */
interface Exchange {
  method: string;
  url: string;
  requestBody: string | null;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

/** The file an exchange is stored in, keyed by method, URL and request body. */
function exchangePath(directory: string, request: Pick<TransportRequest, 'method' | 'url' | 'body'>): string {
  const hash = createHash('sha256').update(`${request.method}\n${request.url.href}\n${request.body ?? ''}`).digest('hex');
  return path.join(directory, RESPONSES_DIRECTORY, `${hash}.json`);
}

/** Undoes a response's content encoding. */
function decodeBody(raw: Buffer, encoding: string): Buffer {
  let decoded = raw;
  if (encoding.includes('gzip')) {
    decoded = gunzipSync(raw);
  } else if (encoding.includes('br')) {
    decoded = brotliDecompressSync(raw);
  } else if (encoding.includes('deflate')) {
    decoded = inflateSync(raw);
  }
  return decoded;
}

/** Wraps the live network, saving every exchange; any API key echoed in a body is redacted. */
function recordingTransport(directory: string, secrets: readonly string[]): Transport {
  return {
    async send(request) {
      const response = await LIVE_TRANSPORT.send(request);
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      // Stored decoded, so a key echoed in any body can be redacted; replay serves it unencoded.
      const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !['content-encoding', 'content-length'].includes(name)));
      const decoded = decodeBody(raw, response.headers['content-encoding'] ?? '');
      const stored = Buffer.from(redact(decoded.toString('latin1'), secrets), 'latin1');
      const exchange: Exchange = {
        method: request.method, url: request.url.href, requestBody: request.body,
        status: response.status, headers, bodyBase64: stored.toString('base64'),
      };
      writeFileSync(exchangePath(directory, request), `${JSON.stringify(exchange)}\n`);
      return { ...response, body: (async function* yieldBody() { yield raw; })() };
    },
  };
}

/** Answers from saved exchanges only; a request that wasn't recorded fails as a network error. */
function replayTransport(directory: string, misses: string[]): Transport {
  return {
    async send(request) {
      const filePath = exchangePath(directory, request);
      if (!existsSync(filePath)) {
        misses.push(`${request.method} ${request.url.href}`);
        const missing: NodeJS.ErrnoException = new Error(`${request.url.href} wasn't recorded`);
        missing.code = NOT_RECORDED;
        throw missing;
      }
      const exchange = JSON.parse(readFileSync(filePath, 'utf8')) as Exchange;
      const body = Buffer.from(exchange.bodyBase64, 'base64');
      return { status: exchange.status, headers: exchange.headers, body: (async function* yieldBody() { yield body; })() };
    },
  };
}

/** Runs every input line, one at a time, and writes one result line each, as find --input does. */
async function run(mode: Mode, inputPath: string, directory: string, outputPath: string): Promise<void> {
  const config = loadConfigFromEnvironment({});
  const logger = createLogger({ level: 'warn', tag: 'calibrate', stderrOnly: true });
  const secrets = Object.values(config.providers).map((settings) => settings.apiKey).filter((key) => key !== null);
  const misses: string[] = [];
  mkdirSync(path.join(directory, RESPONSES_DIRECTORY), { recursive: true });
  const transport = mode === 'record' ? recordingTransport(directory, secrets) : replayTransport(directory, misses);
  const output: string[] = [];
  for (const line of readFileSync(inputPath, 'utf8').split('\n').filter((entry) => entry.trim() !== '')) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : null;
    const { input, problems: readProblems } = readQueryInput(parsed, ['id']);
    const { query, problems } = normaliseQuery(input ?? {}, config.country);
    if (readProblems.length > 0 || problems.length > 0) {
      output.push(JSON.stringify({ id, ok: false, problems: [...readProblems, ...problems] }));
      continue;
    }
    const outcome = await runLookup({
      query, providers: builtInProviders(config), config, logger, transport, isCacheBypassed: true, isDownloadSkipped: true,
    });
    const result = buildResult(outcome, { isExplain: true });
    output.push(JSON.stringify({ id, ok: result.error === null, ...result }));
    console.error(`${id ?? '?'}: identity ${result.identity.confidence} ${result.identity.rules.join(', ')}`);
  }
  writeFileSync(outputPath, `${output.join('\n')}\n`);
  if (misses.length > 0) {
    console.error(`${misses.length} request(s) weren't in the recording:\n  ${misses.join('\n  ')}`);
  }
}

const [modeArgument, inputPath, directory, outputArgument] = process.argv.slice(2);
if (!MODES.includes(modeArgument as Mode) || inputPath === undefined || directory === undefined) {
  console.error('Usage: tsx scripts/calibrate.ts record|replay <input.jsonl> <recording-dir> [results.jsonl]');
  process.exitCode = 2;
} else {
  const mode = modeArgument as Mode;
  await run(mode, inputPath, directory, outputArgument ?? path.join(directory, `results-${mode}.jsonl`));
}
