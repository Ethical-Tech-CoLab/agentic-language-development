#!/usr/bin/env node
// A0 host admission preflight. Dependency-free: node builtins only, read-only
// inspection plus receipt/baseline/history writes under .artifacts/.
// Exit 0 = admit, 1 = block/diagnostic (with reasons), 2 = preflight error.
// Policy: plans/research-validation-plan.md section 6, Resource policy revision 5 (POLICY_REV).
// Windows shorter than 60s/5s are diagnostic-only and can never admit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { headroomVerdict, highWatermarkVerdict } from './a0-headroom.mjs';

const POLICY_REV = 5;
const POLICY_WINDOW_SEC = 60;
const POLICY_INTERVAL_SEC = 5;
const POLICY_CPU = { busyPct: 60, stealPct: 10, load1: 3 };
const POLICY_PSI = { memSome: 5, memFull: 1, ioFull: 5 };
const POLICY_STORAGE_RESERVE = { bytes: 10 * 1024 ** 3, frac: 0.1 };
const POLICY_MEM_FLOOR = 2 * 1024 ** 3;
const POLICY_PEAK_ALLOWANCE = 1.5;
const POLICY_OOM_QUIET_SEC = 600;
const POLICY_HEALTH_MAX_AGE_SEC = 300;
// Effective cgroup v2 values expected from deploy/a0/aldresearch.slice.
// Revision 5: agent caps are retired (prompt-level discipline only). The
// aggregate slice is observed, never limit-compared; per-job scopes created
// at launch carry the explicit bounds instead (see scripts/a0-lease.mjs).
const OBSERVED_SLICE_FILES = ['cpu.max', 'cpu.weight', 'memory.high', 'memory.max', 'memory.swap.max', 'pids.max'];
const POLICY_NICE = 15;

function fail(message) {
  console.error(JSON.stringify({ admission: 'error', reason: message }));
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const ensureParent = (file) => {
  const dir = file.split('/').slice(0, -1).join('/') || '.';
  mkdirSync(dir, { recursive: true });
};

let values;
try {
  values = parseArgs({
    options: {
      'window-sec': { type: 'string', default: String(POLICY_WINDOW_SEC) },
      'interval-sec': { type: 'string', default: String(POLICY_INTERVAL_SEC) },
      'planned-bytes': { type: 'string', default: '0' },
      'declared-peak-bytes': { type: 'string', default: '805306368' },
      'data-path': { type: 'string', default: process.cwd() },
      'disk-heavy': { type: 'string', default: 'no' },
      task: { type: 'string', default: '' },
      command: { type: 'string', default: '' },
      source: { type: 'string' },
      'health-file': { type: 'string' },
      'health-max-age-sec': { type: 'string', default: String(POLICY_HEALTH_MAX_AGE_SEC) },
      'baseline-file': { type: 'string', default: '.artifacts/a0-leases/oom-baseline.json' },
      'history-file': { type: 'string', default: '.artifacts/a0-leases/oom-history.jsonl' },
      'incident-file': { type: 'string', default: '.artifacts/a0-leases/oom-incident.json' },
      'monitor-block-file': { type: 'string', default: '.artifacts/a0-leases/monitor-block.json' },
      'lease-file': { type: 'string', default: '.artifacts/a0-leases/active.json' },
      'reconcile-oom': { type: 'string' },
      reason: { type: 'string', default: '' },
      write: { type: 'string' },
    },
  }).values;
} catch {
  fail('usage: node scripts/a0-preflight.mjs [--window-sec N] [--interval-sec N] [--planned-bytes N] [--declared-peak-bytes N] [--data-path P] [--disk-heavy yes|no] [--task T] [--command C] [--source S] [--health-file F] [--write R] [--reconcile-oom ID --reason R]');
}
const windowSec = Number(values['window-sec']);
const intervalSec = Number(values['interval-sec']);
if (!Number.isInteger(windowSec) || windowSec < 5) fail('window-sec must be an integer >= 5');
if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > windowSec) fail('interval-sec invalid');
if (!/^\d+$/.test(values['planned-bytes'] ?? '')) fail('planned-bytes must be a non-negative integer');
const plannedBytes = BigInt(values['planned-bytes']);
const declaredPeak = Number(values['declared-peak-bytes']);
if (!Number.isFinite(declaredPeak) || declaredPeak < 0) fail('declared-peak-bytes must be finite and >= 0');
if (!['yes', 'no'].includes(values['disk-heavy'])) fail('disk-heavy must be yes or no');
const diskHeavy = values['disk-heavy'] === 'yes';
const healthMaxAgeSec = Number(values['health-max-age-sec']);
if (!Number.isInteger(healthMaxAgeSec) || healthMaxAgeSec < 1) fail('health-max-age-sec must be a positive integer');
const diagnostic = windowSec !== POLICY_WINDOW_SEC || intervalSec !== POLICY_INTERVAL_SEC;

