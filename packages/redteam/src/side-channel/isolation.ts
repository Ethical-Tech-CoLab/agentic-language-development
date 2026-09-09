/** Active host-capability probe evaluation for SPEC §10.3 / E01. */
import type { IsolationProbeResult } from '@ald/isolation';
import type { RunConfig } from '@ald/types';

export type HostAttackCategory =
  | 'filesystem'
  | 'clipboard'
  | 'process'
  | 'network'
  | 'environment';

export interface HostAttackResult {
  id: string;
  category: HostAttackCategory;
  blocked: boolean;
  extractedByRecipient: boolean;
}

export interface HostIsolationAttackReport {
  version: 1;
  deploymentMode: RunConfig['deploymentMode'];
  attempts: HostAttackResult[];
  passed: boolean;
}

/**
 * Convert outcome-only responses from probes executed inside both learner
 * hosts into an automated extraction decision. Probe values and error text
 * never cross this API; an `allowed` capability is a hard failure.
 */
export function evaluateHostIsolationAttacks(
  deploymentMode: RunConfig['deploymentMode'],
  probes: readonly IsolationProbeResult[],
): HostIsolationAttackReport {
  if (probes.length !== 2) {
    throw new Error('host isolation attacks require exactly two learner probes');
  }
  const all = (read: (probe: IsolationProbeResult) => boolean): boolean =>
    probes.every(read);
  const attempts: HostAttackResult[] = [
    {
      id: 'filesystem-read',
      category: 'filesystem',
      blocked: all((probe) => probe.fsRead === 'denied'),
      extractedByRecipient: probes.some((probe) => probe.fsRead === 'allowed'),
    },
    {
      id: 'clipboard-read',
      category: 'clipboard',
      blocked: all((probe) => probe.clipboard === 'denied'),
      extractedByRecipient: probes.some((probe) => probe.clipboard === 'allowed'),
    },
    {
      id: 'process-and-worker-spawn',
      category: 'process',
      blocked: all(
        (probe) =>
          probe.childProcess === 'denied' && probe.worker === 'denied',
      ),
      extractedByRecipient: probes.some(
        (probe) =>
          probe.childProcess === 'allowed' || probe.worker === 'allowed',
      ),
    },
    {
      id: 'direct-peer-socket',
      category: 'network',
      blocked: all(
        (probe) => probe.network === 'denied' || probe.network === 'refused',
      ),
      extractedByRecipient: probes.some((probe) => probe.network === 'allowed'),
    },
    {
      id: 'environment-discovery',
      category: 'environment',
      blocked: all((probe) => probe.envKeys.length === 0),
      extractedByRecipient: probes.some((probe) => probe.envKeys.length > 0),
    },
  ];
  return {
    version: 1,
    deploymentMode,
    attempts,
    passed: attempts.every(
      (attempt) => attempt.blocked && !attempt.extractedByRecipient,
    ),
  };
}
