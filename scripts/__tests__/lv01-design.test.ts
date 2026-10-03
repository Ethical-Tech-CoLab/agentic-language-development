import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const required = [
  'protocols/lv01-study-design.v1.json',
  'protocols/lv01-analysis-plan.v1.json',
  'protocols/lv01-seed-resource-policy.v1.json',
  'protocols/research-protocol-cards.v1.json',
  'protocols/scenario-split-and-model-comparison.v1.json',
  'protocols/causal-ledger-and-leakage.v1.json',
  'protocols/confirmatory-practical-margins.v1.json',
  'protocols/seed-and-resource-allocation.v1.json',
];

function fixture(change?: (design: Record<string, unknown>) => void): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-lv01-design-'));
  temporary.push(directory);
  for (const source of required) {
    const target = join(directory, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, source), target);
  }
  if (change !== undefined) {
    const target = join(directory, 'protocols/lv01-study-design.v1.json');
    const design = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    change(design);
    writeFileSync(target, `${JSON.stringify(design, null, 2)}\n`);
  }
  return directory;
}

function run(directory: string, version?: string) {
  const args = version === undefined
    ? [join(root, 'scripts/check-lv01-design.mjs')]
    : [join(root, 'scripts/check-lv01-design.mjs'), '--version', version];
  return spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: 'utf8',
  });
}

const requiredV2 = [
  ...required,
  'protocols/lv01-study-design.v2.json',
  'protocols/lv01-analysis-plan.v2.json',
  'protocols/lv01-seed-resource-policy.v2.json',
  'protocols/lv01-prototype-execution-profile.v2.json',
  'protocols/lv01-direction-amendment.v2.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
];

function fixtureV2(change?: (file: string, packet: Record<string, unknown>) => string | void): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-lv01-design-'));
  temporary.push(directory);
  for (const source of requiredV2) {
    const target = join(directory, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, source), target);
  }
  if (change !== undefined) {
    for (const source of ['protocols/lv01-study-design.v2.json', 'protocols/lv01-analysis-plan.v2.json', 'protocols/lv01-seed-resource-policy.v2.json']) {
      const target = join(directory, source);
      const packet = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      if (change(source, packet) === 'edited') {
        writeFileSync(target, `${JSON.stringify(packet, null, 2)}\n`);
      }
    }
  }
  return directory;
}

afterEach(() => { while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('LV01 design contract', () => {
  it('accepts the frozen outcome-blind contract', () => expect(run(fixture()).status).toBe(0));
  it('rejects a changed training budget', () => {
    const result = run(fixture((design) => {
      ((design.task as Record<string, unknown>).partitions as Record<string, Record<string, unknown>>).training.cases = 2999;
    }));
    expect(result.status).not.toBe(0);
  });
  it('rejects source-policy drift', () => {
    const directory = fixture();
    const source = join(directory, 'protocols/research-protocol-cards.v1.json');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    expect(run(directory).status).not.toBe(0);
  });
});

describe('LV01 design contract v2 packets', () => {
  it('accepts the v2 packets with R03 ordinary-record pins', () => {
    expect(run(fixtureV2(), '2').status).toBe(0);
  });
  it('rejects a tampered delivered-token inventory', () => {
    const directory = fixtureV2((file, packet) => {
      if (file !== 'protocols/lv01-study-design.v2.json') return;
      ((packet.channel as Record<string, unknown>).deliveredTokenInventory as Record<string, unknown>).tokens = ['rogue'];
      return 'edited';
    });
    expect(run(directory, '2').status).not.toBe(0);
  });
  it('rejects a dropped window clarification key', () => {
    const directory = fixtureV2((file, packet) => {
      if (file !== 'protocols/lv01-analysis-plan.v2.json') return;
      delete (packet.ordinaryRecordWindow as Record<string, unknown>).emptyFoldRule;
      return 'edited';
    });
    expect(run(directory, '2').status).not.toBe(0);
  });
  it('rejects an unresolvable inventory ref', () => {
    const directory = fixtureV2((file, packet) => {
      if (file !== 'protocols/lv01-analysis-plan.v2.json') return;
      (packet.ordinaryRecordWindow as Record<string, unknown>).deliveredTokenInventoryRef = 'study-design.channel.missing';
      return 'edited';
    });
    expect(run(directory, '2').status).not.toBe(0);
  });
  it('accepts the v2 packets with P6 subkey and role-code pins', () => {
    expect(run(fixtureV2(), '2').status).toBe(0);
  });
  it('rejects a tampered sender subkey', () => {
    const directory = fixtureV2((file, packet) => {
      if (file !== 'protocols/lv01-study-design.v2.json') return;
      ((packet.observationSchemas as Record<string, Record<string, unknown>>).sender.forbidden as unknown[]).push('true scenario target');
      return 'edited';
    });
    expect(run(directory, '2').status).not.toBe(0);
  });
  it('rejects tampered role-stream role codes', () => {
    const directory = fixtureV2((file, packet) => {
      if (file !== 'protocols/lv01-seed-resource-policy.v2.json') return;
      (packet.derivation as Record<string, unknown>).roleStreamRoleCodes = ['baby-a', 'rogue'];
      return 'edited';
    });
    expect(run(directory, '2').status).not.toBe(0);
  });
});
