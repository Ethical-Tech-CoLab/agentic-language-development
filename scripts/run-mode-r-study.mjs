import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { SIGNER_DOMAINS } from '@ald/types';

// Exact topology receipt for the recurrent ALD-045 and ALD-046 paths.

const composeFile = 'deploy/mode-r/docker-compose.yml';
const fortComposeFile = 'deploy/mode-r/docker-compose.fort.yml';
const project = `ald-mode-r-study-${String(process.pid)}`;
const signerServices = SIGNER_DOMAINS.map((domain) => `signer-${domain}`);
const fortMode = process.env['ALD_RUN_SIGNER_SEEDS_JSON_FILE'] !== undefined;
const outputDir = resolve(
  process.env['ALD_MODE_R_EVIDENCE_DIR'] ??
    `evidence/validation/mode-r-study-${String(process.pid)}`,
);
const base = ['compose', '--project-name', project, '--file', composeFile];
if (fortMode) {
  base.push('--file', fortComposeFile);
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

if (git(['status', '--porcelain']) !== '') {
  throw new Error('Mode R study qualification requires a clean exact source');
}
const commit = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
mkdirSync(outputDir, { recursive: true });

function verifyFortComposeBoundary() {
  const rendered = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--file',
      composeFile,
      '--file',
      fortComposeFile,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ALD_MODE_R_SIGNER_SOCKET_ROOT: '/tmp/ald-mode-r-signers',
        ALD_RUN_SIGNER_SEEDS_JSON_FILE:
          '/tmp/ald-fort-material-compose-contract',
      },
    },
  );
  if (rendered.error !== undefined) throw rendered.error;
  if (rendered.status !== 0) {
    process.stderr.write(rendered.stderr ?? '');
    throw new Error('Fort Compose boundary did not render');
  }
  const services = JSON.parse(rendered.stdout).services;
  const secretTarget = '/run/secrets/ald-run-signer-seeds.json';
  if (
    services['nursery-study'].environment.ALD_RUN_SIGNER_SEEDS_JSON_FILE !==
      secretTarget ||
    !services['nursery-study'].volumes.some(
      (volume) => volume.target === secretTarget && volume.read_only === true,
    )
  ) {
    throw new Error('Nursery Fort file contract is incomplete');
  }
  for (const learner of ['baby-a', 'baby-b']) {
    if (
      services[learner].environment?.ALD_RUN_SIGNER_SEEDS_JSON_FILE !==
        undefined ||
      (services[learner].volumes ?? []).some(
        (volume) => volume.target === secretTarget,
      )
    ) {
      throw new Error(`${learner} received signer material`);
    }
    if ((services[learner].volumes ?? []).some((volume) =>
      volume.target.startsWith('/signers') || volume.target === '/signer')) {
      throw new Error(`${learner} received signer socket access`);
    }
  }
  if (!services['nursery-study'].volumes.some((volume) =>
    volume.target === '/signers' && volume.read_only === true)) {
    throw new Error('Nursery signer socket mount is not read-only');
  }
  for (const [index, service] of signerServices.entries()) {
    const signer = services[service];
    if (signer.network_mode !== 'none' ||
        signer.volumes.length !== 1 ||
        signer.volumes[0].target !== '/signer' ||
        signer.volumes[0].read_only === true ||
        signer.volumes[0].source !== `/tmp/ald-mode-r-signers/${SIGNER_DOMAINS[index]}` ||
        (signer.volumes ?? []).some((volume) => volume.target === secretTarget)) {
      throw new Error(`${service} violates the signer-only Compose boundary`);
    }
  }
}