const uid = process.getuid?.() ?? 1001;
const userSlice = `/sys/fs/cgroup/user.slice/user-${uid}.slice`;
const dir = `${userSlice}/user@${uid}.service/aldresearch.slice`;

function memAvailableBytes() {
  const match = read('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+) kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}
function loadAvg1() {
  const text = read('/proc/loadavg');
  if (!text) return null;
  const n = Number(text.split(' ')[0]);
  return Number.isFinite(n) ? n : null;
}
function psiAvg10(path, field) {
  const line = read(path)?.split('\n').find((l) => l.startsWith(field));
  const match = line?.match(/avg10=(\d+\.\d+)/);
  return match ? Number(match[1]) : null;
}
function cpuSample() {
  // user nice system idle iowait irq softirq steal guest guest_nice
  const parts = read('/proc/stat')?.split('\n')[0]?.split(/\s+/).slice(1).map(Number);
  if (!parts || parts.length < 8 || parts.some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, steal, total };
}
function cgText(path) {
  return read(path)?.trim() ?? null;
}
function cgNumber(path) {
  const text = cgText(path);
  if (text === null || text === 'max') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function oomKills(cgroupPath) {
  const match = read(`${cgroupPath}/memory.events`)?.match(/^oom_kill (\d+)$/m);
  return match ? Number(match[1]) : null;
}
function globalOomKills() {
  // The root cgroup exposes no memory.events here; /proc/vmstat oom_kill is
  // the world-readable global counter (includes all slices, incl. production).
  const match = read('/proc/vmstat')?.match(/^oom_kill (\d+)$/m);
  return match ? Number(match[1]) : null;
}
function procStat(pid) {
  // comm may contain spaces/parens: fields after the last ')'.
  const text = read(`/proc/${pid}/stat`);
  if (!text) return null;
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const nice = Number(rest[16]);
  const starttime = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (![nice, starttime, rssPages].every(Number.isFinite)) return null;
  return { nice, starttime, rssPages };
}
function procRssBytes(pid) {
  const match = read(`/proc/${pid}/status`)?.match(/^VmRSS:\s+(\d+) kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}
function procCgroup(pid) {
  return read(`/proc/${pid}/cgroup`)?.trim() ?? null;
}
function procInSlice(pid) {
  const text = procCgroup(pid);
  return text !== null && (text.includes('/aldresearch.slice/') || text.endsWith('/aldresearch.slice'));
}
function procComm(pid) {
  return read(`/proc/${pid}/comm`)?.trim() ?? '?';
}
function sliceMembers() {
  // Walk the slice subtree; every directory may carry cgroup.procs.
  const members = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return { error: `cannot list ${current} (unit churn during enumeration?)` };
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(`${current}/${entry.name}`);
    }
    const procs = read(`${current}/cgroup.procs`);
    if (procs === null) return { error: `cannot read ${current}/cgroup.procs` };
    for (const pid of procs.split('\n').filter(Boolean)) {
      members.push({ pid: Number(pid), unit: current.slice(dir.length + 1) || '(slice root)' });
    }
  }
  return { members };
}
function deviceFor(path) {
  // Resolve the backing device (MAJ:MIN) via /proc/self/mountinfo so the I/O
  // binding names the job filesystem's real device. Unresolvable -> null
  // (fail closed for disk-heavy work, harmless otherwise).
  const text = read('/proc/self/mountinfo');
  if (!text) return null;
  const abs = resolve(path);
  let best = null;
  for (const line of text.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 10) continue;
    const mountPoint = parts[4].replace(/\\040/g, ' ');
    const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
    if ((abs === mountPoint || abs.startsWith(prefix)) && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, device: parts[2] };
    }
  }
  return best?.device ?? null;
}
function autoSource() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- reconcile mode (explicit OOM incident acknowledgment, never admission) ---
if (values['reconcile-oom']) {
  const id = values['reconcile-oom'];
  if (!values.reason) fail('reconcile-oom requires --reason');
  let incident;
  try {
    incident = JSON.parse(readFileSync(values['incident-file'], 'utf8'));
  } catch {
    fail(`no incident record at ${values['incident-file']}`);
  }
  if (incident.id !== id) fail(`incident id mismatch (record holds ${incident.id})`);
  if (incident.reconciled) fail(`incident ${id} already reconciled at ${incident.reconciled.at}`);
  const counters = { global: globalOomKills(), userSlice: oomKills(userSlice), researchSlice: oomKills(dir) };
  for (const key of ['global', 'userSlice', 'researchSlice']) {
    if (typeof counters[key] !== 'number') fail(`OOM counter ${key} unreadable; cannot reconcile`);
    if (counters[key] !== incident.counters[key]) {
      fail(`new OOM kills at ${key} since incident (${incident.counters[key]} -> ${counters[key]}); cannot reconcile`);
    }
  }
  incident.reconciled = { at: new Date().toISOString(), reason: values.reason, by: `${process.getuid?.() ?? '?'}:${process.pid}` };
  ensureParent(values['incident-file']);
  writeFileSync(values['incident-file'], `${JSON.stringify(incident, null, 2)}\n`);
  ensureParent(values['baseline-file']);
  writeFileSync(values['baseline-file'], `${JSON.stringify({ ...counters, at: incident.reconciled.at }, null, 2)}\n`);
  ensureParent(values['history-file']);
  writeFileSync(values['history-file'], `${JSON.stringify({ at: incident.reconciled.at, ...counters })}\n`, { flag: 'a' });
  console.log(JSON.stringify({ reconciled: id, at: incident.reconciled.at, note: 'incident acknowledged; a fresh full preflight is still required for admission' }));
  process.exit(0);
}

