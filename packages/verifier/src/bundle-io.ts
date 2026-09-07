/**
 * Filesystem access for an exported evidence bundle
 * (docs/evidence-bundle-format.md §1).
 *
 * The verifier reads a directory of files and nothing else: no SQLite, no
 * runtime state, no private keys (LEDGER-INTEGRITY-DESIGN.md §14,
 * SPECIFICATION.md §4.2). Every read returns a result object instead of
 * throwing, so one missing or corrupt artifact never aborts the report.
 *
 * Every `*.json` file in a bundle is RFC 8785 canonical JSON followed by a
 * single `\n` (bundle format §1), so the trailing newline is stripped before
 * the canonicality check.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCanonicalJson } from '@ald/hashing';

export type FileFailureCode =
  | 'missing-file'
  | 'unreadable-file'
  | 'canonical-json-invalid';

export type FileResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FileFailureCode; detail: string };

/** Issue shape shared by every zod schema in `@ald/types`. */
export interface SchemaIssue {
  path: readonly PropertyKey[];
  message: string;
}

export interface SchemaLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly SchemaIssue[] } };
}

const MAX_REPORTED_ISSUES = 3;

/** Compact one-line rendering of the first few zod issues. */
export function formatIssues(issues: readonly SchemaIssue[]): string {
  const rendered = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.');
    return `${path.length === 0 ? '(root)' : path}: ${issue.message}`;
  });
  if (issues.length > MAX_REPORTED_ISSUES) {
    rendered.push(`(+${String(issues.length - MAX_REPORTED_ISSUES)} more)`);
  }
  return rendered.join('; ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readTextFile(path: string): Promise<FileResult<string>> {
  try {
    return { ok: true, value: await readFile(path, 'utf8') };
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'ENOENT'
        ? 'missing-file'
        : 'unreadable-file';
    return { ok: false, code, detail: describe(error) };
  }
}

/** Removes the single documented trailing newline of a bundle JSON file. */
export function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Reads one `*.json` bundle artifact and requires RFC 8785 canonical form. */
export async function readCanonicalJsonFile(
  path: string,
): Promise<FileResult<unknown>> {
  const text = await readTextFile(path);
  if (!text.ok) {
    return text;
  }
  try {
    return {
      ok: true,
      value: parseCanonicalJson<unknown>(stripTrailingNewline(text.value)),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'canonical-json-invalid',
      detail: describe(error),
    };
  }
}

/** Sorted `*.json` file names in `directory`; empty when it does not exist. */
export async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory);
    return entries.filter((entry) => entry.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function bundlePath(bundleDir: string, ...parts: string[]): string {
  return join(bundleDir, ...parts);
}
