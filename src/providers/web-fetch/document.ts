import type { ChildNode, Document, Element } from 'domhandler';
import * as DomUtils from 'domutils';
import { parseDocument } from 'htmlparser2';

/** Elements whose text a visitor never sees. */
const HIDDEN_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg']);
const WHITESPACE_RUN = /\s+/g;

export interface PageLink {
  /** Absolute URL, without a fragment. */
  url: string;
  text: string;
}

export interface ParsedPage {
  url: string;
  document: Document;
  title: string;
  visibleText: string;
  links: PageLink[];
  /** <meta property|name> values, lower-case keys, first value wins. */
  meta: Map<string, string>;
  /** <link rel> entries: lower-case rel tokens, absolute href, sizes. */
  linkTags: Array<{ rel: string[]; href: string; sizes: string | null; type: string | null }>;
  /** Text of every <script> element, with its src and type. */
  scripts: Array<{ src: string | null; type: string | null; text: string }>;
}

/** Resolves a possibly relative reference against the page, without its fragment; null when it isn't a URL. */
export function resolveUrl(reference: string, base: string): string | null {
  let resolved: string | null = null;
  if (URL.canParse(reference.trim(), base)) {
    const url = new URL(reference.trim(), base);
    url.hash = '';
    resolved = url.href;
  }
  return resolved;
}

/** Collects the text a visitor would see, skipping scripts, styles and other hidden elements. */
function visibleText(nodes: ChildNode[]): string {
  const parts: string[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node === undefined) {
      break;
    }
    if (node.type === 'text') {
      parts.push(node.data);
    } else if ((node.type === 'tag' || node.type === 'script' || node.type === 'style') && !HIDDEN_ELEMENTS.has(node.name)) {
      pending.unshift(...node.children);
    } else if (node.type === 'root') {
      pending.unshift(...node.children);
    }
  }
  return parts.join(' ').replace(WHITESPACE_RUN, ' ').trim();
}

/** Parses an HTML page and pulls out what the extractors need. */
export function parsePage(html: string, url: string): ParsedPage {
  const document = parseDocument(html, { decodeEntities: true });
  const elements = DomUtils.findAll(() => true, document.children);
  const byName = (name: string): Element[] => elements.filter((element) => element.name === name);
  const meta = new Map<string, string>();
  for (const element of byName('meta')) {
    const key = (element.attribs.property ?? element.attribs.name ?? '').toLowerCase();
    const content = element.attribs.content;
    if (key !== '' && content !== undefined && !meta.has(key)) {
      meta.set(key, content);
    }
  }
  const links: PageLink[] = [];
  for (const element of byName('a')) {
    const href = element.attribs.href;
    const resolved = href === undefined ? null : (href.trim().match(/^(tel|mailto):/i) ? href.trim() : resolveUrl(href, url));
    if (resolved !== null) {
      links.push({ url: resolved, text: DomUtils.textContent(element).replace(WHITESPACE_RUN, ' ').trim() });
    }
  }
  const linkTags = byName('link').flatMap((element) => {
    const href = element.attribs.href === undefined ? null : resolveUrl(element.attribs.href, url);
    return href === null ? [] : [{
      rel: (element.attribs.rel ?? '').toLowerCase().split(WHITESPACE_RUN).filter((token) => token !== ''),
      href,
      sizes: element.attribs.sizes ?? null,
      type: element.attribs.type ?? null,
    }];
  });
  const scripts = byName('script').map((element) => ({
    src: element.attribs.src ?? null,
    type: element.attribs.type?.toLowerCase() ?? null,
    text: DomUtils.textContent(element),
  }));
  const titleElement = byName('title')[0];
  return {
    url,
    document,
    title: titleElement === undefined ? '' : DomUtils.textContent(titleElement).replace(WHITESPACE_RUN, ' ').trim(),
    visibleText: visibleText(document.children),
    links,
    meta,
    linkTags,
    scripts,
  };
}
