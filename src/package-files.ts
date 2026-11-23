import { readFileSync } from 'node:fs';

/** URL of a file at the package root. This module sits one level below it in both src/ and dist/. */
export function packageFileUrl(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
}

/** Reads the package version from package.json at run time. */
export function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageFileUrl('package.json'), 'utf8')) as { version: string };
  return packageJson.version;
}
