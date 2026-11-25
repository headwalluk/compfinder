import type { PlannedProvider } from '../../lookup/engine.js';
import type { LookupResult, OutputField } from '../../lookup/result.js';
import { normalisePhone } from '../../normalise/phone.js';

const LABEL_WIDTH = 11;
const VALUE_WIDTH = 46;
const SCORE_WIDTH = 4;
const INDENT = '  ';
const CONTINUATION = ' '.repeat(INDENT.length + LABEL_WIDTH);
const HIGH_CONFIDENCE = 100;
const MEDIUM_CONFIDENCE = 40;
/** Any ESC-introduced sequence or other control character: page text must never drive the terminal. */
// eslint-disable-next-line no-control-regex -- stripping control characters is this pattern's purpose
const TERMINAL_CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ANSI = { green: '\u001b[32m', yellow: '\u001b[33m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };
const EMPTY = '—';

/** Removes anything that could act on the terminal from text that came from a page. */
export function terminalSafe(text: string): string {
  return text.replace(TERMINAL_CONTROL, '');
}

/** Formats a confidence, coloured when colour is on: 100 green, 40–99 yellow, below 40 dim. */
function score(confidence: number, isColour: boolean): string {
  const text = String(confidence).padStart(SCORE_WIDTH);
  let coloured = text;
  if (isColour) {
    const colour = confidence >= HIGH_CONFIDENCE ? ANSI.green : confidence >= MEDIUM_CONFIDENCE ? ANSI.yellow : ANSI.dim;
    coloured = `${colour}${text}${ANSI.reset}`;
  }
  return coloured;
}

/** A field's value as one line of text. */
function describeValue(name: string, field: OutputField): string {
  const value = field.value;
  let text: string;
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    text = EMPTY;
  } else if (name === 'address') {
    const address = value as { formatted: string | null; lines: string[]; town: string | null; county: string | null; postcode: string | null };
    text = address.formatted ?? [...address.lines, address.town, address.county, address.postcode].filter((part) => part !== null && part !== '').join(', ');
  } else if (name === 'phone') {
    text = `${String(field.display)}  (${String(value)})`;
  } else if (name === 'logo') {
    const logo = value as { path: string | null; source_url: string };
    text = logo.path ?? logo.source_url;
  } else if (name === 'socials') {
    // A field's value is a list of profiles; each piece of evidence is one profile.
    const profiles = Array.isArray(value) ? value as Array<{ url: string }> : [value as { url: string }];
    text = profiles.map((social) => social.url.replace(/^https:\/\//, '')).join(', ');
  } else {
    text = String(value);
  }
  return terminalSafe(text);
}

/** A field holding another value (a conflict or one source's evidence), with a phone's display written for that number. */
function otherValue(field: OutputField, value: unknown, countryCode: string | null): OutputField {
  const phone = typeof value === 'string' && countryCode !== null ? normalisePhone(value, countryCode) : null;
  return { ...field, value, conflicts: [], ...('display' in field ? { display: phone?.display ?? value } : {}) };
}

/** One field's lines: label, value, confidence and sources, then any conflicts and evidence. */
function fieldLines(name: string, field: OutputField, isColour: boolean, countryCode: string | null): string[] {
  const label = { place_id: 'Place ID' }[name] ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const value = describeValue(name, field);
  const sources = field.sources.join(', ');
  const lines = value.length > VALUE_WIDTH
    ? [`${INDENT}${label.padEnd(LABEL_WIDTH)}${value}`, `${CONTINUATION}${''.padEnd(VALUE_WIDTH)}${score(field.confidence, isColour)}  ${sources}`]
    : [`${INDENT}${label.padEnd(LABEL_WIDTH)}${value.padEnd(VALUE_WIDTH)}${score(field.confidence, isColour)}  ${sources}`.trimEnd()];
  for (const conflict of field.conflicts) {
    const shown = describeValue(name, otherValue(field, conflict.value, countryCode));
    lines.push(`${CONTINUATION}≠ ${shown} (${conflict.sources.join(', ')})`);
  }
  for (const evidence of field.evidence ?? []) {
    const shown = describeValue(name, otherValue(field, evidence.value, countryCode));
    lines.push(`${CONTINUATION}${evidence.agreed ? '·' : '×'} ${evidence.source}: ${shown} [${terminalSafe(evidence.reference.detail)}]`);
  }
  return lines;
}

/** The finger-style summary of one lookup, for people. Not a contract: scripts use --output=json. */
export function renderLookupText(result: LookupResult, isColour: boolean, heading: string | null = null): string {
  const title = terminalSafe(String(result.fields.name.value ?? result.query.name ?? result.query.url ?? 'Unknown business'));
  const titleText = isColour ? `${ANSI.bold}${title}${ANSI.reset}` : title;
  const lines = [
    ...(heading === null ? [] : [heading]),
    `${titleText.padEnd(INDENT.length + LABEL_WIDTH + VALUE_WIDTH)} identity ${score(result.identity.confidence, isColour).trim()}`,
  ];
  for (const [name, field] of Object.entries(result.fields)) {
    lines.push(...fieldLines(name, field, isColour, result.query.country ?? null));
  }
  if (result.identity.candidates.length > 0) {
    lines.push('', `${INDENT}${'Candidates'.padEnd(LABEL_WIDTH)}${result.identity.candidates.length} match equally:`);
    for (const candidate of result.identity.candidates) {
      const summary = [candidate.name, candidate.address, candidate.place_id].filter((part) => part !== null).join(' · ');
      lines.push(`${CONTINUATION}${score(candidate.confidence, isColour).trim()}  ${terminalSafe(summary)}`);
    }
  }
  const ran = result.providers.filter((provider) => provider.status !== 'skipped' && provider.status !== 'not_configured');
  const skipped = result.providers.filter((provider) => provider.status === 'skipped');
  const providerLines = [
    ...ran.map((provider) => {
      const calls = `${provider.calls} ${provider.metered ? 'metered ' : ''}call${provider.calls === 1 ? '' : 's'}`;
      const cached = provider.cached_calls > 0 ? `, ${provider.cached_calls} from cache` : '';
      return `${provider.name} ${provider.status} (${calls}${cached})${provider.detail === null ? '' : `: ${terminalSafe(provider.detail)}`}`;
    }),
    ...skipped.map((provider) => `${provider.name} skipped: ${provider.reason ?? ''}`),
  ];
  lines.push('');
  providerLines.forEach((line, index) => lines.push(`${index === 0 ? `${INDENT}${'Providers'.padEnd(LABEL_WIDTH)}` : CONTINUATION}${line}`));
  result.warnings.forEach((warning, index) => lines.push(`${index === 0 ? `${INDENT}${'Warnings'.padEnd(LABEL_WIDTH)}` : CONTINUATION}${terminalSafe(warning)}`));
  if (result.error !== null) {
    lines.push(`${INDENT}${'Error'.padEnd(LABEL_WIDTH)}${result.error.message}${result.error.detail === null ? '' : ` (${terminalSafe(result.error.detail)})`}`);
  }
  return lines.join('\n');
}

/** The --dry-run plan, for people. */
export function renderPlanText(providers: readonly PlannedProvider[], maxMeteredCalls: number): string {
  const width = Math.max(...providers.map((provider) => provider.name.length)) + 2;
  const lines = providers.map((provider) => {
    const detail = provider.status === 'would_run'
      ? `would run${provider.metered ? `, at most ${provider.maxCalls} metered call${provider.maxCalls === 1 ? '' : 's'}` : ' (free)'}`
      : `${provider.status.replace('_', ' ')}: ${provider.reason ?? ''}`;
    return `${provider.name.padEnd(width)}${provider.stage.padEnd('discover'.length + 2)}${detail}`;
  });
  return [...lines, '', `At most ${maxMeteredCalls} metered call${maxMeteredCalls === 1 ? '' : 's'}. No calls were made.`].join('\n');
}
