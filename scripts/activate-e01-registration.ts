#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { FakeChainTransport } from '@ald/anchor';
import { compileRegistrationPacket } from '@ald/analysis';
import { PreRegistrationBindingSchema } from '@ald/types';

const registrationCommit = '62dfd93e6e68cd52bed60701da6848b8292ccc4b';
const registrationPath = 'protocols/e01-registration.v1.json';
const outputPath = 'protocols/e01-registration-binding.v1.json';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['merge-base', '--is-ancestor', registrationCommit, head]);
const committedBytes = execFileSync(
  'git',
  ['show', `${registrationCommit}:${registrationPath}`],
  { encoding: 'utf8' },
);
if (committedBytes !== readFileSync(registrationPath, 'utf8')) {
  throw new Error('working E01 registration differs from its immutable Git record');
}
const registration = JSON.parse(committedBytes) as {
  artifact: { experimentId: string; registrationClass: string; bindings: Array<{ key: string; content: unknown }> };
  preRegistrationHash: string;
};
const bindings = Object.fromEntries(
  registration.artifact.bindings.map((binding) => [binding.key, binding.content]),
) as Parameters<typeof compileRegistrationPacket>[0]['bindings'];
const reproduced = compileRegistrationPacket({
  experimentId: registration.artifact.experimentId,
  registrationClass: registration.artifact.registrationClass,
  bindings,
});
if (reproduced.preRegistrationHash !== registration.preRegistrationHash) {
  throw new Error('committed E01 registration packet hash does not reproduce');
}

const transport = new FakeChainTransport({ endpointLabel: 'e01-registration-simulation' });
const submitted = await transport.sendAnchorTransaction({
  checkpointHash: registration.preRegistrationHash,
  to: `0x${'e01'.padEnd(40, '0')}`,
});
transport.mineBlock(3);
const [transaction, receipt, headBlock] = await Promise.all([
  transport.getTransaction(submitted.transactionHash),
  transport.getTransactionReceipt(submitted.transactionHash),
  transport.latestBlockNumber(),
]);
if (
  transaction === null ||
  receipt === null ||
  receipt.status !== 'success' ||
  transaction.input !== submitted.inputData ||
  headBlock - receipt.blockNumber + 1 !== 3
) {
  throw new Error('E01 simulated pre-run commitment did not reach its finality rule');
}
const committedAt = execFileSync(
  'git',
  ['show', '-s', '--format=%cI', registrationCommit],
  { encoding: 'utf8' },
).trim();
const binding = PreRegistrationBindingSchema.parse({
  registrationClass: 'qualification',
  registrationAuthority: 'repository-native',
  preRegistrationHash: registration.preRegistrationHash,
  repositoryRegistration: {
    commit: registrationCommit,
    path: registrationPath,
    artifactSha256: registration.preRegistrationHash,
    committedAt,
  },
  preRunAnchor: {
    anchorClass: 'simulated',
    network: transport.network,
    chainId: transport.chainId,
    transactionHash: submitted.transactionHash,
    inputData: submitted.inputData,
    blockNumber: receipt.blockNumber,
    status: 'confirmed',
  },
  label: 'qualification: repository-registered and simulation-committed before E01 execution',
});
const rendered = `${JSON.stringify(binding, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
} else if (readFileSync(outputPath, 'utf8') !== rendered) {
  throw new Error('E01 registration binding is stale; run pnpm run activate:registration-e01');
}
console.log(
  `E01 registration active: commit=${registrationCommit}, hash=${registration.preRegistrationHash}, simulatedTx=${submitted.transactionHash}, confirmations=3`,
);
