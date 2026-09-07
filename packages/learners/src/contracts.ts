/**
 * Versioned learner-contract files (SPEC §6.4, ALD-043).
 *
 * Each track has a contract at `contracts/learner-contract.<track>.v<n>.md`.
 * A referenced contract is immutable: a change requires a new version number,
 * and the hash of the bundle of contracts a run used is recorded as
 * `RunConfig.promptBundleHash` (LEDGER §8) with the version recorded as
 * `ExperimentRecord.learnerContractVersion` (SPEC §11.9).
 *
 * Contracts are resolved relative to this module's own URL, never
 * `process.cwd()`, so a run loads the contract that shipped with the protocol
 * commit named in `RunConfig.protocolGitCommit` regardless of the working
 * directory of the process hosting the Baby.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HASH_DOMAINS,
  type LearnerContract,
  type LearnerTrackId,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';

import { lintLearnerContractText } from './contract-lint.js';
import { LearnerConfigurationError, LearnerContractLintError } from './errors.js';

/** A loaded contract, tagged with the track it governs. */
export interface TrackLearnerContract extends LearnerContract {
  track: LearnerTrackId;
}

const HEADER_PATTERN =
  /^<!--\s*contract:\s*(?<track>[a-z-]+)\s+version:\s*(?<version>\d+)\s*-->$/u;

/** Directory holding the contract files (repository `contracts/`). */
export function learnerContractsDirectory(): string {
  return fileURLToPath(new URL('../../../contracts/', import.meta.url));
}

export function learnerContractPath(
  track: LearnerTrackId,
  version = 1,
): string {
  return `${learnerContractsDirectory()}learner-contract.${track}.v${version}.md`;
}

/**
 * Load and validate one track's contract. The returned `text` is the contract
 * body: the file with its `<!-- contract: ... -->` header line removed, CRLF
 * normalized to LF, and surrounding blank lines trimmed. Loading fails if the
 * header disagrees with the requested track or version, or if the body
 * violates any SPEC §6.4 lint rule — so a contract that would fail CI cannot
 * be referenced by a run.
 */
export function loadLearnerContract(
  track: LearnerTrackId,
  version = 1,
): TrackLearnerContract {
  const path = learnerContractPath(track, version);
  const raw = readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
  const newline = raw.indexOf('\n');
  const headerLine = (newline < 0 ? raw : raw.slice(0, newline)).trim();
  const header = HEADER_PATTERN.exec(headerLine);

  if (header?.groups === undefined) {
    throw new LearnerConfigurationError(
      `${path} must start with a "<!-- contract: <track> version: <n> -->" header`,
    );
  }
  if (header.groups.track !== track) {
    throw new LearnerConfigurationError(
      `${path} declares track ${String(header.groups.track)}, expected ${track}`,
    );
  }
  if (Number(header.groups.version) !== version) {
    throw new LearnerConfigurationError(
      `${path} declares version ${String(header.groups.version)}, expected ${version}`,
    );
  }

  const text = (newline < 0 ? '' : raw.slice(newline + 1)).trim();
  if (text.length === 0) {
    throw new LearnerConfigurationError(`${path} has an empty contract body`);
  }

  const violations = lintLearnerContractText(text);
  if (violations.length > 0) {
    throw new LearnerContractLintError(path, violations);
  }

  return { track, version: String(version), text };
}

/**
 * `RunConfig.promptBundleHash`: a domain-separated hash over the canonical
 * JSON of `{ <track>: <contract body> }`. RFC 8785 sorts the object keys, so
 * the hash does not depend on the order the contracts were loaded, and adding
 * a track to a run changes the hash.
 */
export function promptBundleHash(
  contracts: readonly TrackLearnerContract[],
): string {
  if (contracts.length === 0) {
    throw new LearnerConfigurationError(
      'promptBundleHash requires at least one contract',
    );
  }
  const bundle: Record<string, string> = {};
  for (const contract of contracts) {
    const existing = bundle[contract.track];
    if (existing !== undefined && existing !== contract.text) {
      throw new LearnerConfigurationError(
        `Two different contracts were supplied for track ${contract.track}`,
      );
    }
    bundle[contract.track] = contract.text;
  }
  return hashCanonical(HASH_DOMAINS.promptBundle, bundle);
}
