#!/usr/bin/env node
// A0 single host-job lease. Dependency-free: node builtins only. One lease at
// a time across all agents; a lease binds a fresh admitting preflight receipt
// to the same policy, source, task, command, peak, path and I/O class.
// Acquisition is atomic (hard-link); concurrent requests yield exactly one
// owner. The lease records the exact systemd-run leaf invocation (transient
// scope inside aldresearch.slice with verified properties); only
// scripts/a0-launch.mjs executes it, never this script. Duration is enforced
// both by RuntimeMaxSec on the leaf and by the supervising launcher.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DIR = '.artifacts/a0-leases';
const ACTIVE = `${DIR}/active.json`;
const POLICY_REV = 2; // keep in sync with scripts/a0-preflight.mjs
const MAX_PREFLIGHT_AGE_MS = 10 * 60 * 1000;
// Leaf properties verified against transient scope units on 2026-09-28:
// scope units ACCEPT MemoryHigh/MemoryMax/TasksMax/TimeoutStopSec/
// RuntimeMaxSec/CPUWeight and REJECT Nice=/IOSchedulingClass=. Nice=15 is set
// by the launcher on itself (inherited by the leaf) and verified via /proc.
const LEAF_PROPERTIES = [
  '--property=MemoryHigh=768M',
  '--property=MemoryMax=1G',
  '--property=TasksMax=64',
  '--property=TimeoutStopSec=10',
  '--property=CPUWeight=10',
];

