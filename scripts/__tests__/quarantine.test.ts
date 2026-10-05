import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error The quarantine helper is a directly executable ESM script.
import { quarantineMarkerPath, quarantineSkipLine, readQuarantineMarker } from '../quarantine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const MARKERS = [
  'lv01-application-fault-v3',
  'lv01-commitment-window-fault-v3',
  'lv01-development-allocation-v12',
  'lv01-development-v23-receipt',
  'lv01-five-rejection-safety-v1',
  'lv01-malformed-proposal-v5',
  'lv01-paired-development-v21',
];

const QUARANTINED_SCRIPTS = [
  { name: 'lv01-paired-development-v21',
    script: 'scripts/check-lv01-paired-development-v21-receipt.mjs' },
  { name: 'lv01-commitment-window-fault-v3',
    script: 'scripts/check-lv01-commitment-window-fault-v3-receipt.mjs' },
  { name: 'lv01-malformed-proposal-v5',
    script: 'scripts/check-lv01-malformed-proposal-v5-receipt.mjs' },
  { name: 'lv01-five-rejection-safety-v1',
    script: 'scripts/check-lv01-five-rejection-safety-v1-receipt.mjs' },
  { name: 'lv01-application-fault-v3',
    script: 'scripts/check-lv01-application-fault-v3-receipt.mjs' },
];

const REQUIRED_FIELDS = ['schemaVersion', 'name', 'check', 'gate', 'criteria',
  'owner', 'reason', 'resume', 'removalCondition', 'governance'];

describe('Evidence-absent quarantine (R5-A governance)', () => {
  it('keeps exactly the 7 governed markers, all well-formed', () => {
    // Deliberately exact: adding or removing a quarantine must update this
    // test in the same change.
    const files = readdirSync(`${root}quarantine`)
      .filter((file) => file.endsWith('.json')).sort();
    expect(files).toEqual(MARKERS.map((name) => `${name}.json`));
    for (const file of files) {
      const marker = JSON.parse(readFileSync(`${root}quarantine/${file}`, 'utf8'));
      for (const field of REQUIRED_FIELDS) {
        expect(marker[field], `${file}.${field}`).toBeDefined();
      }
      expect(marker.name).toBe(file.replace(/\.json$/u, ''));
      // The LV01 fixture layer is decoupled from ALD acceptance (zero LV01
      // references in BACKLOG.md or the conformance gating maps), so no
      // quarantined check gates an ALD criterion. See docs/quarantine-record.md.
      expect(marker.criteria).toEqual([]);
    }
  });

  it('skips only when evidence is absent AND a marker exists (fail-closed otherwise)', () => {
    expect(quarantineSkipLine('lv01-paired-development-v21', true)).toBeNull();
    const line = quarantineSkipLine('lv01-paired-development-v21', false);
    expect(line).toContain('QUARANTINED lv01-paired-development-v21');
    expect(line).toContain('quarantine/lv01-paired-development-v21.json');
    expect(line).toContain('docs/quarantine-record.md');
    expect(quarantineSkipLine('no-such-marker', false)).toBeNull();
    expect(readQuarantineMarker('no-such-marker')).toBeNull();
    expect(quarantineMarkerPath('x')).toContain('quarantine/x.json');
  });

  it.each(QUARANTINED_SCRIPTS)(
    '$name passes loud (quarantined when absent, full check when present)',
    ({ name, script }) => {
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout)
        .toMatch(new RegExp(`QUARANTINED ${name}|verified against retained local evidence`, 'u'));
    },
  );

  it.each([
    { name: 'lv01-paired-development-v21', present: true },
    { name: 'no-such-marker', present: false },
  ])('exitIfQuarantined returns normally for $name (present=$present)', ({ name, present }) => {
    // exitIfQuarantined calls process.exit on the quarantine path, so it
    // cannot be invoked in-process: spawn a probe that must survive the
    // call and print SENTINEL. Kills R9-BG mutants M1 (ignores present)
    // and M2 (ignores no-marker).
    // Self-validating test data (R9-BT H4): the P1 case only kills M1
    // when its marker really exists, so assert the setup first.
    if (present) {
      expect(readQuarantineMarker(name)).not.toBeNull();
    } else {
      expect(readQuarantineMarker(name)).toBeNull();
    }
    const probe = `import('./scripts/quarantine.mjs').then((m) => { m.exitIfQuarantined('${name}', ${present}); console.log('SENTINEL'); });`;
    const result = spawnSync(process.execPath, ['-e', probe], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^SENTINEL$/mu);
    expect(result.stdout).not.toContain('QUARANTINED');
  });

  it('wires the 2 vitest-side quarantine branches', () => {
    const runner = readFileSync(`${root}scripts/__tests__/lv01-fixture-runner.test.ts`, 'utf8');
    expect(runner).toContain('quarantineSkipLine(\'lv01-development-allocation-v12\'');
    const v23 = readFileSync(
      `${root}scripts/__tests__/lv01-development-v23-receipt.test.ts`, 'utf8');
    expect(v23).toContain('quarantineSkipLine(\'lv01-development-v23-receipt\'');
  });
});
