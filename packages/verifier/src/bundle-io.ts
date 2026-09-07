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
import { join, resolve, sep } from 'node:path';

import { canonicalJson, parseCanonicalJson } from '@ald/hashing';

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

/** Rejected reason for a bundle-relative name that may not be opened. */
export type PathFailureReason = 'not-a-single-segment' | 'outside-bundle';

export type ContainedPath =
  | { ok: true; path: string }
  | { ok: false; reason: PathFailureReason; detail: string };

/**
 * Resolves one bundle-relative file name inside `bundleDir`.
 *
 * Bundle format §1 fixes the layout and §7 describes `streams[]` as carrying
 * "its file name" — a single segment, never a path — but the manifest is
 * untrusted bundle content, and `path.join` happily resolves `../` segments.
 * The verifier is specified as a read-only consumer of the bundle directory
 * (SPECIFICATION.md §12.2), so a name that is not a single segment, or that
 * resolves outside the bundle root, is refused before any read.
 */
export function containedBundlePath(
  bundleDir: string,
  ...parts: readonly string[]
): ContainedPath {
  for (const part of parts) {
    if (
      part.length === 0 ||
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0')
    ) {
      return {
        ok: false,
        reason: 'not-a-single-segment',
        detail: `${part} is not a single bundle path segment`,
      };
    }
  }
  const root = resolve(bundleDir);
  const full = resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + sep)) {
    return {
      ok: false,
      reason: 'outside-bundle',
      detail: `${parts.join('/')} resolves outside the bundle directory`,
    };
  }
  return { ok: true, path: full };
}

const MAX_UNKNOWN_FIELDS_REPORTED = 3;

/**
 * Names the top-level keys a zod object schema silently dropped.
 *
 * Every hash in a bundle is defined over the artifact's *own* canonical bytes
 * (bundle format §6 for `checkpointHash`, §7 for `configurationHash`), so a
 * schema projection is never a legitimate hash preimage and an artifact
 * carrying keys the schema does not know is not the artifact that was
 * committed. Returns `undefined` when the parsed value canonicalizes exactly
 * like the raw one.
 */
export function unknownFieldDetail(
  raw: unknown,
  parsed: unknown,
): string | undefined {
  let rawCanonical: string;
  let parsedCanonical: string;
  try {
    rawCanonical = canonicalJson(raw);
    parsedCanonical = canonicalJson(parsed);
  } catch {
    return 'the file value could not be canonicalized for comparison';
  }
  if (rawCanonical === parsedCanonical) {
    return undefined;
  }
  const rawKeys =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.keys(raw)
      : [];
  const parsedKeys =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? new Set(Object.keys(parsed))
      : new Set<string>();
  const extra = rawKeys.filter((key) => !parsedKeys.has(key));
  if (extra.length === 0) {
    return 'the file content differs from its schema-validated form';
  }
  const listed = extra.slice(0, MAX_UNKNOWN_FIELDS_REPORTED).join(', ');
  const more =
    extra.length > MAX_UNKNOWN_FIELDS_REPORTED
      ? ` (+${String(extra.length - MAX_UNKNOWN_FIELDS_REPORTED)} more)`
      : '';
  return `unknown field(s) ${listed}${more} are not committed by any hash`;
}
