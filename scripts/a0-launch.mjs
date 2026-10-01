#!/usr/bin/env node
// A0 job launcher + supervisor + continuous monitor. Dependency-free: node
// builtins only. Executes the ACTIVE lease's pinned systemd-run leaf, verifies
// effective limits/membership/nice at launch, enforces the lease duration,
// samples host/job health during work, applies the policy stop conditions,
// and performs owned-unit cleanup on every path. No auto-restart, no broad
// kill, no second job. Exit: job code on completion, 124 on timeout,
// 2 on supervision/refusal/monitor failure.
// Policy: plans/research-validation-plan.md section 6 (Resource policy revision 5).
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { parseArgs } from 'node:util';

const DIR = '.artifacts/a0-leases';
const ACTIVE = `${DIR}/active.json`;
const POLICY_REV = 5; // keep in sync with scripts/a0-preflight.mjs
const POLICY_NICE = 15;
const MAX_PREFLIGHT_AGE_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 20_000;
const SUMMARY_EVERY_SEC = 60;
const GRACE = { memBytes: 2 * 1024 ** 3, psiMemSome: 5, psiMemFull: 1, psiIoFull: 5, cpuBusy: 75, cpuSteal: 10, load1: 4, cpuPersistSec: 30 };
const EMERG_MEM_BYTES = 1.5 * 1024 ** 3;

function fail(message) {
  console.error(JSON.stringify({ launch: 'error', reason: message }));
  process.exit(2);
}
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let values;
try {
  values = parseArgs({
    options: {
      owner: { type: 'string' },
      'sample-sec': { type: 'string', default: '5' },
      log: { type: 'string' },
    },
  }).values;
} catch {
  fail('usage: node scripts/a0-launch.mjs --owner OWNER [--sample-sec N] [--log FILE]');
}
if (!values.owner) fail('launch requires --owner matching the active lease');
const sampleSec = Number(values['sample-sec']);
if (!Number.isInteger(sampleSec) || sampleSec < 1 || sampleSec > 60) fail('sample-sec must be an integer 1..60');

const uid = process.getuid?.() ?? 1001;
const sliceDir = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/aldresearch.slice`;

function memAvailableBytes() {
  const match = read('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+) kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}
function loadAvg1() {
  const n = Number(read('/proc/loadavg')?.split(' ')[0]);
  return Number.isFinite(n) ? n : null;
}
function psiAvg10(path, field) {
  const line = read(path)?.split('\n').find((l) => l.startsWith(field));
  const match = line?.match(/avg10=(\d+\.\d+)/);
  return match ? Number(match[1]) : null;
}
function cpuSample() {
  const parts = read('/proc/stat')?.split('\n')[0]?.split(/\s+/).slice(1).map(Number);
  if (!parts || parts.length < 8 || parts.some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, steal, total };
}
function oomKills(cgroupPath) {
  const match = read(`${cgroupPath}/memory.events`)?.match(/^oom_kill (\d+)$/m);
  return match ? Number(match[1]) : null;
}
function globalOomKills() {
  const match = read('/proc/vmstat')?.match(/^oom_kill (\d+)$/m);
  return match ? Number(match[1]) : null;
}
function procNice(pid) {
  const text = read(`/proc/${pid}/stat`);
  if (!text) return null;
  const nice = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[16]);
  return Number.isFinite(nice) ? nice : null;
}
function procStarttime(pid) {
  const text = read(`/proc/${pid}/stat`);
  if (!text) return null;
  const start = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[19]);
  return Number.isFinite(start) ? start : null;
}
function userSliceName() {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice`;
}
function unitActive(unit) {
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function unitShow(unit, props) {
  try {
    const out = execFileSync('systemctl', ['--user', 'show', unit, ...props.map((p) => `-p${p}`)], { encoding: 'utf8' });
    return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
  } catch {
    return null;
  }
}
function checkHealth(file, maxAgeSec) {
  // Returns { ok } or { ok:false, kind: 'failing'|'telemetry', detail }.
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, kind: 'telemetry', detail: `${file} unreadable` };
  }
  const age = (Date.now() - Date.parse(doc.at)) / 1000;
  if (doc.healthy !== true) return { ok: false, kind: 'failing', detail: `${file} does not report healthy` };
  if (!Number.isFinite(age) || age < 0 || age > maxAgeSec) {
    return { ok: false, kind: 'failing', detail: `${file} stale (age ${age}s)` };
  }
  return { ok: true };
}

