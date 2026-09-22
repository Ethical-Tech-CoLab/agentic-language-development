import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('LV01 detector observation stage', () => {
  it('binds capture to the selected recurrent application runtime without deciding probes', () => {
    const controller = readFileSync(`${root}deploy/mode-r/application-controller.mjs`, 'utf8');
    expect(controller).toContain("'lv01-detector-observation'");
    expect(controller).toContain('async function runLv01DetectorObservation()');
    expect(controller).toContain("assert.equal(config.babyA.modelRef, RECURRENT_ARCHITECTURE)");
    expect(controller).toContain("assert.equal(config.babyB.modelRef, RECURRENT_ARCHITECTURE)");
    expect(controller).toContain('runtime.adaptersFor(config.runId)');
    expect(controller).toContain('assert.equal(captured.length, turns.length * 2)');
    expect(controller).toContain("if (stage === 'lv01-detector-observation')");
    expect(controller).toContain('Selected-topology detector observation attempt failed before a detector decision.');
    expect(controller).toContain("runtime.exportBundle(config.runId, join(outputRoot, 'bundle'))");
    expect(controller).toContain("researchFinding: false");
    expect(controller).toContain('Labels, detector probes, restoration comparison, and any qualification decision are owned by the outer collector.');
  });
});
