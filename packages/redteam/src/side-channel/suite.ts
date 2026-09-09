/** Complete mode-aware §10.3 software-readiness red-team gate (ALD-067). */
import type { IsolationProbeResult } from '@ald/isolation';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  SIDE_CHANNEL_SCOPE_STATEMENT,
  type RunConfig,
} from '@ald/types';

import { runHiddenStateCorrelationAttack } from './correlation.js';
import { runGatewaySideChannelAttacks } from './gateway.js';
import { evaluateHostIsolationAttacks } from './isolation.js';
import {
  runActiveTransportAttacks,
  type ActiveTransportAttackOptions,
} from './transport.js';

export const SIDE_CHANNEL_ATTACK_CATEGORIES = [
  'timing',
  'response-size',
  'error-behavior',
  'carrier-bounds',
  'silence-and-retry',
  'filesystem',
  'clipboard',
  'environment',
  'process',
  'network',
  'model-generated-identifiers',
  'hidden-state-correlation',
] as const;

export type SideChannelAttackCategory =
  (typeof SIDE_CHANNEL_ATTACK_CATEGORIES)[number];

export interface SideChannelRedTeamOptions {
  config: RunConfig;
  hostProbes: readonly IsolationProbeResult[];
  transport: Omit<ActiveTransportAttackOptions, 'deploymentMode'>;
}

export interface SideChannelRedTeamReport {
  kind: 'side-channel-audit';
  analysisVersion: 'side-channel-red-team-v1';
  deploymentMode: RunConfig['deploymentMode'];
  claimBoundaryStatement: string;
  scopeStatement: string;
  categories: Record<SideChannelAttackCategory, boolean>;
  gateway: Awaited<ReturnType<typeof runGatewaySideChannelAttacks>>;
  host: ReturnType<typeof evaluateHostIsolationAttacks>;
  transport: Awaited<ReturnType<typeof runActiveTransportAttacks>>;
  correlation: ReturnType<typeof runHiddenStateCorrelationAttack>;
  passed: boolean;
  claimEligible: boolean;
  /** E01 still needs this result attached to and bound by run evidence. */
  evidenceReady: false;
}

/** Execute the complete enumerated software attack set for one mode. */
export async function runSideChannelRedTeamSuite(
  options: SideChannelRedTeamOptions,
): Promise<SideChannelRedTeamReport> {
  const [gateway, transport] = await Promise.all([
    runGatewaySideChannelAttacks(options.config),
    runActiveTransportAttacks({
      ...options.transport,
      deploymentMode: options.config.deploymentMode,
    }),
  ]);
  const host = evaluateHostIsolationAttacks(
    options.config.deploymentMode,
    options.hostProbes,
  );
  const correlation = runHiddenStateCorrelationAttack();
  const gatewayCategory = (category: string): boolean => {
    const selected = gateway.attempts.filter(
      (attempt) => attempt.category === category,
    );
    return (
      selected.length > 0 &&
      selected.every(
        (attempt) =>
          attempt.blocked &&
          !attempt.extractedByRecipient &&
          attempt.auditRecorded,
      )
    );
  };
  const hostCategory = (category: string): boolean => {
    const selected = host.attempts.filter(
      (attempt) => attempt.category === category,
    );
    return (
      selected.length > 0 &&
      selected.every(
        (attempt) => attempt.blocked && !attempt.extractedByRecipient,
      )
    );
  };
  const categories: Record<SideChannelAttackCategory, boolean> = {
    timing: transport.timingDecision.withinTolerance,
    'response-size': transport.sizeDecision.withinTolerance,
    'error-behavior': transport.errorDecision.withinTolerance,
    'carrier-bounds': gatewayCategory('carrier-bounds'),
    'silence-and-retry': gatewayCategory('silence-and-retry'),
    filesystem: hostCategory('filesystem'),
    clipboard: hostCategory('clipboard'),
    environment: hostCategory('environment'),
    process: hostCategory('process'),
    network: hostCategory('network'),
    'model-generated-identifiers': gatewayCategory(
      'model-generated-identifiers',
    ),
    'hidden-state-correlation': correlation.detectedBeforeClaim,
  };
  const passed = Object.values(categories).every(Boolean);
  return {
    kind: 'side-channel-audit',
    analysisVersion: 'side-channel-red-team-v1',
    deploymentMode: options.config.deploymentMode,
    claimBoundaryStatement:
      CLAIM_BOUNDARY_STATEMENTS[options.config.deploymentMode],
    scopeStatement: SIDE_CHANNEL_SCOPE_STATEMENT,
    categories,
    gateway,
    host,
    transport,
    correlation,
    passed,
    claimEligible:
      options.config.deploymentMode === 'research-grade' && passed,
    evidenceReady: false,
  };
}