// 1. Deprioritize self (payload inherits this nice; verified below via /proc).
// Never raise priority: an already-more-courteous nice is compliant-or-safer
// (raising nice needs no privilege; lowering it does, and fails under EACCES).
const selfNice = procNice(process.pid);
if (selfNice !== null && selfNice < POLICY_NICE) {
  try {
    setPriority(process.pid, POLICY_NICE);
  } catch (error) {
    fail(`cannot set launcher nice ${POLICY_NICE}: ${error.message}`);
  }
}
if ((procNice(process.pid) ?? -1) < POLICY_NICE) fail('launcher nice readback below courteous level');

// 2. Load + authorize the active lease (never auto-repair state).
if (!existsSync(ACTIVE)) fail('no active lease to launch');
let lease;
try {
  lease = JSON.parse(readFileSync(ACTIVE, 'utf8'));
} catch {
  fail(`lease state at ${ACTIVE} is corrupt; operator inspection required (never auto-deleted)`);
}
if (lease.owner !== values.owner) fail('launch requires the owning --owner');
if (lease.policyRev !== POLICY_REV) fail(`lease binds policy rev ${lease.policyRev}, launcher enforces ${POLICY_REV}`);
if (lease.status !== 'acquired') fail(`lease ${lease.id} status is ${lease.status}, need acquired`);
if (!Array.isArray(lease.run) || lease.run[0] !== 'systemd-run') fail('lease run vector invalid');

// 3. Re-verify the bound receipt (hash + admission + freshness at launch time).
let receiptBytes;
try {
  receiptBytes = readFileSync(lease.preflight, 'utf8');
} catch {
  fail(`bound preflight receipt ${lease.preflight} is now missing`);
}
if (createHash('sha256').update(receiptBytes).digest('hex') !== lease.receiptSha256) {
  fail('bound preflight receipt changed since lease acquisition (hash mismatch)');
}
let receipt;
try {
  receipt = JSON.parse(receiptBytes);
} catch {
  fail('bound preflight receipt is no longer valid JSON');
}
if (receipt.admission !== 'admit') fail(`bound receipt no longer admits (${receipt.admission})`);
const receiptAge = Date.now() - Date.parse(receipt.at);
if (!Number.isFinite(receiptAge) || receiptAge < 0 || receiptAge > MAX_PREFLIGHT_AGE_MS) {
  fail('bound preflight receipt went stale before launch');
}

// 4. The observer stays OUTSIDE the aggregate: the kernel forbids migrating a
// process from a non-leaf cgroup into its own descendant (EUCLEAN, observed
// 2026-09-28), so a launcher inside aldresearch.slice cannot start a leaf
// beneath it. Launches from outside the slice succeed. The launcher's own
// RSS is counted as an uncapped in-scope resident by the preflight via the
// recorded member entry below; policy keeps the observer outside the job it
// may terminate, which this satisfies (outside the leaf entirely).
const logFile = values.log ?? `${DIR}/job-${lease.id}.log`;
mkdirSync(DIR, { recursive: true });
const log = (event) => {
  writeFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { flag: 'a' });
};
const saveActive = (patch) => {
  Object.assign(lease, patch);
  const tmp = `${DIR}/.active-${process.pid}.json`;
  writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
  renameSync(tmp, ACTIVE);
};
function stopUnit(unit) {
  try {
    execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: STOP_TIMEOUT_MS });
  } catch {
    // Fall through to the active-state check below.
  }
}
async function unitQuiesced(unit, leafDir) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    const procs = read(`${leafDir}/cgroup.procs`);
    if (!unitActive(unit) && (procs === null || procs.trim() === '')) return { quiesced: true };
    if (Date.now() > deadline) return { quiesced: false, survivors: (procs ?? '').split('\n').filter(Boolean) };
    await sleep(500);
  }
}
function writeMonitorBlock(reason) {
  writeFileSync(`${DIR}/monitor-block.json`, `${JSON.stringify({ at: new Date().toISOString(), job: lease.id, unit: lease.unit, reason }, null, 2)}\n`);
}
function releaseLease(outcome) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const record = { ...lease, ...outcome, releasedAt: new Date().toISOString() };
  delete record.status;
  writeFileSync(`${DIR}/released-${stamp}.json`, `${JSON.stringify(record, null, 2)}\n`);
  unlinkSync(ACTIVE);
  return record;
}

