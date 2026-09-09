import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ASSETS = [
  'twins/packs/nursery/console/index.html',
  'twins/packs/nursery/console/styles.css',
  'twins/packs/nursery/console/app.js',
];
const CHECKLIST = 'docs/research-console-ux-checklist.json';

const contents = await Promise.all(ASSETS.map((path) => readFile(path, 'utf8')));
const [html, css, javascript] = contents;
const checklist = JSON.parse(await readFile(CHECKLIST, 'utf8'));
const failures = [];

const hash = `sha256:${createHash('sha256').update(contents.join('\0')).digest('hex')}`;
if (checklist.reviewedAssetHash !== hash) failures.push('UX review hash is stale');
if (checklist.blocksConsoleReleaseOnFailure !== true) failures.push('failures must block console release');
if (checklist.importsDiplomacyGameLogic !== false) failures.push('Diplomacy game logic import is prohibited');
if (checklist.clientSideBabyRoutes !== false) failures.push('client-side Baby routes are prohibited');
if (checklist.reusedComponents?.length !== 8) failures.push('every §16.2 mapping must be listed');
if (checklist.reusedComponents?.some((item) => item.result !== 'pass')) failures.push('a §16.2 mapping failed');
if (checklist.prohibitions?.length !== 6) failures.push('every §16.3/claim prohibition must be listed');
if (checklist.prohibitions?.some((item) => item.result !== 'pass')) failures.push('a prohibition failed');

if (/\b(?:React|Vue|Angular|Svelte)\b/u.test(`${html}\n${css}\n${javascript}`)) {
  failures.push('frontend framework reference found');
}
if (/['"]\/baby-(?:a|b)\//u.test(javascript)) failures.push('direct Baby route found');
if (/['"]\/(?:observe|act|deliver|outcome|reset|ledger)['"]/u.test(javascript)) {
  failures.push('Baby tool route found');
}
if (/\b(?:caucus|coalition)\b/ui.test(`${html}\n${javascript}`)) {
  failures.push('prohibited Diplomacy interaction found');
}
if (!/researcher-operator/u.test(javascript) || !/button\.disabled = !enabled/u.test(javascript)) {
  failures.push('operator control gating is missing');
}

if (failures.length > 0) {
  throw new Error(`Research Console UX check failed:\n- ${failures.join('\n- ')}`);
}
process.stdout.write(`Research Console UX check passed (${hash})\n`);
