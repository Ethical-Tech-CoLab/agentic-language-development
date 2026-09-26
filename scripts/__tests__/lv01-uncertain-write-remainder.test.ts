import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const names = (dir: string) => readdirSync(`${root}${dir}`);

describe('LV01 uncertain-write remainder (H07 open gate)', () => {
  it('pins the mode-r v6 single path as the only qualified uncertain-write case', () => {
    const protocol = JSON.parse(read('protocols/mode-r-uncertain-write-development.v6.json'));
    expect(protocol.classification).toBe('selected-mode-r-uncertain-write-development-protocol');
    expect(protocol.qualificationId).toBe('mode-r-uncertain-write-development-v6');
    const receipt = JSON.parse(
      read('reports/research/mode-r-uncertain-write-development-v6-qualification-receipt.json'),
    );
    expect(receipt.qualificationId).toBe('mode-r-uncertain-write-development-v6');
    expect(receipt.passed).toBe(true);
    expect(receipt.researchFinding).toBe(false);
    expect(receipt.b12Closed).toBe(false);
  });

  it('has no LV01 uncertain-write protocol, receipt, or Docker overlay', () => {
    expect(names('protocols').filter((name) => name.startsWith('lv01-uncertain-write'))).toEqual([]);
    expect(
      names('reports/research').filter((name) => name.startsWith('lv01-uncertain-write')),
    ).toEqual([]);
    expect(
      names('deploy/mode-r').filter(
        (name) => name.includes('uncertain-write') && name.includes('lv01'),
      ),
    ).toEqual([]);
    expect(read('deploy/mode-r/docker-compose.application-uncertain-write.v1.yml')).not.toContain('lv01');
  });

  it('records the remainder as an explicit open H07 gate', () => {
    const note = read('docs/lv01-uncertain-write-remainder.md');
    expect(note).toContain('H07');
    expect(note).toContain('mode-r-uncertain-write-development-v6');
    expect(note).toContain('open');
  });
});
