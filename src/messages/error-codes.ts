import { ExitCode, type ExitCodeValue } from '../cli/exit-codes.js';

/** Stable codes for errors that reach the caller. Listed in docs/output.md; callers match on the code. */
export const ERROR_CODES = {
  'input.bad_json': { exitCode: ExitCode.usage, message: 'The input line is not valid JSON.' },
  'input.no_query': { exitCode: ExitCode.usage, message: 'The query gives nothing to look up.' },
  'input.bad_value': { exitCode: ExitCode.usage, message: 'A value in the query is invalid.' },
  'lookup.no_provider': { exitCode: ExitCode.invalidConfig, message: 'No configured provider could serve this query.' },
  'lookup.all_failed': { exitCode: ExitCode.failure, message: 'Every provider that was tried failed.' },
} as const satisfies Record<string, { exitCode: ExitCodeValue; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** An error as it appears in output: the stable code, its message, and any detail. */
export interface OutputError {
  code: ErrorCode;
  message: string;
  detail: string | null;
}

/** Builds the output form of an error code. */
export function outputError(code: ErrorCode, detail: string | null = null): OutputError {
  return { code, message: ERROR_CODES[code].message, detail };
}
