import { QUERY_SOURCE, type Query, type SourceRecord } from '../lookup/types.js';
import { compareNames } from '../normalise/name.js';
import { isSameSite, isSiteRoot, pagePath } from '../normalise/url.js';
import { fieldItems, recordSite } from './evidence.js';

/** One possible real-world place: linked location records, plus the brand records that apply to it. */
export interface Candidate {
  /** Position in deterministic order, from 0. */
  index: number;
  /** The records that identify the place: location records, or brand records when there are none. */
  records: SourceRecord[];
  /** Brand records attached to this candidate (empty when records are themselves brand records). */
  brandRecords: SourceRecord[];
  /** The strong keys that linked the records, such as "postcode RG1 1AA". */
  linkedBy: string[];
}

/** The strong key two records share, or null when they share none (05: linking). */
function sharedKey(first: SourceRecord, second: SourceRecord): string | null {
  let key: string | null = null;
  const firstPlaceIds = fieldItems([first], 'place_id').map((item) => item.value);
  const secondPlaceIds = new Set(fieldItems([second], 'place_id').map((item) => item.value));
  const firstPhones = fieldItems([first], 'phone').map((item) => item.value.e164);
  const secondPhones = new Set(fieldItems([second], 'phone').map((item) => item.value.e164));
  const firstPostcodes = fieldItems([first], 'address').map((item) => item.value.postcode).filter((postcode) => postcode !== null);
  const secondPostcodes = new Set(fieldItems([second], 'address').map((item) => item.value.postcode));
  const placeId = firstPlaceIds.find((value) => secondPlaceIds.has(value));
  const phone = firstPhones.find((value) => secondPhones.has(value));
  const postcode = firstPostcodes.find((value) => secondPostcodes.has(value));
  const page = fieldItems([first], 'website').find((firstItem) => !isSiteRoot(firstItem.value.url)
    && fieldItems([second], 'website').some((secondItem) => isSameSite(firstItem.value.domain, secondItem.value.domain)
      && pagePath(firstItem.value.url) === pagePath(secondItem.value.url)));
  if (placeId !== undefined) {
    key = `place ID ${placeId}`;
  } else if (phone !== undefined) {
    key = `phone ${phone}`;
  } else if (postcode !== undefined && namesCompatible(first, second)) {
    key = `postcode ${postcode}`;
  } else if (page !== undefined) {
    key = `page ${page.value.url}`;
  }
  return key;
}

/** True unless both records have names and every pairing is incompatible. */
function namesCompatible(first: SourceRecord, second: SourceRecord): boolean {
  const firstNames = fieldItems([first], 'name').map((item) => item.value);
  const secondNames = fieldItems([second], 'name').map((item) => item.value);
  return firstNames.length === 0 || secondNames.length === 0
    || firstNames.some((firstName) => secondNames.some((secondName) => compareNames(firstName, secondName) !== 'incompatible'));
}

/** Finds the root of a union-find set, compressing the path. */
function findRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) {
    root = parents[root] ?? root;
  }
  let current = index;
  while (parents[current] !== root) {
    const next = parents[current] ?? root;
    parents[current] = root;
    current = next;
  }
  return root;
}

/** Links records into candidates and attaches brand records, all in a deterministic order. */
export function linkCandidates(records: readonly SourceRecord[], query: Query): Candidate[] {
  const sourced = records.filter((record) => record.source !== QUERY_SOURCE);
  const locations = sourced.filter((record) => record.scope === 'location');
  const brands = sourced.filter((record) => record.scope === 'brand');
  let candidates: Candidate[];

  if (locations.length === 0) {
    candidates = brands.length === 0 ? [] : [{ index: 0, records: brands, brandRecords: [], linkedBy: [] }];
  } else {
    const parents = locations.map((unusedRecord, index) => index);
    const linkKeys = new Map<number, string[]>();
    for (let first = 0; first < locations.length; first += 1) {
      for (let second = first + 1; second < locations.length; second += 1) {
        const firstRecord = locations[first];
        const secondRecord = locations[second];
        const key = firstRecord !== undefined && secondRecord !== undefined ? sharedKey(firstRecord, secondRecord) : null;
        if (key !== null) {
          const firstRoot = findRoot(parents, first);
          const secondRoot = findRoot(parents, second);
          const root = Math.min(firstRoot, secondRoot);
          parents[firstRoot] = root;
          parents[secondRoot] = root;
          linkKeys.set(root, [...(linkKeys.get(firstRoot) ?? []), ...(linkKeys.get(secondRoot) ?? []), key]);
        }
      }
    }
    const groups = new Map<number, SourceRecord[]>();
    locations.forEach((record, index) => {
      const root = findRoot(parents, index);
      groups.set(root, [...(groups.get(root) ?? []), record]);
    });
    candidates = [...groups.entries()].map(([root, groupRecords], index) => ({
      index,
      records: groupRecords,
      brandRecords: [],
      linkedBy: [...new Set(linkKeys.get(root) ?? [])],
    }));
    attachBrandRecords(candidates, brands, query);
  }
  return candidates;
}

/** Gives each candidate the brand records for its site; brand records from the queried site go to all. */
function attachBrandRecords(candidates: Candidate[], brands: readonly SourceRecord[], query: Query): void {
  const querySite = query.website?.domain ?? null;
  for (const brand of brands) {
    const brandSite = recordSite(brand);
    for (const candidate of candidates) {
      const candidateSites = candidate.records.map(recordSite).filter((site) => site !== null);
      const appliesToAll = brandSite === null || (querySite !== null && isSameSite(brandSite, querySite));
      if (appliesToAll || candidateSites.some((site) => isSameSite(site, brandSite))) {
        candidate.brandRecords.push(brand);
      }
    }
  }
}
