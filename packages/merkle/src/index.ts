/**
 * @ald/merkle — ALD-012 ordered Merkle trees, inclusion proofs, and prefix
 * consistency proofs for every event stream in the Evidence Store
 * (LEDGER-INTEGRITY-DESIGN.md §7, docs/evidence-bundle-format.md §5,
 * RFC 6962 §2.1).
 *
 * The pure functions are the contract; {@link MerkleTree} is a memoizing
 * convenience over them.
 */
export {
  EMPTY_MERKLE_ROOT,
  merkleLeafHash,
  merkleLeafHashes,
  merkleNodeHash,
  type MerkleLeafSource,
} from './hashes.js';
export {
  MerkleTree,
  consistencyProof,
  createRangeRootCache,
  inclusionProof,
  merkleRoot,
  type RangeRootCache,
} from './tree.js';
export {
  verifyConsistency,
  verifyInclusion,
  type ConsistencyVerificationInput,
  type InclusionVerificationInput,
} from './verify.js';
export {
  buildConsistencyProofRecord,
  buildInclusionProofRecord,
  type ConsistencyProofRecordInput,
  type InclusionProofRecordInput,
} from './records.js';
