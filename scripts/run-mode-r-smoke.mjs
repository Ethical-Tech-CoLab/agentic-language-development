import { spawnSync } from 'node:child_process';

const composeFile = 'deploy/mode-r/docker-compose.yml';
const project = `ald-mode-r-${String(process.pid)}`;
const base = ['compose', '--project-name', project, '--file', composeFile];

function docker(args, options = {}) {
  const result = spawnSync('docker', [...base, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`docker ${args.join(' ')} exited ${String(result.status)}`);
  }
  return result.stdout ?? '';
}

try {
  docker(['up', '--build', '--detach', 'baby-a', 'baby-b']);
  docker(['run', '--rm', '--no-deps', 'nursery', 'both']);
  docker(['kill', 'baby-a']);
  const exited = docker(['ps', '--status', 'exited', '--services'], {
    capture: true,
  })
    .trim()
    .split('\n');
  if (!exited.includes('baby-a')) {
    throw new Error('baby-a should be exited after kill');
  }
  docker(['run', '--rm', '--no-deps', 'nursery', 'survivor']);
  for (const track of ['scratch-rl', 'self-supervised', 'hybrid']) {
    const env = { ALD_LEARNER_TRACK: track };
    docker(['up', '--detach', '--force-recreate', 'baby-a', 'baby-b'], { env });
    docker(
      ['run', '--rm', '--no-deps', 'nursery', 'training', track],
      { env },
    );
  }
} finally {
  try {
    docker(['down', '--volumes', '--remove-orphans']);
  } catch {
    // Preserve the primary verification failure while cleanup remains best-effort.
  }
}
