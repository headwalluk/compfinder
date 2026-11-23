import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_PATH = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

export interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Makes an empty home directory for one test, so the real ~/.config is never read. */
export function makeTemporaryHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'compfinder-test-'));
}

/** Runs the CLI from source in a child process with only the given environment. */
export function runCli(cliArguments: string[], environment: Record<string, string>): CliRun {
  const child = spawnSync(process.execPath, ['--import', 'tsx', MAIN_PATH, ...cliArguments], {
    env: environment,
    encoding: 'utf8',
  });
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
}
