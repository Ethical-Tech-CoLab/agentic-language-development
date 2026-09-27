/**
 * Order-permutation carryover check (R04 item 4). The collector executes the
 * same branches in two different orders; identical digests prove no shared
 * infrastructure carried state across branches. Any divergence quarantines
 * the case.
 */
import type { Lv01Branch } from './ledger-value.js';

export interface Lv01BranchDigest {
  readonly branch: Lv01Branch;
  readonly scenarioHash: string;
  readonly drawCommitment: string;
  readonly predictionCommitmentV2: string;
  readonly selectedCandidateRef: string;
}

export function checkLv01BranchOrderStability(
  firstOrder: readonly Lv01BranchDigest[],
  secondOrder: readonly Lv01BranchDigest[],
): void {
  const firstBranches = [...firstOrder.map((entry) => entry.branch)].sort();
  const secondBranches = [...secondOrder.map((entry) => entry.branch)].sort();
  if (JSON.stringify(firstBranches) !== JSON.stringify(secondBranches)) {
    throw new Error('LV01 order quarantine: branch sets differ between execution orders');
  }
  const fields: (keyof Omit<Lv01BranchDigest, 'branch'>)[] = [
    'scenarioHash',
    'drawCommitment',
    'predictionCommitmentV2',
    'selectedCandidateRef',
  ];
  const divergences: string[] = [];
  for (const branch of firstBranches) {
    const first = firstOrder.find((entry) => entry.branch === branch) as Lv01BranchDigest;
    const second = secondOrder.find((entry) => entry.branch === branch) as Lv01BranchDigest;
    const differing = fields.filter((field) => first[field] !== second[field]);
    if (differing.length > 0) divergences.push(`${branch} diverges in ${differing.join(', ')}`);
  }
  if (divergences.length > 0) {
    throw new Error(`LV01 order quarantine: ${divergences.join('; ')}`);
  }
}