// 5. Start the leaf (payload stdio passes through; stderr is also scanned for
// immediate property errors).
const child = spawn(lease.run[0], lease.run.slice(1), { stdio: ['ignore', 'inherit', 'pipe'] });
let stderrHead = '';
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  if (stderrHead.length < 4096) stderrHead += chunk.toString('utf8').slice(0, 4096 - stderrHead.length);
});
const childExit = new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve({ code, signal }));
  child.on('error', (error) => resolve({ code: null, signal: null, spawnError: error.message }));
});
log({ event: 'spawn', run: lease.run });

// 6. Verify effective limits + membership + nice at launch.
const leafDir = `${sliceDir}/${lease.unit}`;
async function refuseLaunch(outcome, detail) {
  log({ event: 'launch-refused', outcome, detail, stderrHead: stderrHead.split('\n')[0] });
  stopUnit(lease.unit);
  const q = await unitQuiesced(lease.unit, leafDir);
  if (!q.quiesced) writeMonitorBlock(`${outcome} left survivors: ${q.survivors.join(',')}`);
  const record = releaseLease({ outcome, detail });
  console.log(JSON.stringify({ launch: 'refused', outcome: record.outcome, detail: record.detail }, null, 2));
  process.exit(2);
}
const startedAt = new Date().toISOString();
let membersVerified = false;
let readbackVerified = false;
let earlyExit = null;
{
  const winner = await Promise.race([childExit.then((e) => ({ ...e, exited: true })), sleep(1500).then(() => ({ exited: false }))]);
  if (winner.exited) earlyExit = winner;
}
if (earlyExit && earlyExit.code !== 0 && /Unknown assignment/i.test(stderrHead)) {
  fail(`leaf launch refused (unsupported property): ${stderrHead.split('\n')[0]}`);
}
// A live child with no unit yet is slow start, not failure: wait for the
// unit before judging.
if (!earlyExit && !unitActive(lease.unit)) {
  const deadline = Date.now() + 10_000;
  while (!earlyExit && !unitActive(lease.unit) && Date.now() < deadline) {
    const winner = await Promise.race([childExit.then((e) => ({ ...e, exited: true })), sleep(500).then(() => ({ exited: false }))]);
    if (winner.exited) earlyExit = winner;
  }
  if (!earlyExit && !unitActive(lease.unit)) {
    await refuseLaunch('launch-failed', 'unit never became active');
  }
}
if (!earlyExit && unitActive(lease.unit)) {
  const props = unitShow(lease.unit, ['Slice', 'MemoryHigh', 'MemoryMax', 'TasksMax', 'TimeoutStopUSec', 'RuntimeMaxUSec', 'ControlGroup']);
  const expected = { Slice: 'aldresearch.slice', MemoryHigh: '805306368', MemoryMax: '1073741824', TasksMax: '64', TimeoutStopUSec: '10s' };
  const mismatched = props === null ? ['unreadable'] : Object.entries(expected).filter(([k, v]) => props[k] !== v).map(([k]) => `${k}=${props[k]}`);
  if (props !== null && props.RuntimeMaxUSec === 'infinity') mismatched.push('RuntimeMaxUSec=infinity');
  if (mismatched.length === 0) {
    readbackVerified = true;
  } else {
    log({ event: 'readback-mismatch', mismatched, props });
  }
  const procs = read(`${leafDir}/cgroup.procs`);
  const pids = (procs ?? '').split('\n').filter(Boolean).map(Number);
  if (pids.length > 0) {
    const bad = pids.filter((p) => (procNice(p) ?? -1) < POLICY_NICE);
    if (bad.length === 0) {
      membersVerified = true;
      saveActive({
        status: 'running',
        startedAt,
        launcher: { pid: process.pid, starttime: procStarttime(process.pid) },
        members: [{ pid: process.pid, starttime: procStarttime(process.pid), role: 'launcher' },
          ...pids.map((pid) => ({ pid, starttime: procStarttime(pid), role: 'payload' }))],
        launchOom: { global: globalOomKills(), userSlice: oomKills(userSliceName()), researchSlice: oomKills(sliceDir) },
        membersVerified,
        readbackVerified,
      });
    } else {
      log({ event: 'nice-mismatch', bad });
    }
  }
}
if (!membersVerified || !readbackVerified) {
  const why = earlyExit ? `job exited before verification (code ${earlyExit.code})` : 'effective readback or membership check failed';
  log({ event: 'unverified-launch', why, membersVerified, readbackVerified });
  if (!earlyExit) {
    await refuseLaunch('launch-unverified', `unverified live job does not run: ${why}`);
  }
  // The leaf left no verifiable trace: either a sub-second job result, or a
  // failed start ('Job failed' with no unit activity). Distinguish by evidence.
  earlyExit.launchFailed = earlyExit.code !== 0 && !unitActive(lease.unit) && /Job failed|Failed to start|Access denied/i.test(stderrHead);
  saveActive({ status: 'running', startedAt, membersVerified: false, readbackVerified: false, note: why });
}

