import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultFixtureDirectory, loadObservationFixtures, readFixtureManifest,
  runObservationRedTeamSuite } from '@ald/redteam';

const output = process.argv[2];
assert.equal(process.argv.length, 3, 'usage: audit-e02-ocr.mjs <new-output.json>');
assert.match(output, /^evidence\/development\/e02-[a-z0-9-]+\.json$/u);
assert.equal(existsSync(output), false, 'refusing to overwrite an OCR observation');
const binary = '/home/linuxbrew/.linuxbrew/opt/tesseract/bin/tesseract';
const modelRoot = '/home/linuxbrew/.linuxbrew/opt/tesseract/share/tessdata';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureRoot = defaultFixtureDirectory();
const manifest = readFixtureManifest(fixtureRoot);
const fixtureSuite = runObservationRedTeamSuite({ fixtures: loadObservationFixtures(fixtureRoot) });
const visibleTextCategories = ['direct-text', 'low-contrast-text', 'rotated-text', 'single-character'];
const records = manifest.entries.map((entry) => {
  const input = readFileSync(join(fixtureRoot, entry.file));
  assert.equal(`sha256:${hash(input)}`, entry.sha256);
  const args = ['stdin', 'stdout', '--tessdata-dir', modelRoot, '-l', 'eng', '--psm', '6'];
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
  const hasCharacters = result.status === 0 ? /[\p{L}\p{N}]/u.test(result.stdout) : null;
  return { fixtureId: entry.fixtureId, category: entry.category, inputSha256: hash(input),
    expectedQuarantine: entry.expected, args, exitCode: result.status,
    error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    hasCharacters, plantedVisibleText: visibleTextCategories.includes(entry.category),
    scope: 'Offline OCR fixture observation; not text delivered to a learner' };
});
const report = { schemaVersion: 1, classification: 'development-only', researchFinding: false,
  softwareCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  engine: { binary, binarySha256: hash(readFileSync(binary)),
    version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    models: ['eng.traineddata', 'osd.traineddata'].map((name) => ({ name, sha256: hash(readFileSync(join(modelRoot, name))) })),
    language: 'eng', pageSegmentationMode: 6, ompThreadLimit: 1 },
  fixtureManifestSha256: hash(readFileSync(join(fixtureRoot, 'manifest.json'))),
  records, fixtureSuite,
  totals: { fixtures: records.length, engineFailures: records.filter((r) => r.exitCode !== 0).length,
    plantedVisibleText: records.filter((r) => r.plantedVisibleText).length,
    visibleTextDetected: records.filter((r) => r.plantedVisibleText && r.hasCharacters === true).length,
    visibleTextMissed: records.filter((r) => r.plantedVisibleText && r.hasCharacters === false).length,
    textFreeControls: records.filter((r) => r.category === 'text-free-control').length,
    controlFalsePositives: records.filter((r) => r.category === 'text-free-control' && r.hasCharacters === true).length },
  boundary: 'The numeric baseline has no image assets. OCR output and structural-quarantine outcomes are separate: successful quarantine does not imply successful OCR, and an empty OCR result does not prove absence of text. The suite uses an instrumented sink, not Mode R learner delivery. English fixture coverage only.' };
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, totals: report.totals, quarantine: fixtureSuite.summary }));
