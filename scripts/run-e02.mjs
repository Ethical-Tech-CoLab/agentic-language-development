import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditE02Observations } from '../deploy/mode-r/audit-e02-observations.mjs';
import { e02RootBuildInputs, validateE02SlotContract } from '../deploy/mode-r/e02-slot-contract.mjs';

const evidenceRoot = 'evidence/qualification/e02-v3';
const receiptPath = 'reports/research/e02-v3-qualification-receipt.json';
const packetPath = 'protocols/e02-registration.v3.json';
const bindingPath = 'protocols/e02-registration-binding.v3.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--run', '--audit'].includes(mode));
execFileSync(process.execPath, ['scripts/register-e02.mjs', '--check-v3'], { stdio: 'inherit' });
const packet = read(packetPath), binding = read(bindingPath);
const bindings = Object.fromEntries(packet.artifact.bindings.map((entry) => [entry.key, entry.content]));
const seeds = bindings.selectedSeedPrefix.primary;
assert.equal(seeds.length, 5);
for (const expected of seeds) validateE02SlotContract(packet, binding, expected.slot, expected.scenario, packetPath);

async function checkSlot(expected, executionCommit) {
  const directory = join(evidenceRoot, `registered-e02-v3-${expected.slot}`);
  const checked = await auditE02Observations(directory, { slot: expected.slot, seed: expected.scenario, executionCommit, binding,
    rustPath: resolve(evidenceRoot, 'ald-integrity-auditor'), rustSha256: bindings.executionHost.rustAuditorSha256 });
  const output = read(join(directory, 'slot.json'));
  return { slot: expected.slot, seed: expected.scenario, runId: output.runId,
    slotSha256: sha256(readFileSync(join(directory, 'slot.json'))),
    containerIds: output.topology[0].containerIds, resourceUsage: output.resourceUsage,
    containerResourceUsage: output.containerResourceUsage, wallMilliseconds: output.wallMilliseconds, ...checked };
}

