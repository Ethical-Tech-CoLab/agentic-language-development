#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  evaluateResearchPreflight,
  formatResearchPreflight,
} from '@ald/ops';
import { hashCanonical } from '@ald/hashing';
import { HASH_DOMAINS } from '@ald/types';

const { values } = parseArgs({
  options: {
    registration: { type: 'string' },
    binding: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (values.registration === undefined) {
  throw new Error('--registration <compiled-registration.json> is required');
}

const compiled = JSON.parse(await readFile(resolve(values.registration), 'utf8'));
const firstRun = compiled.runs?.[0];
if (firstRun?.config === undefined || compiled.artifact === undefined) {
  throw new Error('registration file is not a compiled ALD registration artifact');
}
const binding =
  values.binding === undefined
    ? undefined
    : JSON.parse(await readFile(resolve(values.binding), 'utf8'));
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const isAncestor = (commit) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, headCommit]);
    return true;
  } catch {
    return false;
  }
};
const clean =
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    .length === 0;
const registrationRecordMatches = () => {
  if (binding?.registrationAuthority === 'external') return true;
  const registration = binding?.repositoryRegistration;
  if (registration === undefined || !isAncestor(registration.commit)) return false;
  try {
    const committed = JSON.parse(
      execFileSync('git', ['show', `${registration.commit}:${registration.path}`], {
        encoding: 'utf8',
      }),
    );
    const artifact = committed.artifact ?? committed;
    const committedAt = execFileSync(
      'git',
      ['show', '-s', '--format=%cI', registration.commit],
      { encoding: 'utf8' },
    ).trim();
    return (
      hashCanonical(HASH_DOMAINS.preRegistration, artifact) ===
        registration.artifactSha256 &&
      registration.artifactSha256 === compiled.preRegistrationHash &&
      Date.parse(committedAt) === Date.parse(registration.committedAt)
    );
  } catch {
    return false;
  }
};
const report = evaluateResearchPreflight({
  config: firstRun.config,
  artifact: compiled.artifact,
  preRegistrationHash: compiled.preRegistrationHash,
  binding,
  repository: {
    headCommit,
    clean,
    protocolCommitIsAncestor: isAncestor(firstRun.config.protocolGitCommit),
    registrationRecordMatches: registrationRecordMatches(),
  },
});

process.stdout.write(
  values.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatResearchPreflight(report),
);
process.exitCode = report.ready ? 0 : 1;