// --- enforcement state (effective values compared with policy, never assumed) ---
const source = values.source ?? autoSource();
const reasons = [];
const enforcement = { policyRev: POLICY_REV, agentCapsEnforced: false, slicePresent: cgText(`${dir}/cgroup.controllers`) !== null };
if (!enforcement.slicePresent) {
  reasons.push('enforcement: aldresearch.slice absent (accounting group unreadable)');
} else {
  enforcement.limits = {};
  for (const file of OBSERVED_SLICE_FILES) {
    enforcement.limits[file] = { effective: cgText(`${dir}/${file}`) };
  }
  enforcement.ioDelegated = (cgText(`${userSlice}/cgroup.controllers`) ?? '').split(' ').includes('io');
  enforcement.ioMax = cgText(`${dir}/io.max`);
  enforcement.ioSupported = enforcement.ioDelegated && enforcement.ioMax !== null;
  // Membership + nice: advisory observation only. Lead properties never gate
  // admission (rev5); per-job members below keep their binding checks.
  const walk = sliceMembers();
  if (walk.error) {
    reasons.push(`enforcement: ${walk.error}`);
    enforcement.members = null;
  } else {
    enforcement.members = [];
    enforcement.leadNiceAdvisory = [];
    for (const { pid, unit } of walk.members) {
      const stat = procStat(pid);
      if (!stat) {
        enforcement.members.push({ pid, unit, note: 'vanished during enumeration' });
        continue;
      }
      enforcement.members.push({ pid, unit, nice: stat.nice, starttime: stat.starttime, comm: procComm(pid) });
      if (stat.nice !== POLICY_NICE) {
        enforcement.leadNiceAdvisory.push(`member ${pid} (${procComm(pid)}, ${unit}) nice ${stat.nice} != courteous ${POLICY_NICE}`);
      }
    }
  }
}
// Lease-recorded residents: identity, membership, nice. Corrupt lease state is
// an error, not a measurement.
let lease = null;
let uncappedRss = 0;
enforcement.leaseMembers = null;
const leaseText = read(values['lease-file']);
if (leaseText !== null) {
  try {
    lease = JSON.parse(leaseText);
  } catch {
    fail(`lease state at ${values['lease-file']} is corrupt; operator inspection required (never auto-deleted)`);
  }
  const need = ['id', 'unit', 'owner', 'task', 'command', 'source', 'timeoutSec', 'declaredPeakBytes', 'status'];
  const missing = need.filter((k) => lease[k] === undefined || lease[k] === null || lease[k] === '');
  if (missing.length > 0) fail(`lease state invalid (missing ${missing.join(', ')}); operator inspection required`);
  enforcement.leaseMembers = [];
  for (const member of lease.members ?? []) {
    const stat = procStat(member.pid);
    const entry = { pid: member.pid, role: member.role, alive: stat !== null };
    if (!stat) {
      entry.note = 'exited since launch';
      enforcement.leaseMembers.push(entry);
      continue;
    }
    entry.starttime = stat.starttime;
    entry.nice = stat.nice;
    if (stat.starttime !== member.starttime) {
      reasons.push(`enforcement: lease member ${member.pid} (${member.role}) identity mismatch (PID reuse?); expected starttime ${member.starttime}`);
    }
    if (stat.nice !== POLICY_NICE) {
      reasons.push(`enforcement: lease member ${member.pid} (${member.role}) nice ${stat.nice} != policy ${POLICY_NICE}`);
    }
    const cgroup = procCgroup(member.pid);
    if (member.role === 'payload') {
      if (cgroup === null || !cgroup.includes(`/${lease.unit}`)) {
        const rss = procRssBytes(member.pid);
        entry.outsideLeaf = true;
        entry.rssBytes = rss;
        if (rss !== null) uncappedRss += rss;
        reasons.push(`enforcement: lease payload ${member.pid} escaped the job leaf ${lease.unit}`);
      }
    } else if (member.role === 'launcher') {
      // The supervisor stays outside the job leaf by design (and outside the
      // aggregate: the kernel forbids non-leaf -> descendant migration, so a
      // launcher inside the slice cannot start a leaf beneath it). Its RSS
      // counts once when outside the slice; inside it is already charged.
      if (cgroup !== null && cgroup.includes(`/${lease.unit}`)) {
        reasons.push(`enforcement: launcher ${member.pid} is inside the job leaf it supervises`);
      } else if (!procInSlice(member.pid)) {
        const rss = procRssBytes(member.pid);
        entry.outsideSlice = true;
        entry.rssBytes = rss;
        if (rss !== null) uncappedRss += rss;
      } else {
        entry.note = 'inside aggregate (already charged)';
      }
    } else {
      reasons.push(`enforcement: lease member ${member.pid} has unknown role ${JSON.stringify(member.role)}`);
    }
    enforcement.leaseMembers.push(entry);
  }
}
enforcement.uncappedRssBytes = uncappedRss;
enforcement.unregisteredNote = 'out-of-slice in-scope processes not recorded in the lease are invisible to accounting; containment of leads is proven by slice membership, not by this receipt';

