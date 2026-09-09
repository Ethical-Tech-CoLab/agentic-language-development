/**
 * `ald-verify` — the standalone verifier CLI (BACKLOG ALD-015).
 *
 * The CLI runs against an exported bundle directory with no shared state with
 * the server and no network access unless `--rpc-url` is given, prints either
 * a compact human summary or the machine-readable report, and exits with
 * `VerificationReport.exitCode` (LEDGER-INTEGRITY-DESIGN.md §14 item 12).
 *
 * Writing is injected so the library itself never touches `console`.
 */
import { canonicalJson } from '@ald/hashing';
import type { VerificationReport } from '@ald/types';

import { CHECK_NAMES } from './checks.js';
import { describeRedacted, safeEndpoint } from './redact.js';
import { createJsonRpcChainReader } from './rpc.js';
import {
  VERIFIER_VERSION,
  verifyBundleDetailed,
  type VerificationDetails,
} from './verify-bundle.js';

export const USAGE = `Usage: ald-verify <bundle-dir> [options]

Options:
  --rpc-url <url>            verify the anchor transaction against this JSON-RPC endpoint
  --chain-id <n>             expected chain id (skips eth_chainId)
  --parent-bundle <dir>      immutable parent export for derived-run lineage
  --allow-unanchored         report an unanchored tail without failing
  --json                     print the verification report as canonical JSON
  --verifier-version <v>     value recorded in the report (default ${VERIFIER_VERSION})
  --no-report                do not write verification-report.json into the bundle
  -h, --help                 print this message`;

export interface CliOptions {
  bundleDir: string;
  rpcUrl?: string;
  chainId?: number;
  parentBundleDir?: string;
  allowUnanchored: boolean;
  json: boolean;
  verifierVersion: string;
  writeReport: boolean;
}

export type CliParseResult =
  | { ok: true; options: CliOptions }
  | { ok: true; help: true }
  | { ok: false; message: string };

/**
 * An empty value is rejected here rather than deep inside `buildReport`,
 * where `VerificationReportSchema.verifierVersion` (a non-empty string) would
 * otherwise throw a `ZodError` out of `runCli` and produce no report at all.
 */
function requireValue(
  flag: string,
  value: string | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    return { ok: false, message: `${flag} requires a value` };
  }
  return { ok: true, value };
}

export function parseArgs(argv: readonly string[]): CliParseResult {
  let bundleDir: string | undefined;
  let rpcUrl: string | undefined;
  let chainId: number | undefined;
  let parentBundleDir: string | undefined;
  let allowUnanchored = false;
  let json = false;
  let writeReport = true;
  let verifierVersion = VERIFIER_VERSION;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    switch (argument) {
      case '-h':
      case '--help':
        return { ok: true, help: true };
      case '--allow-unanchored':
        allowUnanchored = true;
        break;
      case '--json':
        json = true;
        break;
      case '--no-report':
        writeReport = false;
        break;
      case '--rpc-url': {
        const value = requireValue(argument, argv[index + 1]);
        if (!value.ok) {
          return value;
        }
        rpcUrl = value.value;
        index += 1;
        break;
      }
      case '--chain-id': {
        const value = requireValue(argument, argv[index + 1]);
        if (!value.ok) {
          return value;
        }
        const parsed = Number.parseInt(value.value, 10);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return { ok: false, message: `--chain-id must be a positive integer` };
        }
        chainId = parsed;
        index += 1;
        break;
      }
      case '--parent-bundle': {
        const value = requireValue(argument, argv[index + 1]);
        if (!value.ok) {
          return value;
        }
        parentBundleDir = value.value;
        index += 1;
        break;
      }
      case '--verifier-version': {
        const value = requireValue(argument, argv[index + 1]);
        if (!value.ok) {
          return value;
        }
        verifierVersion = value.value;
        index += 1;
        break;
      }
      default:
        if (argument.startsWith('-')) {
          return { ok: false, message: `unknown option ${argument}` };
        }
        if (bundleDir !== undefined) {
          return { ok: false, message: `unexpected argument ${argument}` };
        }
        bundleDir = argument;
    }
  }

  if (bundleDir === undefined) {
    return { ok: false, message: 'a bundle directory is required' };
  }

  return {
    ok: true,
    options: {
      bundleDir,
      ...(rpcUrl === undefined ? {} : { rpcUrl }),
      ...(chainId === undefined ? {} : { chainId }),
      ...(parentBundleDir === undefined ? {} : { parentBundleDir }),
      allowUnanchored,
      json,
      verifierVersion,
      writeReport,
    },
  };
}

/** One line per SPEC §11.10 check, then the counts a reviewer scans first. */
export function formatSummary(
  bundleDir: string,
  report: VerificationReport,
  details: VerificationDetails,
): string {
  const lines: string[] = [
    `bundle    ${bundleDir}`,
    `run       ${report.runId}`,
    `verifier  ${report.verifierVersion} at ${report.checkedAt}`,
    '',
  ];

  for (const name of CHECK_NAMES) {
    const value = report.checks[name];
    const label =
      name === 'unanchoredTailReported'
        ? value
          ? 'TAIL'
          : 'none'
        : value
          ? 'PASS'
          : 'FAIL';
    lines.push(`${label} ${name}`);
  }

  lines.push('');
  lines.push(
    `sizes     ${Object.entries(report.finalVerifiedSizes)
      .map(([key, size]) => `${key}=${String(size)}`)
      .join(' ')}`,
  );
  lines.push(
    `counts    checkpoints=${String(details.checkpointCount)} proofs=${String(details.proofFilesChecked)} anchored-through=${details.anchoredThroughCheckpoint === null ? 'none' : String(details.anchoredThroughCheckpoint)} chain-checked=${String(details.chainChecked)}`,
  );

  lines.push(`gaps      ${String(report.gaps.length)}`);
  for (const gap of report.gaps) {
    lines.push(`  - ${gap}`);
  }
  lines.push(`forks     ${String(report.forks.length)}`);
  for (const fork of report.forks) {
    lines.push(`  - ${fork}`);
  }
  lines.push(`exit      ${String(report.exitCode)}`);
  return `${lines.join('\n')}\n`;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Runs the CLI and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr(`ald-verify: ${parsed.message}\n${USAGE}\n`);
    return 1;
  }
  if ('help' in parsed) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const options = parsed.options;
  let chainReader;
  if (options.rpcUrl !== undefined) {
    try {
      chainReader = await createJsonRpcChainReader(options.rpcUrl, {
        chainId: options.chainId,
      });
    } catch (error) {
      // Origin only: `--rpc-url` is credential-bearing (see ./redact.ts).
      io.stderr(
        `ald-verify: cannot reach ${safeEndpoint(options.rpcUrl)}: ${describeRedacted(error)}\n`,
      );
      return 1;
    }
  }

  let verification;
  try {
    verification = await verifyBundleDetailed(options.bundleDir, {
      verifierVersion: options.verifierVersion,
      now: () => new Date().toISOString(),
      chainReader,
      allowUnanchored: options.allowUnanchored,
      writeReport: options.writeReport,
      parentBundleDir: options.parentBundleDir,
    });
  } catch (error) {
    // `runCli` promises an exit code (LEDGER §14 item 12), so an unexpected
    // error becomes a reported failure rather than an unhandled rejection.
    io.stderr(`ald-verify: verification failed: ${describeRedacted(error)}\n`);
    return 1;
  }

  const { report, details } = verification;
  io.stdout(
    options.json
      ? `${canonicalJson(report)}\n`
      : formatSummary(options.bundleDir, report, details),
  );
  return report.exitCode;
}
