import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const composeFile = 'deploy/mode-r/docker-compose.yml';
const fortComposeFile = 'deploy/mode-r/docker-compose.fort.yml';
const project = `ald-mode-r-study-${String(process.pid)}`;
const outputDir = resolve(
  process.env['ALD_MODE_R_EVIDENCE_DIR'] ??
    `evidence/validation/mode-r-study-${String(process.pid)}`,
);
mkdirSync(outputDir, { recursive: true });
const base = ['compose', '--project-name', project, '--file', composeFile];
if (process.env['ALD_RUN_SIGNER_SEEDS_JSON_FILE'] !== undefined) {
  base.push('--file', fortComposeFile);
}
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

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

const results = [];
try {
  verifyFortComposeBoundary();
  for (const track of [
    'no-learning',
    'scratch-rl',
    'self-supervised',
    'hybrid',
  ]) {
    const environment = { ALD_LEARNER_TRACK: track };
    docker(['up', '--build', '--detach', '--force-recreate', 'baby-a', 'baby-b'], environment);
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
    results.push(result);
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      classification: 'mode-r-topology-qualification',
      researchFinding: false,
      publicChainTransaction: false,
      softwareCommit: commit,
      outputDir,
      fortComposeBoundaryVerified: true,
      runs: results,
      allSealedAndVerified: true,
    })}\n`,
  );
} finally {
  try {
    docker(['down', '--volumes', '--remove-orphans']);
  } catch {
    // Preserve the primary qualification failure while cleanup remains best-effort.
  }
}