function docker(args, environment = {}) {
  const result = spawnSync('docker', [...base, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
    env: {
      ...process.env,
      ALD_MODE_R_EVIDENCE_DIR: outputDir,
      ALD_MODE_R_NURSERY_UID: String(process.getuid?.() ?? 1000),
      ALD_MODE_R_NURSERY_GID: String(process.getgid?.() ?? 1000),
      ALD_SOFTWARE_COMMIT: commit,
      ...environment,
    },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${String(result.status)}`);
  }
}

function dockerResult(args, environment = {}) {
  const result = spawnSync('docker', [...base, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function inspectContainer(id) {
  const result = spawnSync('docker', ['inspect', id], { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error('signer container inspect failed');
  const inspected = JSON.parse(result.stdout);
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error('signer container inspect was incomplete');
  }
  return inspected[0];
}

const results = [];
let currentTrack = 'preflight';
try {
  verifyFortComposeBoundary();
  for (const track of [
    'no-learning',
    'scratch-rl',
    'self-supervised',
    'hybrid',
  ]) {
    currentTrack = track;
    const signerRoot = resolve(outputDir, 'signer-sockets', track);
    for (const domain of SIGNER_DOMAINS) {
      mkdirSync(resolve(signerRoot, domain), { recursive: true, mode: 0o700 });
    }
    const environment = {
      ALD_LEARNER_TRACK: track,
      ALD_MODE_R_SIGNER_SOCKET_ROOT: signerRoot,
    };
    docker(['up', '--build', '--detach', '--force-recreate', 'baby-a', 'baby-b',
      ...(fortMode ? [] : signerServices)], environment);
    const signerContainerIds = fortMode ? {} : Object.fromEntries(
      signerServices.map((service) => [service,
        dockerResult(['ps', '-q', service], environment)]));
    if (!fortMode && (Object.values(signerContainerIds).some((id) => id.length < 12) ||
        new Set(Object.values(signerContainerIds)).size !== SIGNER_DOMAINS.length)) {
      throw new Error('signer containers are missing or share an identity');
    }
    for (const [index, service] of signerServices.entries()) {
      if (fortMode) break;
      const inspected = inspectContainer(signerContainerIds[service]);
      const mounts = inspected.Mounts ?? [];
      if (inspected.HostConfig.NetworkMode !== 'none' ||
          inspected.HostConfig.ReadonlyRootfs !== true ||
          mounts.length !== 1 || mounts[0].Destination !== '/signer' ||
          mounts[0].Source !== resolve(signerRoot, SIGNER_DOMAINS[index])) {
        throw new Error(`${service} has an unexpected live network or mount boundary`);
      }
    }
    docker(['run', '--rm', '--no-deps', 'nursery-study', track], environment);
    const result = JSON.parse(
      readFileSync(resolve(outputDir, `mode-r-study-${track}-summary.json`), 'utf8'),
    );
    if (result.state !== 'sealed' || result.verifierExitCode !== 0) {
      throw new Error(`${track} did not seal and verify`);
    }
    if (result.containerIds['baby-a'] === result.containerIds['baby-b']) {
      throw new Error(`${track} did not use distinct learner containers`);
    }
    if (result.signerBoundary !== (fortMode
      ? 'nursery-fort-file' : 'six-ephemeral-container-signers')) {
      throw new Error(`${track} signer boundary was not reported accurately`);
    }
    results.push({ ...result, signerContainerIds });
  }
  const recurrent = results
    .filter((result) => result.recurrentPolicy !== undefined)
    .map((result) => result.recurrentPolicy);
  if (
    recurrent.length !== 2 ||
    recurrent[0].parameterCount !== recurrent[1].parameterCount
  ) {
    throw new Error('scratch-RL and self-supervised recurrent capacity differ');
  }
  if (git(['status', '--porcelain']) !== '') {
    throw new Error('Mode R study source changed during execution');
  }
  const terminal = {
      schemaVersion: 1,
      classification: 'mode-r-signer-container-reference-terminal',
      researchFinding: false,
      publicChainTransaction: false,
      b12Closed: false,
      execution: { commit, tree, version, cleanBeforeAndAfter: true },
      outputDir,
      fortComposeBoundaryVerified: true,
      recurrentCapacityMatched: true,
      runs: results,
      allSealedAndVerified: true,
      independentRustAuditCompleted: false,
  };
  writeFileSync(resolve(outputDir, 'terminal.json'), `${JSON.stringify(terminal, null, 2)}\n`,
    { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(terminal)}\n`);
} catch (error) {
  try {
    writeFileSync(resolve(outputDir, 'attempt-failure.json'), `${JSON.stringify({
      schemaVersion: 1,
      classification: 'mode-r-signer-container-reference-failure',
      executionCommit: commit,
      currentTrack,
      completedTracks: results.map((result) => result.track),
      exceptionClass: error instanceof Error ? error.name : 'unknown',
      researchFinding: false,
    }, null, 2)}\n`, { flag: 'wx' });
  } catch {
    // Preserve the original failure if even supplemental accounting fails.
  }
  throw error;
} finally {
  try {
    docker(['down', '--volumes', '--remove-orphans']);
  } catch {
    // Preserve the primary qualification failure while cleanup remains best-effort.
  }
}
