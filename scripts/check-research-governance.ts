#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = 'protocols/research-governance-and-funding.v1.json';
const policy = JSON.parse(readFileSync(path, 'utf8')) as {
  schemaVersion: number;
  decisionId: string;
  decidedAt: string;
  status: string;
  authority: { role: string; approvalTextNormalized: string; evidenceSha256: string; institutionalApprovalClaimed: boolean };
  dataScope: {
    syntheticOnly: boolean;
    humanParticipants: boolean;
    personalDataPermitted: boolean;
    productionSecretsPermitted: boolean;
    humanCoding: string;
    amendmentTrigger: string;
  };
  responsibleRoles: Record<string, string>;
  fundingPolicy: {
    profile: string;
    externalSpendAuthorized: number;
    realCurrencyAuthorized: boolean;
    publicChainTransactionsAuthorized: boolean;
    simulatedBalance: string;
    simulatedBalanceUnit: string;
    transport: string;
    rule: string;
  };
  registrationPolicy: {
    profile: string;
    externalRegistrationRequired: boolean;
    requirements: string[];
    claimBoundary: string;
  };
  externalDependencyPolicy: {
    upstreamProtectionRequiredForExecution: boolean;
    independentHumanRestoreRequiredForExecution: boolean;
    externalRegistrationRequiredForExecution: boolean;
    optionalEnhancements: string[];
    rule: string;
  };
  retentionPolicy: Record<string, string>;
  claimBoundary: string;
};

const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const approvalDigest = createHash('sha256').update(policy.authority.approvalTextNormalized).digest('hex');
const digest = createHash('sha256').update(readFileSync(path)).digest('hex');

if (
  policy.schemaVersion !== 1 ||
  policy.decisionId !== 'ALD-GOV-2026-09-12-01' ||
  policy.decidedAt !== '2026-09-12' ||
  policy.status !== 'approved' ||
  policy.authority.role !== 'project-operator' ||
  !isSha256(policy.authority.evidenceSha256) ||
  approvalDigest !== policy.authority.evidenceSha256 ||
  policy.authority.institutionalApprovalClaimed
) {
  throw new Error('governance decision identity or authority boundary is invalid');
}
if (
  !policy.dataScope.syntheticOnly ||
  policy.dataScope.humanParticipants ||
  policy.dataScope.personalDataPermitted ||
  policy.dataScope.productionSecretsPermitted ||
  policy.dataScope.humanCoding !== 'not-used' ||
  policy.dataScope.amendmentTrigger.length < 60
) {
  throw new Error('governance data boundary must remain synthetic-only and fail closed');
}
if (
  policy.fundingPolicy.profile !== 'simulation-only' ||
  policy.fundingPolicy.externalSpendAuthorized !== 0 ||
  policy.fundingPolicy.realCurrencyAuthorized ||
  policy.fundingPolicy.publicChainTransactionsAuthorized ||
  !/^\d+$/u.test(policy.fundingPolicy.simulatedBalance) ||
  policy.fundingPolicy.simulatedBalanceUnit !== 'non-monetary test units' ||
  policy.fundingPolicy.transport !== 'deterministic in-memory chain' ||
  policy.fundingPolicy.rule.length < 60
) {
  throw new Error('research funding profile is not unambiguously simulation-only');
}
if (
  policy.registrationPolicy.profile !== 'repository-native' ||
  policy.registrationPolicy.externalRegistrationRequired ||
  policy.registrationPolicy.requirements.length < 6 ||
  policy.registrationPolicy.requirements.some((requirement) => requirement.length < 30) ||
  policy.registrationPolicy.claimBoundary.length < 180
) {
  throw new Error('repository-native registration policy is incomplete or overclaims independence');
}
if (
  policy.externalDependencyPolicy.upstreamProtectionRequiredForExecution ||
  policy.externalDependencyPolicy.independentHumanRestoreRequiredForExecution ||
  policy.externalDependencyPolicy.externalRegistrationRequiredForExecution ||
  policy.externalDependencyPolicy.optionalEnhancements.length < 4 ||
  policy.externalDependencyPolicy.rule.length < 150
) {
  throw new Error('external-dependency applicability policy is incomplete');
}
for (const role of ['projectOperator', 'researchOperator', 'integrityVerifier', 'dataSteward', 'independentReviewer']) {
  if ((policy.responsibleRoles[role]?.length ?? 0) < 20) throw new Error(`role ${role} is not assigned`);
}
for (const field of ['eligibleResearchEvidence', 'developmentPayloads', 'accidentalSensitiveMaterial', 'deletionAuthority']) {
  if ((policy.retentionPolicy[field]?.length ?? 0) < 10) throw new Error(`retention field ${field} is incomplete`);
}
if (policy.claimBoundary.length < 120) throw new Error('governance claim boundary is incomplete');

console.log(`research governance valid: ${policy.decisionId}, profile=${policy.fundingPolicy.profile}, sha256=${digest}`);
