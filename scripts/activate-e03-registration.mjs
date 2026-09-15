import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { FakeChainTransport } from '@ald/anchor';
import { hashCanonical } from '@ald/hashing';
import { HASH_DOMAINS, PreRegistrationArtifactSchema, PreRegistrationBindingSchema } from '@ald/types';

const [stage, mode, attemptVersion = 'v1'] = process.argv.slice(2);
assert.ok([4, 5].includes(process.argv.length),
  'usage: activate-e03-registration.mjs <pilot|full> <--activate|--check> [v1|v2]');
assert.ok(['pilot', 'full'].includes(stage));
assert.ok(['--activate', '--check'].includes(mode));
assert.ok(['v1', 'v2'].includes(attemptVersion));
assert.ok(stage === 'pilot' || attemptVersion === 'v1');

const packetPath = `protocols/e03-${stage}-registration.${attemptVersion}.json`;
const bindingPath = `protocols/e03-${stage}-registration-binding.${attemptVersion}.json`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commit = git('log', '-1', '--format=%H', '--', packetPath);
assert.match(commit, /^[a-f0-9]{40}$/u, 'E03 packet must have a repository commit');
git('merge-base', '--is-ancestor', commit, 'HEAD');
const committedBytes = execFileSync('git', ['show', `${commit}:${packetPath}`], { encoding: 'utf8' });
assert.equal(readFileSync(packetPath, 'utf8'), committedBytes, 'working packet differs from committed registration');
const packet = JSON.parse(committedBytes);
const artifact = PreRegistrationArtifactSchema.parse(packet.artifact);
assert.equal(artifact.experimentId, 'E03');
assert.equal(artifact.registrationClass, 'qualification');
assert.equal(artifact.parameters.stage, stage === 'pilot' ? 'blinded-pilot' : 'full-qualification');
assert.equal(packet.preRegistrationHash, hashCanonical(HASH_DOMAINS.preRegistration, artifact));
git('merge-base', '--is-ancestor', artifact.protocolGitCommit, commit);

const chain = new FakeChainTransport({ endpointLabel: `e03-${stage}-registration-simulation` });
const transaction = await chain.sendAnchorTransaction({
  checkpointHash: packet.preRegistrationHash, to: `0x${'43'.repeat(20)}`,
});
chain.mineBlock(3);
const [record, receipt, latestBlock] = await Promise.all([
  chain.getTransaction(transaction.transactionHash),
  chain.getTransactionReceipt(transaction.transactionHash),
  chain.latestBlockNumber(),
]);
assert.ok(record && receipt);
assert.equal(record.input, transaction.inputData);
assert.equal(receipt.status, 'success');
assert.equal(latestBlock - receipt.blockNumber + 1, 3);

const binding = PreRegistrationBindingSchema.parse({
  registrationClass: 'qualification', registrationAuthority: 'repository-native',
  preRegistrationHash: packet.preRegistrationHash,
  repositoryRegistration: {
    commit, path: packetPath, artifactSha256: packet.preRegistrationHash,
    committedAt: git('show', '-s', '--format=%cI', commit),
  },
  preRunAnchor: {
    anchorClass: 'simulated', network: chain.network, chainId: chain.chainId,
    transactionHash: transaction.transactionHash, inputData: transaction.inputData,
    blockNumber: receipt.blockNumber, status: 'confirmed',
  },
  label: `E03 ${stage} qualification; simulation is not an independent public timestamp`,
});
const rendered = `${JSON.stringify(binding, null, 2)}\n`;
if (mode === '--activate') {
  assert.equal(git('status', '--porcelain'), '', 'activate only a clean committed packet');
  assert.equal(existsSync(bindingPath), false, 'refusing to overwrite an existing activation binding');
  writeFileSync(bindingPath, rendered, { flag: 'wx' });
} else {
  assert.equal(readFileSync(bindingPath, 'utf8'), rendered, 'E03 activation binding is stale');
}
console.log(`E03 ${stage} registration ${mode.slice(2)} valid: hash=${packet.preRegistrationHash}; simulated confirmations=3`);