// 7. Supervise: deadline, emergency, graceful stops, health, monitor integrity.
let stopRequest = null; // { outcome, detail }
let consecutiveLowMem = 0;
let consecutivePsi = 0;
let consecutiveHigh = 0;
let cpuHotSince = null;
let lastSummary = Date.now();
let lastCpu = cpuSample();
let leafPeak = 0;
let slicePeak = 0;
let samples = 0;
const launchOom = lease.launchOom ?? { global: globalOomKills(), userSlice: oomKills(userSliceName()), researchSlice: oomKills(sliceDir) };
const deadlineMs = Date.parse(startedAt) + lease.timeoutSec * 1000;

const onSignal = async (signal) => {
  if (!stopRequest) stopRequest = { outcome: 'aborted', detail: `launcher received ${signal}` };
};
process.on('SIGINT', () => void onSignal('SIGINT'));
process.on('SIGTERM', () => void onSignal('SIGTERM'));

async function sample() {
  // Returns a stop decision or null; throws on monitor-telemetry failure.
  const now = Date.now();
  const mem = memAvailableBytes();
  const some = psiAvg10('/proc/pressure/memory', 'some');
  const full = psiAvg10('/proc/pressure/memory', 'full');
  const ioFull = psiAvg10('/proc/pressure/io', 'full');
  const load = loadAvg1();
  const cpu = cpuSample();
  const oom = { global: globalOomKills(), userSlice: oomKills(userSliceName()), researchSlice: oomKills(sliceDir) };
  const sliceCur = Number(read(`${sliceDir}/memory.current`));
  const sliceHighRaw = read(`${sliceDir}/memory.high`);
  // Unbounded high (rev5: no aggregate cap) is a valid state, not missing
  // telemetry; a missing file keeps its historical read-as-0 behavior.
  const sliceHighUnbounded = sliceHighRaw !== null && sliceHighRaw.trim() === 'max';
  const sliceHigh = sliceHighUnbounded ? Number.POSITIVE_INFINITY : Number(sliceHighRaw);
  const leafCur = Number(read(`${leafDir}/memory.current`));
  const inputs = { mem, some, full, ioFull, load, sliceCur, leafCur, ...oom };
  if (!sliceHighUnbounded) inputs.sliceHigh = sliceHigh;
  const unreadable = Object.entries(inputs).filter(([, v]) => v === null || (typeof v === 'number' && !Number.isFinite(v))).map(([k]) => k);
  if (unreadable.length > 0 && !earlyExit) throw new Error(`monitor telemetry unreadable: ${unreadable.join(',')}`);
  if (Number.isFinite(leafCur)) leafPeak = Math.max(leafPeak, leafCur);
  if (Number.isFinite(sliceCur)) slicePeak = Math.max(slicePeak, sliceCur);
  // Deadline (systemd RuntimeMaxSec is the second layer, not the only one).
  if (now > deadlineMs) return { outcome: 'timeout', detail: `deadline ${lease.timeoutSec}s exceeded` };
  // Emergency: act on a single sample.
  if (mem !== null && mem < EMERG_MEM_BYTES) return { outcome: 'emergency-stop', detail: `MemAvailable ${mem} < ${EMERG_MEM_BYTES}` };
  for (const key of ['global', 'userSlice', 'researchSlice']) {
    if (typeof oom[key] === 'number' && typeof launchOom[key] === 'number' && oom[key] > launchOom[key]) {
      return { outcome: 'emergency-stop', detail: `new OOM kills at ${key} (${launchOom[key]} -> ${oom[key]})` };
    }
  }
  const health = checkHealth(lease.healthFile, lease.healthMaxAgeSec);
  if (!health.ok && health.kind === 'failing') return { outcome: 'emergency-stop', detail: `production health: ${health.detail}` };
  if (!health.ok) throw new Error(`monitor telemetry unreadable: ${health.detail}`);
  // Graceful: two consecutive samples (or 30s persistence for CPU).
  consecutiveLowMem = mem !== null && mem < GRACE.memBytes ? consecutiveLowMem + 1 : 0;
  const psiHot = some >= GRACE.psiMemSome || full >= GRACE.psiMemFull || ioFull >= GRACE.psiIoFull;
  consecutivePsi = psiHot ? consecutivePsi + 1 : 0;
  consecutiveHigh = sliceCur > sliceHigh ? consecutiveHigh + 1 : 0;
  if (consecutiveLowMem >= 2) return { outcome: 'resource-stop', detail: `MemAvailable < ${GRACE.memBytes} twice` };
  if (consecutivePsi >= 2) return { outcome: 'resource-stop', detail: 'PSI over admission boundary twice' };
  if (consecutiveHigh >= 2) return { outcome: 'resource-stop', detail: 'aggregate over high watermark twice' };
  let cpuHot = load !== null && load >= GRACE.load1;
  if (cpu && lastCpu && cpu.total > lastCpu.total) {
    const busy = ((cpu.busy - lastCpu.busy) / (cpu.total - lastCpu.total)) * 100;
    const steal = ((cpu.steal - lastCpu.steal) / (cpu.total - lastCpu.total)) * 100;
    cpuHot = cpuHot || busy >= GRACE.cpuBusy || steal >= GRACE.cpuSteal;
  }
  if (cpu) lastCpu = cpu;
  if (cpuHot) {
    cpuHotSince = cpuHotSince ?? now;
    if (now - cpuHotSince >= GRACE.cpuPersistSec * 1000) {
      return { outcome: 'resource-stop', detail: `CPU hot for ${GRACE.cpuPersistSec}s (busy>=${GRACE.cpuBusy}% or steal>=${GRACE.cpuSteal}% or load>=${GRACE.load1})` };
    }
  } else {
    cpuHotSince = null;
  }
  return null;
}

