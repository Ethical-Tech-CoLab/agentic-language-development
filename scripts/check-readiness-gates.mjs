import { access, readFile } from 'node:fs/promises';

const expectedExperiments = [
  'E00', 'E01', 'E02', 'E03',
  'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16',
  'E20', 'E21', 'E22', 'E30', 'E31', 'E32', 'E40', 'E50',
];

const [backlog, notebook, rawManifest] = await Promise.all([
  readFile('BACKLOG.md', 'utf8'),
  readFile('EXPERIMENT-NOTEBOOK.md', 'utf8'),
  readFile('docs/experiment-readiness-gates.json', 'utf8'),
]);
const manifest = JSON.parse(rawManifest);
if (manifest.claimBoundary !== 'software-readiness-only') {
  throw new Error('readiness manifest must retain the software-only claim boundary');
}

const covered = manifest.experiments.flatMap((entry) => entry.ids).sort();
if (JSON.stringify(covered) !== JSON.stringify([...expectedExperiments].sort())) {
  throw new Error(`readiness manifest experiment coverage mismatch: ${covered.join(', ')}`);
}

for (const entry of manifest.experiments) {
  if (!/^G[1-5]$/u.test(entry.gate) || entry.evidence.length === 0) {
    throw new Error(`invalid readiness entry for ${entry.ids.join('/')}`);
  }
  for (const id of entry.ids) {
    if (!notebook.includes(`## ${id}.`)) {
      throw new Error(`${id} is not an experiment heading in EXPERIMENT-NOTEBOOK.md`);
    }
  }
  for (const requirement of entry.requires) {
    const start = backlog.indexOf(`#### ${requirement} `);
    const end = backlog.indexOf('\n#### ALD-', start + 1);
    if (start < 0) throw new Error(`unknown readiness prerequisite ${requirement}`);
    const section = backlog.slice(start, end < 0 ? backlog.length : end);
    if (/^  - \[ \]/mu.test(section)) {
      throw new Error(`${entry.gate} ${entry.ids.join('/')} depends on incomplete ${requirement}`);
    }
  }
  for (const path of entry.evidence) await access(path);
}

const checklist = notebook
  .slice(notebook.indexOf('## 12. Publication Checklist'))
  .match(/^- \[ \] (.+)$/gmu)
  ?.map((line) => line.slice(6)) ?? [];
const mapping = await readFile(manifest.publicationChecklistMapping, 'utf8');
for (const item of checklist) {
  if (!mapping.includes(item)) {
    throw new Error(`publication checklist item is unmapped: ${item}`);
  }
}
if (!mapping.includes('research-execution') || !mapping.includes('software-verifiable')) {
  throw new Error('publication mapping must distinguish software checks from research judgment');
}

console.log(`Readiness gates cover ${covered.length} experiments and ${checklist.length} publication checks.`);
