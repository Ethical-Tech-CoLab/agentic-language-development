/**
 * `prompts/` verification: the learner-contract texts the run referenced.
 *
 * SPECIFICATION.md §6.4 makes the contract text claim-bearing and immutable
 * once a sealed run references it, LEDGER-INTEGRITY-DESIGN.md §13 has the
 * final checkpoint commit the prompt bundle, and docs/evidence-bundle-format.md
 * §1 ships the exact texts as `prompts/learner-contract.<track>.v<n>.md`. The
 * committed value is therefore recomputable from the bundle alone:
 *
 * `promptBundleHash = sha256(promptBundle || 0x00 || utf8(canonical({ <track>: <text> })))`
 *
 * which is exactly `promptBundleHash()` in packages/learners/src/contracts.ts
 * over the contracts `exportRunBundle` wrote (packages/evidence/src/export.ts
 * writes `contract.text` verbatim, one file per distinct track of
 * `RunConfig.babyA.track` / `babyB.track`, with the version taken from
 * `RunManifest.learnerContractVersions`). The rule is reimplemented here
 * rather than imported so the verifier keeps depending on `@ald/types`,
 * `@ald/hashing`, and `@ald/merkle` only (SPEC §4.2).
 */
import { hashCanonical } from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  type RunConfig,
  type RunManifest,
} from '@ald/types';

import { containedBundlePath, readTextFile } from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedCheckpoint } from './checkpoints.js';
import { normalizeHash } from './values.js';

export interface PromptBundleVerification {
  /** Hash rebuilt from `prompts/`, or `undefined` when it could not be. */
  rebuiltHash: string | undefined;
  /** One entry per distinct track, in `prompts/` file-name order. */
  files: string[];
}

/** `{ <track>: <contract text> }` under the prompt-bundle domain. */
export function rebuildPromptBundleHash(
  texts: ReadonlyMap<string, string>,
): string {
  return hashCanonical(
    HASH_DOMAINS.promptBundle,
    Object.fromEntries([...texts.entries()]),
  );
}

function contractFileName(track: string, version: string): string {
  return `learner-contract.${track}.v${version}.md`;
}

/**
 * Rebuilds the prompt bundle from `prompts/` and binds it to the run
 * configuration, the run manifest, and every checkpoint.
 */
export async function verifyPromptBundle(
  bundleDir: string,
  manifest: RunManifest,
  config: RunConfig,
  checkpoints: readonly LoadedCheckpoint[],
  accumulator: VerificationAccumulator,
): Promise<PromptBundleVerification> {
  const tracks: [string, string][] = [
    [config.babyA.track, manifest.learnerContractVersions.babyA],
    [config.babyB.track, manifest.learnerContractVersions.babyB],
  ];
  const texts = new Map<string, string>();
  const files: string[] = [];
  const attempted = new Set<string>();
  let readable = true;

  for (const [track, version] of tracks) {
    const name = contractFileName(track, version);
    if (attempted.has(track)) {
      if (!attempted.has(name)) {
        // Both Babies share the track but the manifest names two versions, so
        // the single exported file cannot satisfy both (bundle format §1).
        accumulator.failStructural(
          'prompt-contract-version-conflict',
          `run-manifest.json names two learnerContractVersions for track ${track}`,
        );
        readable = false;
      }
      continue;
    }
    attempted.add(track);
    attempted.add(name);
    const contained = containedBundlePath(bundleDir, 'prompts', name);
    if (!contained.ok) {
      accumulator.failStructural(
        'prompt-file-outside-bundle',
        `prompts/${name}: ${contained.detail}`,
      );
      readable = false;
      continue;
    }
    const text = await readTextFile(contained.path);
    if (!text.ok) {
      accumulator.failStructural(
        'prompt-contract-unreadable',
        `prompts/${name}: ${text.detail}`,
      );
      readable = false;
      continue;
    }
    texts.set(track, text.value);
    files.push(name);
  }

  if (!readable || texts.size === 0) {
    return { rebuiltHash: undefined, files };
  }

  const rebuiltHash = rebuildPromptBundleHash(texts);
  const declared = normalizeHash(config.promptBundleHash);

  if (declared === GENESIS_HASH) {
    // `buildRunConfig` leaves the placeholder and the runtime binds the real
    // value at run creation (nursery-runtime `#bindHash`), so a placeholder in
    // a shipped bundle means nothing committed the texts. Reported, not
    // silently accepted.
    accumulator.gap(
      'prompt-bundle-hash-placeholder',
      `configuration/run-config.json carries the genesis placeholder instead of a promptBundleHash; prompts/ rebuilds to ${rebuiltHash}`,
    );
    return { rebuiltHash, files };
  }

  if (declared !== rebuiltHash) {
    accumulator.failStructural(
      'prompt-bundle-hash-mismatch',
      `prompts/ rebuilds to ${rebuiltHash}, configuration/run-config.json declares ${config.promptBundleHash}`,
    );
  }
  if (normalizeHash(manifest.promptBundleHash) !== rebuiltHash) {
    accumulator.failStructural(
      'prompt-bundle-hash-mismatch',
      `prompts/ rebuilds to ${rebuiltHash}, run-manifest.json declares ${manifest.promptBundleHash}`,
    );
  }
  for (const checkpoint of checkpoints) {
    if (normalizeHash(checkpoint.manifest.promptBundleHash) !== rebuiltHash) {
      accumulator.failStructural(
        'prompt-bundle-hash-mismatch',
        `prompts/ rebuilds to ${rebuiltHash}, ${checkpoint.file} declares ${checkpoint.manifest.promptBundleHash}`,
      );
    }
  }

  return { rebuiltHash, files };
}