let result = earlyExit;
if (!result) {
  for (;;) {
    const raced = await Promise.race([childExit.then((e) => ({ ...e, exited: true })), sleep(sampleSec * 1000).then(() => ({ exited: false }))]);
    if (raced.exited) {
      result = raced;
      break;
    }
    samples += 1;
    try {
      stopRequest = stopRequest ?? (await sample());
    } catch (error) {
      log({ event: 'monitor-failed', detail: error.message });
      stopRequest = { outcome: 'monitor-failed', detail: error.message, monitorBlock: true };
    }
    if (Date.now() - lastSummary >= SUMMARY_EVERY_SEC * 1000) {
      lastSummary = Date.now();
      const mem = memAvailableBytes();
      log({ event: 'summary', samples, memAvailable: mem, leafPeak, slicePeak });
    }
    if (stopRequest) {
      log({ event: 'stop', ...stopRequest });
      stopUnit(lease.unit);
      result = await childExit;
      result.stopped = stopRequest;
      break;
    }
  }
}

// 8. Owned cleanup on every path (never broad-kill, never auto-restart).
const q = await unitQuiesced(lease.unit, leafDir);
// 7b. Timeout origin for a child exit with no supervisor stop decision.
// systemd unit Result is the single authoritative source: 'timeout' proves
// the RuntimeMaxSec second layer fired. No wall-clock inference — an
// ordinary exit keeps its original status, and unreadable evidence is
// recorded explicitly as unknown, never inferred either way.
let systemdTimeout = false;
let originEvidence;
if (!result.launchFailed && !result.stopped) {
  const unitResult = unitShow(lease.unit, ['Result'])?.Result ?? null;
  if (unitResult === 'timeout') {
    systemdTimeout = true;
  } else if (unitResult === null) {
    originEvidence = 'unknown';
    if (Date.now() > deadlineMs) log({ event: 'timeout-origin-unknown', code: result.code, signal: result.signal });
  }
}
let outcome = result.launchFailed ? 'launch-failed' : (result.stopped?.outcome ?? (systemdTimeout ? 'timeout' : 'completed'));
let detail = result.launchFailed
  ? `leaf failed to start (${stderrHead.split('\n')[0]}; see journalctl --user -u ${lease.unit})`
  : (result.stopped?.detail ?? (systemdTimeout
    ? `deadline ${lease.timeoutSec}s exceeded (systemd unit Result=timeout; child exit ${result.code} signal ${result.signal})`
    : `exit ${result.code} signal ${result.signal}`));
