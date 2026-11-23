import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const HASH_LENGTH = 12;

/** The logo cache's file for a domain and source URL, without its extension: <dir>/logos/<domain>/<kind>-<hash>. */
export function logoBasePath(cacheDir: string, domain: string, kind: string, sourceUrl: string): string {
  const hash = createHash('sha256').update(sourceUrl).digest('hex').slice(0, HASH_LENGTH);
  return path.join(cacheDir, 'logos', domain.replace(/[^a-z0-9.-]/gi, '_'), `${kind}-${hash}`);
}

/** Finds a cached logo for a base path, whatever its extension; null when there isn't one. */
export function findCachedLogo(basePath: string): string | null {
  let found: string | null;
  try {
    const name = readdirSync(path.dirname(basePath)).find((entry) => entry.startsWith(`${path.basename(basePath)}.`) && !entry.endsWith('.tmp'));
    found = name === undefined ? null : path.join(path.dirname(basePath), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    found = null; // No logos cached for this domain yet.
  }
  return found;
}
