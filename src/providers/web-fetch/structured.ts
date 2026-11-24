import type { Element } from 'domhandler';
import * as DomUtils from 'domutils';
import type { ParsedPage } from './document.js';
import { resolveUrl } from './document.js';
import SCHEMA_TYPES from './schema-org-types.json' with { type: 'json' };

const ORGANIZATION_TYPES: ReadonlySet<string> = new Set(SCHEMA_TYPES.organization);
const LOCAL_BUSINESS_TYPES: ReadonlySet<string> = new Set(SCHEMA_TYPES.localBusiness);
const SCHEMA_ORG_PREFIX = /^(?:https?:\/\/)?(?:www\.)?schema\.org\//i;
const JSON_LD_TYPE = 'application/ld+json';
/** Deepest nesting followed in JSON-LD, so a hostile document can't recurse forever. */
const MAX_JSON_LD_DEPTH = 12;
/** Properties whose inline value is another organisation (a department, a parent company), not this business. */
const OTHER_ORGANIZATION_PROPERTIES: ReadonlySet<string> = new Set([
  'department', 'parentOrganization', 'subOrganization', 'member', 'memberOf',
]);
/** Most business blocks taken from one page. */
const MAX_BLOCKS_PER_PAGE = 50;

/** One schema.org Organization (or descendant) found in a page, as plain properties. */
export interface BusinessBlock {
  types: string[];
  isLocalBusiness: boolean;
  properties: Record<string, unknown>;
  syntax: 'json-ld' | 'microdata';
}

/** The schema.org type names in an @type or itemtype value. */
function typeNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string').flatMap((entry) => entry.split(/\s+/))
    .map((entry) => entry.replace(SCHEMA_ORG_PREFIX, '').replace(/^schema:/, '')).filter((entry) => entry !== '');
}

/** True for a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns a list of types into a block when any is an Organization type. */
function blockFor(types: string[], properties: Record<string, unknown>, syntax: BusinessBlock['syntax']): BusinessBlock | null {
  const isOrganization = types.some((type) => ORGANIZATION_TYPES.has(type));
  return isOrganization ? { types, isLocalBusiness: types.some((type) => LOCAL_BUSINESS_TYPES.has(type)), properties, syntax } : null;
}

/** Replaces {"@id": "..."} references with the node they name, one level deep. */
function resolveReferences(node: Record<string, unknown>, nodesById: Map<string, Record<string, unknown>>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const reference = isObject(value) && Object.keys(value).length === 1 && typeof value['@id'] === 'string' ? nodesById.get(value['@id']) : undefined;
    resolved[key] = reference ?? value;
  }
  return resolved;
}

/** Finds Organization blocks in a page's JSON-LD, including nested and @graph nodes. Bad JSON is counted, not thrown. */
export function jsonLdBlocks(page: ParsedPage): { blocks: BusinessBlock[]; badScripts: number } {
  const nodes: Array<Record<string, unknown>> = [];
  let badScripts = 0;
  for (const script of page.scripts.filter((entry) => entry.type === JSON_LD_TYPE)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(script.text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      badScripts += 1; // Reported as a count; one bad block doesn't stop the rest.
    }
    const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
    while (pending.length > 0) {
      const next = pending.shift();
      if (next === undefined) {
        break;
      }
      if (Array.isArray(next.value) && next.depth < MAX_JSON_LD_DEPTH) {
        pending.push(...next.value.map((value) => ({ value, depth: next.depth + 1 })));
      } else if (isObject(next.value) && next.depth < MAX_JSON_LD_DEPTH) {
        nodes.push(next.value);
        // An organisation written inline under department or parentOrganization is someone else; one referenced by @id is
        // still read from where it's defined (often the site's own brand, in @graph).
        const children = Object.entries(next.value).filter(([key]) => !OTHER_ORGANIZATION_PROPERTIES.has(key)).map(([, value]) => value);
        pending.push(...children.map((value) => ({ value, depth: next.depth + 1 })));
      }
    }
  }
  const nodesById = new Map(nodes.filter((node) => typeof node['@id'] === 'string').map((node) => [node['@id'] as string, node]));
  const blocks = nodes
    .map((node) => blockFor(typeNames(node['@type']), resolveReferences(node, nodesById), 'json-ld'))
    .filter((block) => block !== null)
    .slice(0, MAX_BLOCKS_PER_PAGE);
  return { blocks, badScripts };
}

/** An itemprop's value: content, href, src or datetime by element, else its text. */
function microdataValue(element: Element, pageUrl: string): unknown {
  const attributes = element.attribs;
  let value: unknown;
  if (attributes.itemscope !== undefined) {
    value = microdataItem(element, pageUrl);
  } else if (attributes.content !== undefined) {
    value = attributes.content;
  } else if (['a', 'link', 'area'].includes(element.name) && attributes.href !== undefined) {
    value = resolveUrl(attributes.href, pageUrl) ?? attributes.href;
  } else if (['img', 'source', 'video', 'audio', 'embed', 'iframe'].includes(element.name) && attributes.src !== undefined) {
    value = resolveUrl(attributes.src, pageUrl) ?? attributes.src;
  } else if (element.name === 'time' && attributes.datetime !== undefined) {
    value = attributes.datetime;
  } else {
    value = DomUtils.textContent(element).replace(/\s+/g, ' ').trim();
  }
  return value;
}

/** Reads one itemscope element into properties, without crossing into nested items. */
function microdataItem(scope: Element, pageUrl: string): Record<string, unknown> {
  const properties: Record<string, unknown> = { '@type': typeNames(scope.attribs.itemtype ?? '') };
  const pending: Element[] = DomUtils.getChildren(scope).filter((child): child is Element => child.type === 'tag');
  while (pending.length > 0) {
    const element = pending.shift();
    if (element === undefined) {
      break;
    }
    const names = (element.attribs.itemprop ?? '').split(/\s+/).filter((name) => name !== '');
    for (const name of names) {
      const value = microdataValue(element, pageUrl);
      const existing = properties[name];
      properties[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    if (element.attribs.itemscope === undefined) {
      pending.unshift(...DomUtils.getChildren(element).filter((child): child is Element => child.type === 'tag'));
    }
  }
  return properties;
}

/** Finds Organization blocks in a page's microdata. */
export function microdataBlocks(page: ParsedPage): BusinessBlock[] {
  const scopes = DomUtils.findAll((element) => element.attribs.itemscope !== undefined && element.attribs.itemtype !== undefined, page.document.children);
  return scopes
    .map((scope) => {
      const properties = microdataItem(scope, page.baseUrl);
      return blockFor(typeNames(properties['@type']), properties, 'microdata');
    })
    .filter((block) => block !== null)
    .slice(0, MAX_BLOCKS_PER_PAGE);
}
