#!/usr/bin/env node
// A0 host admission preflight. Dependency-free: only node builtins, read-only
// inspection plus an optional receipt write. Exit 0 = admit, 1 = block (with
// reasons), 2 = preflight error. Enforcement state and host state are reported
// separately; either can block. Never substitutes zero for missing counters.
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'window-sec': { type: 'string', default: '60' },
    'interval-sec': { type: 'string', default: '5' },
    'planned-bytes': { type: 'string', default: '0' },
    'declared-peak-bytes': { type: 'string', default: '805306368' },
    'baseline-file': { type: 'string', default: '.artifacts/a0-leases/oom-baseline.json' },
    write: { type: 'string' },
  },
});
const windowSec = Number(values['window-sec']);
const intervalSec = Number(values['interval-sec']);
const plannedBytes = BigInt(values['planned-bytes'] ?? '0');
const declaredPeak = Number(values['declared-peak-bytes']);
if (!Number.isInteger(windowSec) || windowSec < 5) fail('window-sec must be an integer >= 5');
if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > windowSec) fail('interval-sec invalid');

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
const GiB = 1024 ** 3;

function memAvailableBytes() {
  const match = read('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+) kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}
function loadAvg1() {
  const text = read('/proc/loadavg');
  return text ? Number(text.split(' ')[0]) : null;
}
function psiAvg10(path, field) {
  // e.g. "some avg10=0.00 avg60=... avg300=... total=..."
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
function sliceDir() {
  const uid = process.getuid?.() ?? 1001;
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/aldresearch.slice`;
}
function cgNumber(path) {
  const text = read(path)?.trim();
  if (text === null || text === undefined || text === 'max') return text === 'max' ? null : null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function oomKills(cgroupPath) {
  const match = read(join(cgroupPath, 'memory.events'))?.match(/^oom_kill (\d+)$/m);
  return match ? Number(match[1]) : null;
}

const uid = process.getuid?.() ?? 1001;
const userSlice = `/sys/fs/cgroup/user.slice/user-${uid}.slice`;
const dir = sliceDir();

// --- enforcement state (read back effective limits, never assume) ---
const enforcement = { slicePresent: read(join(dir, 'cgroup.controllers')) !== null };
if (enforcement.slicePresent) {
  enforcement.cpuMax = read(join(dir, 'cpu.max'))?.trim() ?? null;
  enforcement.cpuWeight = read(join(dir, 'cpu.weight'))?.trim() ?? null;
  enforcement.memoryHigh = cgNumber(join(dir, 'memory.high'));
  enforcement.memoryMax = read(join(dir, 'memory.max'))?.trim() ?? null;
  enforcement.memorySwapMax = read(join(dir, 'memory.swap.max'))?.trim() ?? null;
  enforcement.tasksMax = read(join(dir, 'pids.max'))?.trim() ?? null;
  enforcement.ioDelegated = (read(join(userSlice, 'cgroup.controllers')) ?? '').split(' ').includes('io');
  enforcement.ioMax = read(join(dir, 'io.max'));
}
const reasons = [];
if (!enforcement.slicePresent) reasons.push('enforcement: aldresearch.slice absent (install per deploy/a0/README.md)');

// --- host-state sampling window ---
const samples = Math.max(1, Math.round(windowSec / intervalSec));
let cpuBusyWorst = 0;
let cpuStealWorst = 0;
let loadWorst = 0;
for (let i = 0; i < samples; i++) {
  const a = cpuSample();
  await sleep(Math.min(intervalSec, 2) * 1000);
  const b = cpuSample();
  if (a && b && b.total > a.total) {
    cpuBusyWorst = Math.max(cpuBusyWorst, ((b.busy - a.busy) / (b.total - a.total)) * 100);
    cpuStealWorst = Math.max(cpuStealWorst, ((b.steal - a.steal) / (b.total - a.total)) * 100);
  }
  const load = loadAvg1();
  if (load !== null) loadWorst = Math.max(loadWorst, load);
  const remaining = intervalSec * 1000 - Math.min(intervalSec, 2) * 1000;
  if (i < samples - 1 && remaining > 0) await sleep(remaining);
}

// --- checks ---
const A = memAvailableBytes();
const charge = enforcement.slicePresent ? cgNumber(join(dir, 'memory.current')) : null;
const cap = 2 * GiB;
if (A === null) reasons.push('memory: MemAvailable unreadable');
else if (charge === null) reasons.push('memory: aggregate research charge unreadable (no containment)');
else if (A - Math.max(0, cap - charge) < 2 * GiB) {
  reasons.push(`memory: headroom check fails (avail=${A}, charge=${charge}, cap=${cap})`);
}
const high = enforcement.memoryHigh ?? null;
if (high !== null && charge !== null && charge + 1.5 * declaredPeak > high) {
  reasons.push(`memory: declared workload (peak=${declaredPeak}, 1.5x allowance) does not fit below high watermark (charge=${charge}, high=${high})`);
}
if (cpuBusyWorst >= 60) reasons.push(`cpu: busy worst ${cpuBusyWorst.toFixed(1)}% >= 60%`);
if (cpuStealWorst >= 10) reasons.push(`cpu: steal worst ${cpuStealWorst.toFixed(1)}% >= 10%`);
if (loadWorst >= 3) reasons.push(`cpu: loadavg worst ${loadWorst} >= 3`);
const memSome = psiAvg10('/proc/pressure/memory', 'some');
const memFull = psiAvg10('/proc/pressure/memory', 'full');
const ioFull = psiAvg10('/proc/pressure/io', 'full');
if (memSome === null || memFull === null || ioFull === null) reasons.push('pressure: PSI counters unreadable (never zero-filled)');
else {
  if (memSome >= 5) reasons.push(`pressure: memory some avg10 ${memSome} >= 5%`);
  if (memFull >= 1) reasons.push(`pressure: memory full avg10 ${memFull} >= 1%`);
  if (ioFull >= 5) reasons.push(`pressure: io full avg10 ${ioFull} >= 5%`);
}
try {
  const st = statfsSync(process.cwd());
  const free = Number(st.bfree) * Number(st.bsize);
  const total = Number(st.blocks) * Number(st.bsize);
  const need = Math.max(10 * GiB, total * 0.1);
  if (free - Number(plannedBytes) < need) reasons.push(`storage: free ${free} minus planned ${plannedBytes} below reserve ${need}`);
} catch {
  reasons.push('storage: statfs unreadable');
}
// Recovery: oom_kill deltas against the stored baseline. No journal access to
// system OOM entries from this user (verified); report that gap explicitly.
const counters = {
  root: oomKills('/sys/fs/cgroup'),
  userSlice: oomKills(userSlice),
  researchSlice: enforcement.slicePresent ? oomKills(dir) : null,
  at: new Date().toISOString(),
};
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(values['baseline-file'], 'utf8'));
} catch {
  baseline = null;
}
if (baseline) {
  for (const key of ['root', 'userSlice', 'researchSlice']) {
    if (typeof baseline[key] === 'number' && typeof counters[key] === 'number' && counters[key] > baseline[key]) {
      reasons.push(`recovery: new OOM kills at ${key} (${baseline[key]} -> ${counters[key]}); reconcile before admission`);
    }
  }
}
const receipt = {
  admission: reasons.length === 0 ? 'admit' : 'block',
  reasons,
  at: counters.at,
  enforcement,
  host: { memAvailableBytes: A, researchChargeBytes: charge, cpuBusyWorstPct: cpuBusyWorst, cpuStealWorstPct: cpuStealWorst, loadWorst, psi: { memSomeAvg10: memSome, memFullAvg10: memFull, ioFullAvg10: ioFull } },
  oom: { counters, baselineCompared: baseline !== null, journalGap: 'kernel OOM journal unreadable by this user; slice/user/root memory.events deltas only' },
  windowSec,
  intervalSec,
};
try {
  const { at, ...rest } = counters;
  mkdirSync(values['baseline-file'].split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(values['baseline-file'], `${JSON.stringify({ ...rest, at }, null, 2)}\n`);
} catch (error) {
  fail(`cannot persist OOM baseline: ${error.message}`);
}
if (values.write) {
  writeFileSync(values.write, `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
process.exit(reasons.length === 0 ? 0 : 1);
