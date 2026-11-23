import { readFileSync } from 'node:fs';
import { findCachedLogo, logoBasePath } from '../cache/logos.js';
import { writeAtomically } from '../cache/store.js';
import { imageDimensions } from '../images/dimensions.js';
import { IMAGE_TYPES, sniffImage } from '../images/sniff.js';
import { ImageError, rasteriseSvg } from '../images/svg.js';
import type { Logger } from '../logger.js';
import { HttpError, type HttpClient } from '../net/http-client.js';
import { siteHost } from '../normalise/url.js';
import type { FieldItem } from '../scoring/evidence.js';
import type { LogoValue, SourceRecord } from './types.js';

/** Most logo candidates tried before giving up; each failure falls back to the next best. */
export const MAX_LOGO_ATTEMPTS = 3;
const SUCCESS_MIN = 200;
const SUCCESS_MAX = 299;

export interface LogoOptions {
  http: HttpClient;
  cacheDir: string;
  /** --no-cache: don't reuse a cached file. The downloaded file is still stored, because its path is the result. */
  isCacheBypassed: boolean;
  logger: Logger;
}

/** A downloaded logo, ready to store: PNG when it was an SVG. */
interface StoredLogo {
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  convertedFrom: string | null;
}

/** Reads an image from bytes: sniffs its type, measures it, and rasterises an SVG to PNG. Null when it isn't an image. */
function prepareImage(bytes: Buffer): { bytes: Buffer; extension: string; mime: string; width: number | null; height: number | null; convertedFrom: string | null } | null {
  const type = sniffImage(bytes);
  let prepared = null;
  if (type === 'svg') {
    const rendered = rasteriseSvg(bytes);
    prepared = { bytes: rendered.png, extension: IMAGE_TYPES.png.extension, mime: IMAGE_TYPES.png.mime, width: rendered.width, height: rendered.height, convertedFrom: 'svg' };
  } else if (type !== null) {
    const dimensions = imageDimensions(bytes, type);
    prepared = { bytes, extension: IMAGE_TYPES[type].extension, mime: IMAGE_TYPES[type].mime, width: dimensions?.width ?? null, height: dimensions?.height ?? null, convertedFrom: null };
  }
  return prepared;
}

/** Fetches (or reuses) one logo candidate and stores it in the logo cache; null when it isn't a usable image. */
async function storeLogo(logo: LogoValue, options: LogoOptions): Promise<StoredLogo | null> {
  const basePath = logoBasePath(options.cacheDir, siteHost(new URL(logo.source_url).hostname), logo.kind, logo.source_url);
  const cachedPath = options.isCacheBypassed ? null : findCachedLogo(basePath);
  let stored: StoredLogo | null = null;
  if (cachedPath !== null) {
    const prepared = prepareImage(readFileSync(cachedPath));
    stored = prepared === null ? null : { path: cachedPath, mime: prepared.mime, width: prepared.width, height: prepared.height, convertedFrom: logo.source_url.toLowerCase().includes('.svg') ? 'svg' : null };
  } else {
    const response = await options.http.request({ url: logo.source_url, kind: 'image' });
    const prepared = response.status >= SUCCESS_MIN && response.status <= SUCCESS_MAX ? prepareImage(response.body) : null;
    if (prepared !== null) {
      const filePath = `${basePath}.${prepared.extension}`;
      writeAtomically(filePath, prepared.bytes);
      stored = { path: filePath, mime: prepared.mime, width: prepared.width, height: prepared.height, convertedFrom: prepared.convertedFrom };
    }
  }
  return stored;
}

/**
 * Downloads the best logo candidates in turn until one is a usable image, recording its local path and size.
 * Candidates that fail are removed from their records, so re-scoring picks the next best.
 */
export async function settleLogo(candidates: ReadonlyArray<FieldItem<'logo'>>, options: LogoOptions): Promise<void> {
  let isSettled = false;
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (isSettled || tried.size >= MAX_LOGO_ATTEMPTS) {
      break;
    }
    if (tried.has(candidate.value.source_url)) {
      continue;
    }
    tried.add(candidate.value.source_url);
    let stored: StoredLogo | null = null;
    try {
      stored = await storeLogo(candidate.value, options);
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof ImageError)) {
        throw error;
      }
      options.logger.warn(`Couldn't use logo ${candidate.value.source_url}: ${error.message}`);
    }
    const sameUrl = candidates.filter((other) => other.value.source_url === candidate.value.source_url);
    for (const item of sameUrl) {
      if (stored === null) {
        removeEvidence(item.record, item.evidence);
      } else {
        Object.assign(item.evidence.value, {
          path: stored.path, mime: stored.mime, width: stored.width, height: stored.height, converted_from: stored.convertedFrom,
        });
      }
    }
    isSettled = stored !== null;
  }
}

/** Drops one piece of evidence from its record. */
function removeEvidence(record: SourceRecord, evidence: FieldItem<'logo'>['evidence']): void {
  const index = record.evidence.indexOf(evidence);
  if (index !== -1) {
    record.evidence.splice(index, 1);
  }
}
