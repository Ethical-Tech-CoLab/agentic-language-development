#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readinessPath = 'reports/research/external-prerequisite-readiness.json';
const campaignPath = 'protocols/campaign-readiness-review.v1.json';
const upstreamPath = 'reports/research/upstream-enforcement-observation.json';
const governancePath = 'protocols/research-governance-and-funding.v1.json';
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

interface ReceiptReference {
  path: string;
  sha256: string;
}

interface PrerequisiteItem {
  id: string;
  blockingFinding: string;
  status: 'missing' | 'observed-unsatisfied' | 'verified' | 'not-applicable';
  satisfied: boolean;
  receipt: ReceiptReference | null;
  requiredEvidence: string[];
  nextAction: string;
}

interface ReadinessLedger {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  localCandidate: { commit: string; version: string };
  decision: 'blocked' | 'ready';
  satisfiedCount: number;
  requiredCount: number;
  items: PrerequisiteItem[];
  privacyBoundary: string[];
  activationRule: string;
  boundary: string;
}

interface CampaignReview {
  decision: string;
  blockingFindings: Array<{ id: string; owner: string }>;
  resolvedFindings: Array<{ id: string; owner: string }>;
}

interface UpstreamObservation {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  executionBranch: { presentOnOriginRemote: boolean; presentAsPullRequestHead: boolean };
  pullRequest: {
    number: number;
    state: string;
    draft: boolean;
    mergeable: string;
    headCommit: string;
    hostedWorkflow: { headCommit: string; status: string; conclusion: string; jobsStarted: number };
  };
  branchProtectionQuery: { httpStatus: number };
  repositoryRulesetsQuery: { httpStatus: number; rulesetCount: number };
  latestDefaultBranchWorkflow: { status: string; conclusion: string };
  localWorkflow: { path: string; sha256: string; requiredJobIds: string[] };
  decision: string;
}

interface GovernanceDecision {
  schemaVersion: number;
  decisionId: string;
  status: string;
  authority: { role: string; institutionalApprovalClaimed: boolean };
  dataScope: { syntheticOnly: boolean; humanParticipants: boolean; humanCoding: string };
  fundingPolicy: {
    profile: string;
    externalSpendAuthorized: number;
    realCurrencyAuthorized: boolean;
    publicChainTransactionsAuthorized: boolean;
    transport: string;
  };
  registrationPolicy: { profile: string; externalRegistrationRequired: boolean };
  externalDependencyPolicy: {
    upstreamProtectionRequiredForExecution: boolean;
    independentHumanRestoreRequiredForExecution: boolean;
    externalRegistrationRequiredForExecution: boolean;
  };
}

const readinessBytes = readFileSync(readinessPath);
const readiness = JSON.parse(readinessBytes.toString('utf8')) as ReadinessLedger;
const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as CampaignReview;
const upstreamBytes = readFileSync(upstreamPath);
const upstream = JSON.parse(upstreamBytes.toString('utf8')) as UpstreamObservation;
const governance = JSON.parse(readFileSync(governancePath, 'utf8')) as GovernanceDecision;

if (
  readiness.schemaVersion !== 1 ||
  readiness.classification !== 'external-prerequisite-readiness-ledger' ||
  readiness.researchFinding
) {
  throw new Error('unexpected external-prerequisite ledger identity');
}

const expectedIds = ['O01', 'O02', 'O03', 'O04', 'O05', 'O06'];
if (JSON.stringify(readiness.items.map((item) => item.id)) !== JSON.stringify(expectedIds)) {
  throw new Error('external prerequisites must contain O01-O06 exactly once and in order');
}

const campaignFindings = new Map([...campaign.blockingFindings, ...campaign.resolvedFindings].map((finding) => [finding.id, finding]));
for (const item of readiness.items) {
  const finding = campaignFindings.get(item.blockingFinding);
  if (finding === undefined || !finding.owner.split('+').includes(item.id)) {
    throw new Error(`${item.id} does not map to its campaign blocking finding`);
  }
  if (item.requiredEvidence.length < 6 || item.requiredEvidence.some((entry) => entry.length < 12)) {
    throw new Error(`${item.id} lacks an exact evidence checklist`);
  }
  if (item.nextAction.length < 30) throw new Error(`${item.id} lacks an actionable owner transition`);
  if (item.status === 'verified') {
    if (!item.satisfied || item.receipt === null) throw new Error(`${item.id} claims verification without a receipt`);
  } else if (item.satisfied) {
    throw new Error(`${item.id} is satisfied while status is ${item.status}`);
  }
  if (item.status === 'missing' && item.receipt !== null) {
    throw new Error(`${item.id} has a receipt despite missing status`);
  }
  if (item.receipt !== null) {
    const receiptBytes = readFileSync(item.receipt.path);
    if (sha256(receiptBytes) !== item.receipt.sha256) {
      throw new Error(`${item.id} receipt hash does not match ${item.receipt.path}`);
    }
  }
}