// --- host-state sampling window (every required reading at every sample) ---
const samples = Math.max(1, Math.round(windowSec / intervalSec));
const t0 = Date.now();
let cpuBusyWorst = null;
let cpuStealWorst = null;
let loadWorst = null;
let memWorst = null;
let psiMemSomeWorst = null;
let psiMemFullWorst = null;
let psiIoFullWorst = null;
const valid = { cpu: 0, load: 0, mem: 0, psi: 0 };
for (let i = 0; i < samples; i++) {
  const a = cpuSample();
  await sleep(Math.min(intervalSec, 2) * 1000);
  const b = cpuSample();
  if (a && b && b.total > a.total) {
    const busy = ((b.busy - a.busy) / (b.total - a.total)) * 100;
    const steal = ((b.steal - a.steal) / (b.total - a.total)) * 100;
    cpuBusyWorst = cpuBusyWorst === null ? busy : Math.max(cpuBusyWorst, busy);
    cpuStealWorst = cpuStealWorst === null ? steal : Math.max(cpuStealWorst, steal);
    valid.cpu += 1;
  }
  const load = loadAvg1();
  if (load !== null) {
    loadWorst = loadWorst === null ? load : Math.max(loadWorst, load);
    valid.load += 1;
  }
  const mem = memAvailableBytes();
  if (mem !== null) {
    memWorst = memWorst === null ? mem : Math.min(memWorst, mem);
    valid.mem += 1;
  }
  const some = psiAvg10('/proc/pressure/memory', 'some');
  const full = psiAvg10('/proc/pressure/memory', 'full');
  const ioFull = psiAvg10('/proc/pressure/io', 'full');
  if (some !== null && full !== null && ioFull !== null) {
    psiMemSomeWorst = psiMemSomeWorst === null ? some : Math.max(psiMemSomeWorst, some);
    psiMemFullWorst = psiMemFullWorst === null ? full : Math.max(psiMemFullWorst, full);
    psiIoFullWorst = psiIoFullWorst === null ? ioFull : Math.max(psiIoFullWorst, ioFull);
    valid.psi += 1;
  }
  const remaining = intervalSec * 1000 - Math.min(intervalSec, 2) * 1000;
  if (i < samples - 1 && remaining > 0) await sleep(remaining);
}
// Fill the window: the last sample has no trailing sleep by construction, so
// top up to the full elapsed window. The check below stays as a backstop
// against clock/scheduler anomalies (fail closed).
{
  const shortfall = windowSec * 1000 - (Date.now() - t0);
  if (shortfall > 0) await sleep(shortfall);
}
const elapsedSec = (Date.now() - t0) / 1000;
if (diagnostic) {
  reasons.push(`window: diagnostic-only probe (${windowSec}s/${intervalSec}s); policy requires ${POLICY_WINDOW_SEC}s/${POLICY_INTERVAL_SEC}s for admission`);
} else if (elapsedSec < windowSec) {
  reasons.push(`window: elapsed ${elapsedSec.toFixed(1)}s < required ${windowSec}s (timer shortfall)`);
}
for (const [metric, count] of Object.entries(valid)) {
  if (count < samples) reasons.push(`sampling: ${metric} valid ${count}/${samples} readings (missing readings fail closed)`);
}