if (mode === '--audit') {
  const receipt = read(receiptPath);
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registrationHash, packet.preRegistrationHash);
  assert.equal(receipt.failure, null);
  git('merge-base', '--is-ancestor', binding.repositoryRegistration.commit, receipt.executionCommit);
  for (const source of bindings.analysisVersions) {
    assert.equal(sha256(execFileSync('git', ['show', `${receipt.executionCommit}:${source.path}`])), source.sha256);
  }
  assert.deepEqual(e02RootBuildInputs(JSON.parse(git('show', `${receipt.executionCommit}:package.json`))), bindings.executionHost.rootBuildInputs);
  const slots = [];
  for (const expected of seeds) slots.push(await checkSlot(expected, receipt.executionCommit));
  assert.deepEqual(receipt.slots, slots);
  assert.equal(new Set(slots.flatMap((slot) => slot.containerIds)).size, 10);
  assert.equal(receipt.passed, slots.every((slot) => slot.passed));
  console.log(`E02 v3 five-slot audit complete; qualification ${receipt.passed ? 'passed' : 'failed'}`);
  if (!receipt.passed) process.exitCode = 1;
} else {
  assert.equal(git('status', '--porcelain'), '', 'registered execution requires a clean commit');
  assert.equal(existsSync(evidenceRoot), false, 'every attempted seed set is single-use');
  assert.equal(existsSync(receiptPath), false, 'refusing to overwrite an earlier receipt');
  assert.ok(existsSync('.artifacts/cargo-target/release/ald-integrity-auditor'));
  assert.equal(sha256(readFileSync('.artifacts/cargo-target/release/ald-integrity-auditor')), bindings.executionHost.rustAuditorSha256);
  execFileSync('/home/linuxbrew/.linuxbrew/bin/Rscript', ['--version']);
  for (const source of bindings.analysisVersions) assert.equal(sha256(readFileSync(source.path)), source.sha256, source.path);
  assert.deepEqual(e02RootBuildInputs(read('package.json')), bindings.executionHost.rootBuildInputs);
  // Five hours of controller CPU plus at most one CPU-hour per learner/Nursery
  // process in each of five slots reserves 20 CPU-hours, not 50 wall-clock hours.
  execFileSync('/usr/bin/prlimit', ['--pid', String(process.pid), '--cpu=18000:18000']);
  const executionCommit = git('rev-parse', 'HEAD');
  git('merge-base', '--is-ancestor', git('log', '-1', '--format=%H', '--', bindingPath), executionCommit);
  const filesystem = statfsSync('.');
  assert.ok(filesystem.bavail * filesystem.bsize >= 10 * 1024 ** 3, 'need at least 10 GiB free before reserving this attempt');
  mkdirSync(evidenceRoot, { recursive: true });
  copyFileSync(packetPath, join(evidenceRoot, 'registration-packet.json'));
  copyFileSync(bindingPath, join(evidenceRoot, 'registration-binding.json'));
  copyFileSync('.artifacts/cargo-target/release/ald-integrity-auditor', join(evidenceRoot, 'ald-integrity-auditor'));
  writeFileSync(join(evidenceRoot, 'attempt.json'), JSON.stringify({ executionCommit,
    registrationHash: packet.preRegistrationHash, seeds, startedAt: new Date().toISOString(),
    noSameSeedRerun: true }, null, 2), { flag: 'wx' });
  const environment = { ...process.env, ALD_SOFTWARE_COMMIT: executionCommit, ALD_LEARNER_TRACK: 'scratch-rl',
    ALD_MODE_R_NURSERY_UID: String(process.getuid()), ALD_MODE_R_NURSERY_GID: String(process.getgid()),
    ALD_MODE_R_EVIDENCE_DIR: resolve(evidenceRoot) };
  const compose = ['compose', '--project-name', 'ald-e02-v3-qualified', '--file', 'deploy/mode-r/docker-compose.yml',
    '--file', 'deploy/mode-r/docker-compose.e02.yml'];
  const command = (args) => {
    const result = spawnSync('docker', args, { env: environment, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  const slots = [];
  const started = performance.now();
  let failure = null;
  try {
    command([...compose, 'build', 'baby-a', 'baby-b', 'nursery-study']);
    const digests = JSON.parse(command(['image', 'inspect', 'node:24.20.0-alpine', '--format', '{{json .RepoDigests}}']));
    assert.ok(digests.some((digest) => digest.endsWith(`@${bindings.executionHost.nodeImage.split('@')[1]}`)));
    for (const expected of seeds) {
      assert.equal(abort.signal.aborted, false, 'interrupted; no replacement seed will be attempted');
      command([...compose, 'up', '--detach', '--force-recreate', 'baby-a', 'baby-b']);
      const log = createWriteStream(join(evidenceRoot, `slot-${expected.slot}.log`), { flags: 'wx' });
      const status = await new Promise((resolveStatus, reject) => {
        const child = spawn('docker', [...compose, 'run', '--rm', '--no-deps', '--name', 'ald-e02-v3-qualified-nursery',
          '--entrypoint', '/usr/local/bin/node', 'nursery-study', '--max-old-space-size=1536',
          '/app/deploy/mode-r/run-e02-slot.mjs', String(expected.slot), expected.scenario, executionCommit],
        { env: environment, signal: abort.signal, timeout: 10 * 60 * 60 * 1000 });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log.write(chunk); process.stdout.write(chunk); });
        child.once('error', reject);
        child.once('close', (code) => log.end(() => resolveStatus(code)));
        log.once('error', reject);
      });
      const outputPath = join(evidenceRoot, `registered-e02-v3-${expected.slot}`, 'slot.json');
      assert.ok(existsSync(outputPath), 'infrastructure failure; partial evidence and log retained');
      const checked = await checkSlot(expected, executionCommit);
      assert.ok(status === 0 || (status === 1 && !checked.passed), 'process status contradicts audited slot');
      slots.push(checked);
      command([...compose, 'down', '--remove-orphans']);
      console.log(`E02 slot ${expected.slot}/5: ${checked.passed ? 'pass' : 'fail'}; original evidence retained`);
    }
    assert.equal(new Set(slots.flatMap((slot) => slot.containerIds)).size, 10);
  } catch (error) { failure = `${error.name}: ${error.message}`; }
  finally {
    // A timed-out Docker client can leave its one-off container alive. Stop only
    // this experiment's exact named container before removing its owned topology.
    if (spawnSync('docker', ['inspect', 'ald-e02-v3-qualified-nursery'], { stdio: 'ignore' }).status === 0) {
      try { command(['stop', '--time', '30', 'ald-e02-v3-qualified-nursery']); }
      catch (error) { failure = `${failure ?? ''} stop failed: ${error.message}`; }
    }
    try { command([...compose, 'down', '--remove-orphans']); }
    catch (error) { failure = `${failure ?? ''} cleanup failed: ${error.message}`; }
  }
  const receipt = { schemaVersion: 1, experimentId: 'E02', researchFinding: false,
    classification: 'prospectively-registered-software-qualification', registrationHash: packet.preRegistrationHash,
    executionCommit, externalSpend: 0, publicChainTransaction: false, slots, failure,
    wallMilliseconds: performance.now() - started, passed: failure === null && slots.length === 5 && slots.every((slot) => slot.passed),
    claimBoundary: 'Asset-free numeric scratch-learner topology and registered linear feature probes only. No behavioral finding, image encoder qualification, independent operator review, or public timestamp.' };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  if (!receipt.passed) process.exitCode = 1;
}
