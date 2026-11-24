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

/** A key two records share: words for reasons, and how specific it is (a place ID names one place; a postcode, one building). */
interface SharedKey {
  label: string;
  strength: number;
}

const KEY_STRENGTH = { placeId: 4, mapsCid: 4, phone: 3, page: 3, postcode: 2 } as const;

/** The strongest key two records share, or null when they share none (docs/confidence.md: identity). */
function sharedKey(first: SourceRecord, second: SourceRecord): SharedKey | null {
  let key: SharedKey | null = null;
  const firstPlaceIds = fieldItems([first], 'place_id').map((item) => item.value);
  const secondPlaceIds = new Set(fieldItems([second], 'place_id').map((item) => item.value));
  const firstPhones = fieldItems([first], 'phone').map((item) => item.value.e164);
  const secondPhones = new Set(fieldItems([second], 'phone').map((item) => item.value.e164));
  const firstPostcodes = fieldItems([first], 'address').map((item) => item.value.postcode).filter((postcode) => postcode !== null);
  const secondPostcodes = new Set(fieldItems([second], 'address').map((item) => item.value.postcode));
  const placeId = firstPlaceIds.find((value) => secondPlaceIds.has(value));
  const mapsCid = first.mapsCids?.find((value) => second.mapsCids?.includes(value) === true);
  const phone = firstPhones.find((value) => secondPhones.has(value));
  const postcode = firstPostcodes.find((value) => secondPostcodes.has(value));
  const page = fieldItems([first], 'website').find((firstItem) => !isSiteRoot(firstItem.value.url)
    && fieldItems([second], 'website').some((secondItem) => isSameSite(firstItem.value.domain, secondItem.value.domain)
      && pagePath(firstItem.value.url) === pagePath(secondItem.value.url)));
  if (placeId !== undefined) {
    key = { label: `place ID ${placeId}`, strength: KEY_STRENGTH.placeId };
  } else if (mapsCid !== undefined) {
    key = { label: `Google Maps listing cid ${mapsCid}`, strength: KEY_STRENGTH.mapsCid };
  } else if (phone !== undefined) {
    key = { label: `phone ${phone}`, strength: KEY_STRENGTH.phone };
  } else if (page !== undefined) {
    key = { label: `page ${page.value.url}`, strength: KEY_STRENGTH.page };
  } else if (postcode !== undefined && namesCompatible(first, second)) {
    key = { label: `postcode ${postcode}`, strength: KEY_STRENGTH.postcode };
  }
  return key;
}

/** True when the records share a name, compared after removing case, punctuation and legal suffixes. */
function namesEqual(first: SourceRecord, second: SourceRecord): boolean {
  const secondNames = fieldItems([second], 'name').map((item) => item.value);
  return fieldItems([first], 'name').some((item) => secondNames.some((name) => compareNames(item.value, name) === 'equal'));
}

/** True unless both records have names and every pairing is incompatible. */
function namesCompatible(first: SourceRecord, second: SourceRecord): boolean {
  const firstNames = fieldItems([first], 'name').map((item) => item.value);
  const secondNames = fieldItems([second], 'name').map((item) => item.value);
  return firstNames.length === 0 || secondNames.length === 0
    || firstNames.some((firstName) => secondNames.some((secondName) => compareNames(firstName, secondName) !== 'incompatible'));
}

/** The place IDs a record names. */
function placeIdsOf(record: SourceRecord): Set<string> {
  return new Set(fieldItems([record], 'place_id').map((item) => item.value));
}

/**
 * For each record without a place ID, the one place it may join: the place it shares its strongest key with. When its
 * strongest key is shared with two or more places (a head office's postcode, in a building of several listings), it
 * can't say which it is, and joins none: null. Records it shares no key with places aren't in the map.
 */
function allowedPlaces(locations: readonly SourceRecord[], keys: ReadonlyArray<ReadonlyArray<SharedKey | null>>): Map<number, string | null> {
  const allowed = new Map<number, string | null>();
  locations.forEach((record, index) => {
    const links = locations.flatMap((other, otherIndex) => {
      const key = keys[index]?.[otherIndex] ?? null;
      return key === null ? [] : [...placeIdsOf(other)].map((placeId) => ({ placeId, strength: key.strength }));
    });
    const strongest = Math.max(0, ...links.map((link) => link.strength));
    const places = [...new Set(links.filter((link) => link.strength === strongest).map((link) => link.placeId))];
    // Several places at the strongest key (a brewery and its tap room, one switchboard): the one named exactly as this record.
    const sameName = places.filter((placeId) => locations.some((other) => placeIdsOf(other).has(placeId) && namesEqual(record, other)));
    if (placeIdsOf(record).size === 0 && places.length > 0) {
      allowed.set(index, places.length === 1 ? places[0] ?? null : sameName.length === 1 ? sameName[0] ?? null : null);
    }
  });
  return allowed;
}

/** True when a record's allowed place (see allowedPlaces) rules out joining a group with these place IDs. */
function isRuledOut(allowed: Map<number, string | null>, index: number, groupIds: ReadonlySet<string>): boolean {
  const place = allowed.get(index);
  return groupIds.size > 0 && place !== undefined && (place === null || !groupIds.has(place));
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
    const keys = locations.map((first, firstIndex) => locations.map((second, secondIndex) => (
      firstIndex === secondIndex ? null : sharedKey(first, second)
    )));
    const allowed = allowedPlaces(locations, keys);
    const rootPlaceIds = new Map<number, Set<string>>(locations.map((record, index) => [index, placeIdsOf(record)]));
    for (let first = 0; first < locations.length; first += 1) {
      for (let second = first + 1; second < locations.length; second += 1) {
        const key = keys[first]?.[second] ?? null;
        const firstRoot = findRoot(parents, first);
        const secondRoot = findRoot(parents, second);
        const firstIds = rootPlaceIds.get(firstRoot) ?? new Set<string>();
        const secondIds = rootPlaceIds.get(secondRoot) ?? new Set<string>();
        // Different place IDs are different places, however much else they share (one building, one switchboard).
        const isDistinctPlaces = firstIds.size > 0 && secondIds.size > 0 && ![...firstIds].some((id) => secondIds.has(id));
        const isRuledOutLink = isRuledOut(allowed, first, secondIds) || isRuledOut(allowed, second, firstIds);
        if (key !== null && firstRoot !== secondRoot && !isDistinctPlaces && !isRuledOutLink) {
          const root = Math.min(firstRoot, secondRoot);
          parents[firstRoot] = root;
          parents[secondRoot] = root;
          rootPlaceIds.set(root, new Set([...firstIds, ...secondIds]));
          linkKeys.set(root, [...(linkKeys.get(firstRoot) ?? []), ...(linkKeys.get(secondRoot) ?? []), key.label]);
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
      // A place with no website of its own takes the brand of a site whose name it shares (a search found the site).
      const isNamedSiteless = candidateSites.length === 0 && candidate.records.some((record) => namesCompatible(brand, record) && fieldItems([record], 'name').length > 0)
        && fieldItems([brand], 'name').length > 0;
      if (appliesToAll || isNamedSiteless || candidateSites.some((site) => isSameSite(site, brandSite))) {
        candidate.brandRecords.push(brand);
      }
    }
  }
}
