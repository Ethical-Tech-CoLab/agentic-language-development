#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readinessPath = 'reports/research/external-prerequisite-readiness.json';
const campaignPath = 'protocols/campaign-readiness-review.v1.json';
const upstreamPath = 'reports/research/upstream-enforcement-observation.json';
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

interface ReceiptReference {
  path: string;
  sha256: string;
}

interface PrerequisiteItem {
  id: string;
  blockingFinding: string;
  status: 'missing' | 'observed-unsatisfied' | 'verified';
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

const readinessBytes = readFileSync(readinessPath);
const readiness = JSON.parse(readinessBytes.toString('utf8')) as ReadinessLedger;
const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as CampaignReview;
const upstreamBytes = readFileSync(upstreamPath);
const upstream = JSON.parse(upstreamBytes.toString('utf8')) as UpstreamObservation;

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

const campaignFindings = new Map(campaign.blockingFindings.map((finding) => [finding.id, finding]));
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

const satisfiedCount = readiness.items.filter((item) => item.satisfied).length;
if (readiness.requiredCount !== expectedIds.length || readiness.satisfiedCount !== satisfiedCount) {
  throw new Error('external-prerequisite totals do not reconcile');
}
const expectedDecision = satisfiedCount === expectedIds.length ? 'ready' : 'blocked';
if (readiness.decision !== expectedDecision) throw new Error('external-prerequisite decision contradicts its items');
if (campaign.decision === 'not-registration-ready' && readiness.decision === 'ready') {
  throw new Error('external ledger claims readiness while the campaign remains blocked');
}

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
  throw new Error('upstream observation no longer supports O04 observed-unsatisfied');
}

const serialized = readinessBytes.toString('utf8').toLowerCase();
for (const forbidden of ['privatekey', 'private_key', 'signerseed', 'signer_seed', 'rpccredential', 'rpc_credential', 'access_token']) {
  if (serialized.includes(forbidden)) throw new Error(`tracked readiness ledger contains forbidden secret field ${forbidden}`);
}
if (readiness.privacyBoundary.length < 3 || readiness.activationRule.length < 80 || readiness.boundary.length < 80) {
  throw new Error('external prerequisite boundaries are incomplete');
}

console.log(`external prerequisites valid: ${String(satisfiedCount)}/${String(expectedIds.length)} satisfied, decision=${readiness.decision}, O04=${upstream.decision}`);