const timeoutOrigin = outcome === 'timeout' ? (result.stopped ? 'supervisor-sample' : 'systemd-result') : undefined;
if (!q.quiesced) {
  writeMonitorBlock(`unit ${lease.unit} left survivors after stop: ${q.survivors.join(',')} (operator must clear; no broad kill performed)`);
  outcome = 'cleanup-survivors';
  detail = `surviving PIDs ${q.survivors.join(',')}`;
  log({ event: 'cleanup-survivors', survivors: q.survivors });
} else if (stopRequest?.monitorBlock || outcome === 'monitor-failed') {
  writeMonitorBlock(`monitor failure during ${lease.id}: ${detail} (investigate, then remove this file explicitly)`);
}
releaseLease({ outcome, detail, exitCode: result.code, signal: result.signal ?? null, timeoutOrigin, originEvidence, samples, leafPeakBytes: leafPeak, slicePeakBytes: slicePeak, membersVerified, readbackVerified });
log({ event: 'released', outcome, exitCode: result.code, timeoutOrigin, originEvidence });
console.log(JSON.stringify({ launch: outcome === 'completed' ? 'done' : 'stopped', id: lease.id, outcome, detail, exitCode: result.code, signal: result.signal ?? null, timeoutOrigin, originEvidence }, null, 2));
if (outcome === 'completed') process.exit(result.code ?? 1);
if (outcome === 'timeout') process.exit(124);
process.exit(2);