const applicable = readiness.items.filter((item) => item.status !== 'not-applicable');
const satisfiedCount = applicable.filter((item) => item.satisfied).length;
if (readiness.requiredCount !== applicable.length || readiness.satisfiedCount !== satisfiedCount) {
  throw new Error('external-prerequisite totals do not reconcile');
}
const expectedDecision = satisfiedCount === applicable.length ? 'ready' : 'blocked';
if (readiness.decision !== expectedDecision) throw new Error('external-prerequisite decision contradicts its items');
if (
  upstream.schemaVersion !== 1 ||
  upstream.classification !== 'external-read-only-enforcement-observation' ||
  upstream.researchFinding ||
  upstream.executionBranch.presentOnOriginRemote ||
  !upstream.executionBranch.presentAsPullRequestHead ||
  upstream.pullRequest.number !== 1 ||
  upstream.pullRequest.state !== 'OPEN' ||
  upstream.pullRequest.draft ||
  upstream.pullRequest.mergeable !== 'MERGEABLE' ||
  upstream.localCandidate.commit !== upstream.pullRequest.headCommit ||
  upstream.localCandidate.version !== '0.1.78' ||
  upstream.pullRequest.headCommit !== upstream.pullRequest.hostedWorkflow.headCommit ||
  upstream.pullRequest.hostedWorkflow.status !== 'completed' ||
  upstream.pullRequest.hostedWorkflow.conclusion !== 'action_required' ||
  upstream.pullRequest.hostedWorkflow.jobsStarted !== 0 ||
  upstream.branchProtectionQuery.httpStatus !== 404 ||
  upstream.repositoryRulesetsQuery.httpStatus !== 200 ||
  upstream.repositoryRulesetsQuery.rulesetCount !== 0 ||
  upstream.latestDefaultBranchWorkflow.status !== 'completed' ||
  upstream.latestDefaultBranchWorkflow.conclusion !== 'failure' ||
  sha256(readFileSync(upstream.localWorkflow.path)) !== upstream.localWorkflow.sha256 ||
  JSON.stringify(upstream.localWorkflow.requiredJobIds) !== JSON.stringify(['consolidated-suite', 'mode-r']) ||
  upstream.decision !== 'not-demonstrated'
) {
  throw new Error('historical upstream observation is stale or internally inconsistent');
}

const o01 = readiness.items.find((item) => item.id === 'O01');
const o02 = readiness.items.find((item) => item.id === 'O02');
const o03 = readiness.items.find((item) => item.id === 'O03');
const o04 = readiness.items.find((item) => item.id === 'O04');
const o05 = readiness.items.find((item) => item.id === 'O05');
const o06 = readiness.items.find((item) => item.id === 'O06');
if (
  o01?.status !== 'verified' || !o01.satisfied || o01.receipt?.path !== governancePath ||
  o02?.status !== 'not-applicable' || o02.satisfied || o02.receipt?.path !== governancePath ||
  o03?.status !== 'not-applicable' || o03.satisfied || o03.receipt?.path !== governancePath ||
  o04?.status !== 'not-applicable' || o04.satisfied || o04.receipt?.path !== governancePath ||
  o05?.status !== 'not-applicable' || o05.satisfied || o05.receipt?.path !== governancePath ||
  o06?.status !== 'not-applicable' || o06.satisfied || o06.receipt?.path !== governancePath ||
  governance.schemaVersion !== 1 || governance.status !== 'approved' ||
  governance.authority.role !== 'project-operator' || governance.authority.institutionalApprovalClaimed ||
  !governance.dataScope.syntheticOnly || governance.dataScope.humanParticipants || governance.dataScope.humanCoding !== 'not-used' ||
  governance.fundingPolicy.profile !== 'simulation-only' ||
  governance.fundingPolicy.externalSpendAuthorized !== 0 ||
  governance.fundingPolicy.realCurrencyAuthorized ||
  governance.fundingPolicy.publicChainTransactionsAuthorized ||
  governance.fundingPolicy.transport !== 'deterministic in-memory chain' ||
  governance.registrationPolicy.profile !== 'repository-native' ||
  governance.registrationPolicy.externalRegistrationRequired ||
  governance.externalDependencyPolicy.upstreamProtectionRequiredForExecution ||
  governance.externalDependencyPolicy.independentHumanRestoreRequiredForExecution ||
  governance.externalDependencyPolicy.externalRegistrationRequiredForExecution
) {
  throw new Error('governance receipt no longer supports O01 or the O02-O06 applicability decisions');
}

const serialized = readinessBytes.toString('utf8').toLowerCase();
for (const forbidden of ['privatekey', 'private_key', 'signerseed', 'signer_seed', 'rpccredential', 'rpc_credential', 'access_token']) {
  if (serialized.includes(forbidden)) throw new Error(`tracked readiness ledger contains forbidden secret field ${forbidden}`);
}
if (readiness.privacyBoundary.length < 3 || readiness.activationRule.length < 80 || readiness.boundary.length < 80) {
  throw new Error('external prerequisite boundaries are incomplete');
}

console.log(`external dependencies valid: ${String(satisfiedCount)}/${String(applicable.length)} applicable satisfied, 5 optional external items not applicable, decision=${readiness.decision}, hosted-enforcement-observation=${upstream.decision}`);