function fail(message) {
  console.error(JSON.stringify({ lease: 'error', reason: message }));
  process.exit(2);
}
function autoSource() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
function readActive() {
  let active;
  try {
    active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
  } catch {
    fail(`lease state at ${ACTIVE} is corrupt; operator inspection required (never auto-deleted)`);
  }
  return active;
}
function unitIsActive(unit) {
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const command = process.argv[2];
if (!['create', 'show', 'release'].includes(command)) {
  fail('usage: node scripts/a0-lease.mjs <create|show|release> [...]');
}
if (command === 'show') {
  if (!existsSync(ACTIVE)) fail('no active lease');
  console.log(readFileSync(ACTIVE, 'utf8'));
  process.exit(0);
}
if (command === 'release') {
  let values;
  try {
    values = parseArgs({
      args: process.argv.slice(3),
      options: { owner: { type: 'string' }, reason: { type: 'string', default: '' } },
    }).values;
  } catch {
    fail('release takes only --owner and --reason');
  }
  if (!existsSync(ACTIVE)) fail('no active lease to release');
  const active = readActive();
  if (!values.owner || values.owner !== active.owner) fail('release requires the owning --owner');
  if (active.status === 'running') {
    if (unitIsActive(active.unit)) {
      fail(`lease ${active.id} has a running job (${active.unit}); stop it via the launcher first — release never orphans a live unit`);
    }
    active.outcome = `launcher-lost (unit ${active.unit} already gone; released by ${values.owner}: ${values.reason})`;
  }
  const stamp = new Date().toISOString().replaceAll(':', '-');
  active.releasedAt = new Date().toISOString();
  active.releaseReason = values.reason;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/released-${stamp}.json`, `${JSON.stringify(active, null, 2)}\n`);
  unlinkSync(ACTIVE);
  console.log(JSON.stringify({ lease: 'released', id: active.id, reason: values.reason }));
  process.exit(0);
}
// create
let values;
try {
  values = parseArgs({
    args: process.argv.slice(3),
    options: {
      owner: { type: 'string' },
      task: { type: 'string' },
      command: { type: 'string' },
      preflight: { type: 'string' },
      timeout: { type: 'string' },
      source: { type: 'string' },
      'data-path': { type: 'string', default: process.cwd() },
      'disk-heavy': { type: 'string', default: 'no' },
      'declared-peak-bytes': { type: 'string', default: '805306368' },
    },
  }).values;
} catch {
  fail('create takes only --owner, --task, --command, --preflight, --timeout, --source, --data-path, --disk-heavy, and --declared-peak-bytes');
}
for (const key of ['owner', 'task', 'command', 'preflight', 'timeout']) {
  if (!values[key]) fail(`create requires --${key}`);
}
if (!/^\d+$/.test(values.timeout) || Number(values.timeout) < 1) fail('create requires --timeout as a positive integer number of seconds');
const timeoutSec = Number(values.timeout);
const declaredPeak = Number(values['declared-peak-bytes']);
if (!Number.isFinite(declaredPeak) || declaredPeak < 0) fail('declared-peak-bytes must be finite and >= 0');
if (!['yes', 'no'].includes(values['disk-heavy'])) fail('disk-heavy must be yes or no');
const diskHeavy = values['disk-heavy'] === 'yes';
const source = values.source ?? autoSource();
if (!source || source === 'unknown') fail('cannot bind source identity (git HEAD unresolvable and no --source given)');
let receiptBytes;
try {
  receiptBytes = readFileSync(values.preflight, 'utf8');
} catch {
  fail(`preflight receipt ${values.preflight} is missing or invalid`);
}
let receipt;
try {
  receipt = JSON.parse(receiptBytes);
} catch {
  fail(`preflight receipt ${values.preflight} is missing or invalid`);
}
if (receipt.admission !== 'admit') fail(`preflight receipt ${values.preflight} does not admit (${receipt.admission})`);
if (receipt.policyRev !== POLICY_REV) {
  fail(`preflight receipt binds policy rev ${receipt.policyRev}, need ${POLICY_REV}; re-run preflight`);
}
const bindings = [
  ['task', receipt.task, values.task],
  ['command', receipt.command, values.command],
  ['source', receipt.source, source],
  ['declaredPeakBytes', receipt.declaredPeakBytes, declaredPeak],
  ['dataPath', receipt.dataPath, values['data-path']],
  ['diskHeavy', receipt.diskHeavy, diskHeavy],
];
for (const [key, got, want] of bindings) {
  if (got !== want) fail(`preflight receipt ${key} mismatch (receipt ${JSON.stringify(got)} != lease ${JSON.stringify(want)}); re-run preflight for this exact job`);
}
if (diskHeavy && receipt.io?.ioReady !== true) fail('disk-heavy task requires a preflight with ioReady (delegated io + job-device entry)');
if (!receipt.healthFile) fail('preflight receipt binds no production-health evidence; re-run preflight with --health-file');
const age = Date.now() - Date.parse(receipt.at);
if (!Number.isFinite(age) || age < 0 || age > MAX_PREFLIGHT_AGE_MS) fail('preflight receipt is stale (older than 10 minutes)');
const id = `a0-${Date.now().toString(36)}`;
const unit = `aldresearch-job-${id}.scope`;
const lease = {
  id,
  unit,
  status: 'acquired',
  owner: values.owner,
  task: values.task,
  command: values.command,
  source,
  dataPath: values['data-path'],
  diskHeavy,
  preflight: values.preflight,
  preflightAt: receipt.at,
  receiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
  policyRev: POLICY_REV,
  healthFile: receipt.healthFile,
  healthMaxAgeSec: receipt.healthMaxAgeSec,
  timeoutSec,
  declaredPeakBytes: declaredPeak,
  createdAt: new Date().toISOString(),
  members: [],
  // Pinned transient-leaf properties (scope-verified set; see LEAF_PROPERTIES).
  // Slice membership carries the aggregate caps; CPUWeight deprioritizes;
  // MemoryMax is the per-job backstop; RuntimeMaxSec enforces the duration at
  // the supervisor layer as well as in the launcher. Slice must be installed.
  run: [
    'systemd-run', '--user', '--scope', `--unit=${unit}`,
    '--slice=aldresearch.slice',
    ...LEAF_PROPERTIES,
    `--property=RuntimeMaxSec=${timeoutSec}`,
    '--', 'sh', '-c', values.command,
  ],
  launcher: `node scripts/a0-launch.mjs --owner ${values.owner}`,
};
mkdirSync(DIR, { recursive: true });
const tmp = `${DIR}/.acquiring-${process.pid}-${Date.now().toString(36)}.json`;
writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
try {
  linkSync(tmp, ACTIVE); // atomic: exactly one concurrent create wins
} catch {
  unlinkSync(tmp);
  if (existsSync(ACTIVE)) {
    const active = readActive();
    fail(`a lease is already active (${active.id} ${active.task} owned by ${active.owner}); release it first`);
  }
  fail(`cannot acquire lease at ${ACTIVE}`);
}
unlinkSync(tmp);
console.log(JSON.stringify(lease, null, 2));
