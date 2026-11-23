import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../lookup/clock.js';
import type { Logger } from '../logger.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MS_PER_SECOND = 1000;
const SHARD_LENGTH = 2;
const TEMPORARY_SUFFIX_BYTES = 6;

interface CacheEntry {
  storedAt: number;
  ttlSeconds: number;
  data: unknown;
}

/** A provider's view of the response cache: what its cache policy allows it to keep, for as long as it allows. */
export interface ProviderCache {
  get(kind: string, key: string): unknown;
  set(kind: string, key: string, data: unknown, ttlSeconds: number): void;
}

/** A cache that keeps nothing: for --no-cache, and for providers whose terms forbid caching. */
export const NO_CACHE: ProviderCache = {
  get: () => undefined,
  set: () => undefined,
};

export interface CacheStoreOptions {
  directory: string;
  clock: Clock;
  logger: Logger;
  /** Records a problem in the lookup's result: the durable trace for a corrupt entry. */
  warn(message: string): void;
}

/** Writes a file atomically: a temporary file in the same directory, then rename. */
export function writeAtomically(filePath: string, contents: string | Buffer): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
  const temporary = `${filePath}.${randomBytes(TEMPORARY_SUFFIX_BYTES).toString('hex')}.tmp`;
  writeFileSync(temporary, contents, { mode: FILE_MODE });
  renameSync(temporary, filePath);
}

/** A file-backed cache for one provider: <directory>/responses/<provider>/<shard>/<hash>.json. */
export function providerCache(provider: string, options: CacheStoreOptions): ProviderCache {
  const entryPath = (kind: string, key: string): string => {
    const hash = createHash('sha256').update(`${provider}\n${kind}\n${key}`).digest('hex');
    return path.join(options.directory, 'responses', provider, hash.slice(0, SHARD_LENGTH), `${hash}.json`);
  };
  return {
    get(kind: string, key: string): unknown {
      const filePath = entryPath(kind, key);
      let data: unknown;
      try {
        const entry = JSON.parse(readFileSync(filePath, 'utf8')) as CacheEntry;
        const isFresh = typeof entry.storedAt === 'number' && options.clock.now() < entry.storedAt + (entry.ttlSeconds * MS_PER_SECOND);
        if (isFresh) {
          data = entry.data;
        } else {
          rmSync(filePath, { force: true });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          options.logger.warn('Discarding a corrupt cache entry', { provider, kind, path: filePath, error });
          options.warn(`A corrupt ${provider} cache entry was discarded.`);
          rmSync(filePath, { force: true });
        }
        data = undefined; // A miss: no entry, or a corrupt one just removed.
      }
      return data;
    },
    set(kind: string, key: string, data: unknown, ttlSeconds: number): void {
      if (ttlSeconds > 0) {
        writeAtomically(entryPath(kind, key), JSON.stringify({ storedAt: options.clock.now(), ttlSeconds, data } satisfies CacheEntry));
      }
    },
  };
}
