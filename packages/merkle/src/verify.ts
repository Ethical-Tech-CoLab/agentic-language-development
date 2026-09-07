/**
 * Proof verification with no access to the tree itself: an inclusion proof is
 * checked from the leaf hash, index, size and root alone (RFC 6962 §2.1.1
 * verification), and a consistency proof from the two sizes and roots alone
 * (RFC 6962 §2.1.2, verification algorithm as specified in RFC 6962-bis
 * §2.1.4.2). Both are the checks a verifier performs on an exported bundle
 * (LEDGER-INTEGRITY-DESIGN.md §14, §17).
 *
 * Neither function throws: a malformed hash, an out-of-range index, a short
 * or over-long path, and a mismatched root all return `false`, so the
 * verifier CLI can report a failure location instead of crashing.
 */
import { isSha256Hash } from '@ald/hashing';

import { EMPTY_MERKLE_ROOT, merkleNodeHash } from './hashes.js';

export interface InclusionVerificationInput {
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  path: readonly string[];
  root: string;
}

export interface ConsistencyVerificationInput {
  fromSize: number;
  toSize: number;
  fromRoot: string;
  toRoot: string;
  path: readonly string[];
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHashList(path: readonly string[]): boolean {
  return path.every((element) => isSha256Hash(element));
}

/** Least-significant bit of `value` (RFC 6962 §2.1.1 `LSB`). */
function lsb(value: number): boolean {
  return (value & 1) === 1;
}

/**
 * RFC 6962 §2.1.1 audit-path verification. `path` must be ordered from the
 * leaf's sibling upwards, exactly as {@link inclusionProof} returns it.
 */
export function verifyInclusion(input: InclusionVerificationInput): boolean {
  const { leafHash, leafIndex, treeSize, path, root } = input;
  if (!isIndex(leafIndex) || !isIndex(treeSize) || !Array.isArray(path)) {
    return false;
  }
  if (leafIndex >= treeSize) {
    return false;
  }
  if (!isSha256Hash(leafHash) || !isSha256Hash(root) || !isHashList(path)) {
    return false;
  }
  let fn = leafIndex;
  let sn = treeSize - 1;
  let computed = leafHash;
  try {
    for (const sibling of path) {
      if (sn === 0) {
        // Path is longer than the tree is deep.
        return false;
      }
      if (lsb(fn) || fn === sn) {
        computed = merkleNodeHash(sibling, computed);
        if (!lsb(fn)) {
          do {
            fn >>>= 1;
            sn >>>= 1;
          } while (!lsb(fn) && fn !== 0);
        }
      } else {
        computed = merkleNodeHash(computed, sibling);
      }
      fn >>>= 1;
      sn >>>= 1;
    }
  } catch {
    return false;
  }
  return sn === 0 && computed === root;
}

/**
 * Prefix-consistency verification (RFC 6962 §2.1.2; algorithm per RFC
 * 6962-bis §2.1.4.2). Conventions for the two degenerate cases:
 *
 * - `fromSize === 0`: the empty tree is a prefix of every tree, so the proof
 *   is empty and the result is `true` provided `fromRoot` is the documented
 *   empty root of docs/evidence-bundle-format.md §5.
 * - `fromSize === toSize`: `true` only if both roots are equal and the proof
 *   is empty.
 */
export function verifyConsistency(
  input: ConsistencyVerificationInput,
): boolean {
  const { fromSize, toSize, fromRoot, toRoot, path } = input;
  if (!isIndex(fromSize) || !isIndex(toSize) || !Array.isArray(path)) {
    return false;
  }
  if (fromSize > toSize) {
    return false;
  }
  if (!isSha256Hash(fromRoot) || !isSha256Hash(toRoot) || !isHashList(path)) {
    return false;
  }
  if (fromSize === toSize) {
    return path.length === 0 && fromRoot === toRoot;
  }
  if (fromSize === 0) {
    return path.length === 0 && fromRoot === EMPTY_MERKLE_ROOT;
  }

  // RFC 6962-bis §2.1.4.2 step 1: an exact power of two contributes the old
  // root itself as the first proof element.
  const isPowerOfTwo = (fromSize & (fromSize - 1)) === 0;
  const proof = isPowerOfTwo ? [fromRoot, ...path] : [...path];
  const seed = proof[0];
  if (seed === undefined) {
    return false;
  }

  let fn = fromSize - 1;
  let sn = toSize - 1;
  while (lsb(fn)) {
    fn >>>= 1;
    sn >>>= 1;
  }
  let fr = seed;
  let sr = seed;
  try {
    for (const element of proof.slice(1)) {
      if (sn === 0) {
        return false;
      }
      if (lsb(fn) || fn === sn) {
        fr = merkleNodeHash(element, fr);
        sr = merkleNodeHash(element, sr);
        if (!lsb(fn)) {
          do {
            fn >>>= 1;
            sn >>>= 1;
          } while (!lsb(fn) && fn !== 0);
        }
      } else {
        sr = merkleNodeHash(sr, element);
      }
      fn >>>= 1;
      sn >>>= 1;
    }
  } catch {
    return false;
  }
  return sn === 0 && fr === fromRoot && sr === toRoot;
}
