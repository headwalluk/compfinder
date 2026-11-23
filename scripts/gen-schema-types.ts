/**
 * Regenerates src/providers/web-fetch/schema-org-types.json from schema.org's vocabulary file.
 * Usage: download https://schema.org/version/latest/schemaorg-current-https.jsonld, then
 * npx tsx scripts/gen-schema-types.ts path/to/schemaorg-current-https.jsonld
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUTPUT_URL = new URL('../src/providers/web-fetch/schema-org-types.json', import.meta.url);
const SCHEMA_PREFIX = 'schema:';

interface VocabularyNode {
  '@id'?: string;
  '@type'?: string | string[];
  'rdfs:subClassOf'?: { '@id': string } | Array<{ '@id': string }>;
}

/** Every class that descends from the root, the root included, without the schema: prefix, sorted. */
function descendants(parents: Map<string, string[]>, root: string): string[] {
  const found = new Set<string>([root]);
  let isGrowing = true;
  while (isGrowing) {
    isGrowing = false;
    for (const [child, childParents] of parents) {
      if (!found.has(child) && childParents.some((parent) => found.has(parent))) {
        found.add(child);
        isGrowing = true;
      }
    }
  }
  return [...found].map((id) => id.slice(SCHEMA_PREFIX.length)).sort();
}

const vocabularyPath = process.argv[2];
if (vocabularyPath === undefined) {
  throw new Error('Give the path to schemaorg-current-https.jsonld');
}
const graph = (JSON.parse(readFileSync(vocabularyPath, 'utf8')) as { '@graph': VocabularyNode[] })['@graph'];
const parents = new Map<string, string[]>();
for (const node of graph) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  const superclasses = node['rdfs:subClassOf'];
  if (node['@id']?.startsWith(SCHEMA_PREFIX) && types.includes('rdfs:Class') && superclasses !== undefined) {
    parents.set(node['@id'], (Array.isArray(superclasses) ? superclasses : [superclasses]).map((entry) => entry['@id']));
  }
}
const output = {
  source: 'https://schema.org/version/latest/schemaorg-current-https.jsonld',
  organization: descendants(parents, 'schema:Organization'),
  localBusiness: descendants(parents, 'schema:LocalBusiness'),
};
writeFileSync(OUTPUT_URL, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${output.organization.length} Organization types, ${output.localBusiness.length} LocalBusiness types`);