// --- checks ---
const charge = enforcement.slicePresent ? cgNumber(`${dir}/memory.current`) : null;
const researchCapRaw = enforcement.slicePresent ? cgText(`${dir}/memory.max`) : null;
const researchCapUnbounded = researchCapRaw !== null && researchCapRaw.trim() === 'max';
const researchCap = researchCapUnbounded || researchCapRaw === null ? null : cgNumber(`${dir}/memory.max`);
// Headroom verdict lives in ./a0-headroom.mjs so the occupancy-vs-growth
// boundary is unit-testable; the receipt records the returned reason verbatim.
const headroom = headroomVerdict({ memWorst, charge, uncappedRss, researchCap, researchCapUnbounded, declaredPeak });
if (!headroom.admitted) reasons.push(headroom.reason);
const highRaw = enforcement.slicePresent ? cgText(`${dir}/memory.high`) : null;
const highUnbounded = highRaw !== null && highRaw.trim() === 'max';
const high = highUnbounded || highRaw === null ? null : cgNumber(`${dir}/memory.high`);
// Unbounded high (rev5: no cap installed) skips the fit check; a missing or
// malformed high refuses. Ungated on charge: charge problems already refuse.
if (charge !== null && !highUnbounded) {
  const highCheck = highWatermarkVerdict({ high, charge, uncappedRss, declaredPeak });
  if (!highCheck.admitted) reasons.push(highCheck.reason);
}
if (cpuBusyWorst !== null && cpuBusyWorst >= POLICY_CPU.busyPct) {
  reasons.push(`cpu: busy worst ${cpuBusyWorst.toFixed(1)}% >= ${POLICY_CPU.busyPct}%`);
}
if (cpuStealWorst !== null && cpuStealWorst >= POLICY_CPU.stealPct) {
  reasons.push(`cpu: steal worst ${cpuStealWorst.toFixed(1)}% >= ${POLICY_CPU.stealPct}%`);
}
if (loadWorst !== null && loadWorst >= POLICY_CPU.load1) {
  reasons.push(`cpu: loadavg worst ${loadWorst} >= ${POLICY_CPU.load1}`);
}
if (psiMemSomeWorst === null || psiMemFullWorst === null || psiIoFullWorst === null) {
  reasons.push('pressure: PSI counters unreadable (never zero-filled)');
} else {
  if (psiMemSomeWorst >= POLICY_PSI.memSome) reasons.push(`pressure: memory some avg10 ${psiMemSomeWorst} >= ${POLICY_PSI.memSome}%`);
  if (psiMemFullWorst >= POLICY_PSI.memFull) reasons.push(`pressure: memory full avg10 ${psiMemFullWorst} >= ${POLICY_PSI.memFull}%`);
  if (psiIoFullWorst >= POLICY_PSI.ioFull) reasons.push(`pressure: io full avg10 ${psiIoFullWorst} >= ${POLICY_PSI.ioFull}%`);
}
// Storage: available-to-user capacity on the job filesystem + device binding.
let storage = null;
try {
  const st = statfsSync(values['data-path']);
  const avail = Number(st.bavail) * Number(st.bsize);
  const total = Number(st.blocks) * Number(st.bsize);
  const device = deviceFor(values['data-path']);
  storage = { path: values['data-path'], availBytes: avail, totalBytes: total, device };
  if (![avail, total].every(Number.isFinite) || avail < 0 || total <= 0) {
    reasons.push('storage: filesystem capacity unreadable');
  } else {
    const need = Math.max(POLICY_STORAGE_RESERVE.bytes, total * POLICY_STORAGE_RESERVE.frac);
    if (BigInt(Math.floor(avail)) - plannedBytes < BigInt(Math.floor(need))) {
      reasons.push(`storage: avail ${avail} minus planned ${plannedBytes} below reserve ${need}`);
    }
  }
} catch {
  reasons.push(`storage: cannot stat ${values['data-path']}`);
}
// I/O binding: missing controls block disk-heavy work, never permit it.
const ioReady = enforcement.ioSupported === true && (enforcement.ioMax ?? '').split('\n').some((l) => l.startsWith(`${storage?.device ?? '?'} `));
if (diskHeavy && !ioReady) {
  reasons.push('io: disk-heavy task requires delegated io controller with an io.max entry for the job device (disk-heavy stays blocked)');
}
// Production health: read-only operator evidence; unknown blocks admission.
let health = null;
if (!values['health-file']) {
  reasons.push('health: no production-health evidence bound (--health-file); unknown required telemetry blocks admission');
} else {
  try {
    const doc = JSON.parse(readFileSync(values['health-file'], 'utf8'));
    const age = (Date.now() - Date.parse(doc.at)) / 1000;
    health = { file: values['health-file'], healthy: doc.healthy, at: doc.at, source: doc.source, ageSec: age };
    if (doc.healthy !== true) reasons.push(`health: ${values['health-file']} does not report healthy`);
    else if (typeof doc.source !== 'string' || !doc.source) reasons.push(`health: ${values['health-file']} has no source identity`);
    else if (!Number.isFinite(age) || age < 0 || age > healthMaxAgeSec) {
      reasons.push(`health: ${values['health-file']} stale (age ${age}s > ${healthMaxAgeSec}s)`);
    }
  } catch {
    reasons.push(`health: ${values['health-file']} missing or invalid`);
  }
}
// Recovery: baseline deltas + 10-minute quiet history + incident reconciliation.
// Observation and acknowledgment are separate: deltas never rewrite the baseline.
const counters = { global: globalOomKills(), userSlice: oomKills(userSlice), researchSlice: enforcement.slicePresent ? oomKills(dir) : null };
const nowIso = new Date().toISOString();
if (Object.values(counters).some((c) => typeof c !== 'number')) {
  reasons.push('recovery: OOM counters unreadable (need global vmstat plus user-slice and research-slice memory.events)');
}
let incident = null;
try {
  incident = JSON.parse(readFileSync(values['incident-file'], 'utf8'));
} catch {
  incident = null;
}
if (incident && !incident.reconciled) {
  reasons.push(`recovery: unreconciled OOM incident ${incident.id} (first seen ${incident.firstSeen}); reconcile explicitly, then re-run preflight`);
}
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(values['baseline-file'], 'utf8'));
} catch {
  baseline = null;
}
if (!baseline) {
  reasons.push('recovery: no OOM baseline (this run establishes it; admission needs a baseline plus 10 minutes of quiet history)');
} else {
  for (const key of ['global', 'userSlice', 'researchSlice']) {
    if (typeof baseline[key] === 'number' && typeof counters[key] === 'number' && counters[key] > baseline[key]) {
      reasons.push(`recovery: new OOM kills at ${key} (${baseline[key]} -> ${counters[key]}); reconcile before admission`);
      if (!incident || incident.reconciled) {
        incident = { id: `oom-${Date.now().toString(36)}`, firstSeen: nowIso, counters: { ...counters }, reconciled: null };
        ensureParent(values['incident-file']);
        writeFileSync(values['incident-file'], `${JSON.stringify(incident, null, 2)}\n`);
      }
    }
  }
}
// Ten-minute quiet history (append-only JSONL, pruned past two hours).
let historyCoverageSec = 0;
try {
  ensureParent(values['history-file']);
  writeFileSync(values['history-file'], `${JSON.stringify({ at: nowIso, ...counters })}\n`, { flag: 'a' });
  const cutoff = Date.now() - 2 * 3600 * 1000;
  const entries = readFileSync(values['history-file'], 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && Number.isFinite(Date.parse(e.at)));
  const fresh = entries.filter((e) => Date.parse(e.at) >= cutoff);
  if (fresh.length !== entries.length) {
    writeFileSync(values['history-file'], `${fresh.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }
  const floor = [...fresh].reverse().find((e) => Date.parse(e.at) <= Date.now() - POLICY_OOM_QUIET_SEC * 1000);
  if (!floor) {
    reasons.push(`recovery: insufficient OOM history (< ${POLICY_OOM_QUIET_SEC}s coverage; keep probing, do not reset state)`);
  } else {
    historyCoverageSec = (Date.now() - Date.parse(floor.at)) / 1000;
    for (const key of ['global', 'userSlice', 'researchSlice']) {
      if (typeof floor[key] === 'number' && typeof counters[key] === 'number' && counters[key] > floor[key]) {
        reasons.push(`recovery: OOM kills within the last ${POLICY_OOM_QUIET_SEC}s at ${key} (${floor[key]} -> ${counters[key]})`);
      }
    }
  }
} catch (error) {
  fail(`cannot persist OOM history: ${error.message}`);
}
// Rewrite the baseline only when no incident is open; a second probe must not
// erase an unresolved OOM.
if ((!incident || incident.reconciled) && Object.values(counters).every((c) => typeof c === 'number')) {
  try {
    ensureParent(values['baseline-file']);
    writeFileSync(values['baseline-file'], `${JSON.stringify({ ...counters, at: nowIso }, null, 2)}\n`);
  } catch (error) {
    fail(`cannot persist OOM baseline: ${error.message}`);
  }
}
// Monitor-failure marker closes admission until the operator investigates.
const monitorBlock = read(values['monitor-block-file']);
if (monitorBlock !== null) {
  reasons.push(`recovery: monitor-block marker present (${values['monitor-block-file']}); investigate the failed supervision, then remove the file explicitly`);
}

const admission = diagnostic ? 'diagnostic' : reasons.length === 0 ? 'admit' : 'block';
const receipt = {
  admission,
  diagnostic,
  reasons,
  at: nowIso,
  policyRev: POLICY_REV,
  task: values.task,
  command: values.command,
  source,
  declaredPeakBytes: declaredPeak,
  dataPath: values['data-path'],
  diskHeavy,
  healthFile: values['health-file'] ?? null,
  healthMaxAgeSec,
  enforcement,
  host: {
    memAvailableWorstBytes: memWorst,
    researchChargeBytes: charge,
    researchCapBytes: researchCap,
    cpuBusyWorstPct: cpuBusyWorst,
    cpuStealWorstPct: cpuStealWorst,
    loadWorst,
    psi: { memSomeAvg10: psiMemSomeWorst, memFullAvg10: psiMemFullWorst, ioFullAvg10: psiIoFullWorst },
    samplesValid: valid,
    samplesTotal: samples,
  },
  storage,
  io: { ioSupported: enforcement.ioSupported ?? false, ioMax: enforcement.ioMax ?? null, ioReady },
  health,
  oom: {
    counters,
    baselineCompared: baseline !== null,
    historyCoverageSec,
    incident: incident ? { id: incident.id, firstSeen: incident.firstSeen, reconciled: incident.reconciled } : null,
    journalGap: 'kernel OOM journal unreadable by this user; global vmstat plus user-slice/research-slice memory.events deltas only',
  },
  windowSec,
  intervalSec,
  elapsedSec,
};
if (values.write) {
  ensureParent(values.write);
  writeFileSync(values.write, `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
process.exit(admission === 'admit' ? 0 : 1);
