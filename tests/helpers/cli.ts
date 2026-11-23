import { spawn, spawnSync } from 'node:child_process';
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

/** Runs the CLI without blocking the event loop, for tests whose own server must answer it. */
export function runCliAsync(cliArguments: string[], environment: Record<string, string>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', MAIN_PATH, ...cliArguments], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
