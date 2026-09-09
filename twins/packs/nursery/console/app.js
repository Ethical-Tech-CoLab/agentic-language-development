/* ALD Research Console: researcher routes only; no Baby route is reachable here. */
const RESEARCHER_GET_ROUTES = Object.freeze({
  runs: '/runs',
  run: '/runs/:id',
  transcript: '/runs/:id/transcript',
  ledgers: '/runs/:id/ledgers',
  audit: '/runs/:id/audit',
  checkpoints: '/runs/:id/checkpoints',
  anchors: '/runs/:id/anchors',
  telemetry: '/runs/:id/telemetry',
  verification: '/runs/:id/verification-report',
  replay: '/runs/:id/replay',
  observations: '/runs/:id/observations',
});
const OPERATOR_ROUTES = Object.freeze({
  pause: '/runs/:id/pause',
  resume: '/runs/:id/resume',
  abort: '/runs/:id/abort',
});

const byId = (id) => document.getElementById(id);
const state = { runId: '', loading: false };

function route(template, runId = state.runId) {
  return `${byId('api-base').value.replace(/\/$/u, '')}${template.replace(':id', encodeURIComponent(runId))}`;
}

function headers() {
  return {
    'content-type': 'application/json',
    'x-ald-role': byId('role').value,
    'x-ald-service-token': byId('token').value,
    'x-ald-actor': 'research-console',
  };
}

async function request(template, options = {}) {
  const response = await fetch(route(template, options.runId), {
    method: options.method ?? 'GET',
    headers: headers(),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload;
}

function text(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function renderEvents(elementId, records) {
  const element = byId(elementId);
  element.replaceChildren();
  element.classList.toggle('empty', records.length === 0);
  if (records.length === 0) {
    element.textContent = 'No records.';
    return;
  }
  for (const record of records) {
    const row = document.createElement('div');
    row.className = 'event';
    row.textContent = JSON.stringify(record);
    element.append(row);
  }
}

function renderRun(run) {
  const fields = [
    ['State', run.state],
    ['Turn', run.turn],
    ['Experiment', run.experimentId],
    ['Mode', run.deploymentMode],
    ['Registration', run.registrationClass],
    ['Pre-registration', run.preRegistrationHash],
  ];
  const container = byId('run-state');
  container.replaceChildren();
  for (const [label, value] of fields) {
    const item = document.createElement('div');
    const caption = document.createElement('small');
    const data = document.createElement('strong');
    caption.textContent = label;
    data.textContent = text(value);
    item.append(caption, data);
    container.append(item);
  }
}

async function loadRuns() {
  const payload = await request(RESEARCHER_GET_ROUTES.runs, { runId: '' });
  const select = byId('run-select');
  select.replaceChildren();
  for (const run of payload.runs) {
    const option = document.createElement('option');
    option.value = run.runId;
    option.textContent = `${run.runId} · ${run.state}`;
    select.append(option);
  }
  state.runId = select.value;
  if (state.runId) await refreshRun();
}

async function optional(template) {
  try { return await request(template); } catch { return {}; }
}

async function refreshRun() {
  if (!state.runId || state.loading) return;
  state.loading = true;
  byId('notice').textContent = 'Refreshing authoritative run data…';
  try {
    const [run, transcript, ledgers, checkpoints, anchors, telemetry, verification, replay, observations] =
      await Promise.all([
        request(RESEARCHER_GET_ROUTES.run),
        request(RESEARCHER_GET_ROUTES.transcript),
        request(RESEARCHER_GET_ROUTES.ledgers),
        request(RESEARCHER_GET_ROUTES.checkpoints),
        request(RESEARCHER_GET_ROUTES.anchors),
        request(RESEARCHER_GET_ROUTES.telemetry),
        optional(RESEARCHER_GET_ROUTES.verification),
        request(RESEARCHER_GET_ROUTES.replay),
        optional(RESEARCHER_GET_ROUTES.observations),
      ]);
    renderRun(run.run);
    renderEvents('transcript', transcript.transcript ?? []);
    renderEvents('baby-a-ledger', [
      ...(observations.observations?.['baby-a'] ?? []).map((value) => ({ kind: 'observation', value })),
      ...(ledgers.ledgers?.babyA ?? []).map((value) => ({ kind: 'audit-ledger', value })),
    ]);
    renderEvents('baby-b-ledger', [
      ...(observations.observations?.['baby-b'] ?? []).map((value) => ({ kind: 'observation', value })),
      ...(ledgers.ledgers?.babyB ?? []).map((value) => ({ kind: 'audit-ledger', value })),
    ]);
    renderEvents('telemetry', telemetry.telemetry ?? []);
    byId('checkpoints').textContent = `${checkpoints.checkpoints?.length ?? 0} signed`;
    byId('anchors').textContent = `${anchors.anchors?.length ?? 0} receipts`;
    byId('replay').textContent = replay.scenario?.ok === false ? 'FAILED' : replay.replayDigest;
    byId('replay').className = `metric ${replay.scenario?.ok === false ? 'fail' : 'pass'}`;
    const report = verification.report;
    byId('verification').textContent = report ? (report.exitCode === 0 ? 'PASS' : 'FAIL') : 'Pending';
    byId('verification').className = `metric ${report ? (report.exitCode === 0 ? 'pass' : 'fail') : ''}`;
    byId('notice').textContent = 'Live evidence refreshed.';
  } catch (error) {
    byId('notice').textContent = error instanceof Error ? error.message : 'Refresh failed.';
  } finally {
    state.loading = false;
  }
}

function updateOperatorState() {
  const enabled = byId('role').value === 'researcher-operator';
  document.querySelectorAll('[data-action]').forEach((button) => { button.disabled = !enabled; });
  byId('operator-note').textContent = enabled
    ? 'Every action is written to the intervention log and checkpointed.'
    : 'Switch to an operator credential to enable audited controls.';
}

async function intervene(action) {
  const reasonCode = byId('reason').value.trim();
  if (!reasonCode) {
    byId('notice').textContent = 'A reason code is required.';
    return;
  }
  await request(OPERATOR_ROUTES[action], {
    method: 'POST',
    body: { reasonCode },
  });
  await refreshRun();
}

byId('connection').addEventListener('submit', (event) => {
  event.preventDefault();
  loadRuns().catch((error) => { byId('notice').textContent = error.message; });
});
byId('run-select').addEventListener('change', () => { state.runId = byId('run-select').value; refreshRun(); });
byId('refresh').addEventListener('click', refreshRun);
byId('role').addEventListener('change', () => {
  byId('token').value = `dev-${byId('role').value}`;
  updateOperatorState();
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => intervene(button.dataset.action).catch((error) => {
    byId('notice').textContent = error.message;
  }));
});
updateOperatorState();
