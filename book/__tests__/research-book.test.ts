import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface BookManifest {
  generatedFrom: string;
  pageCount: number;
  aspect: number;
  pages: string[];
  source: string;
  sourceSha256: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bookDir = join(root, 'book');

describe('research page-turn book', () => {
  it('publishes a complete and internally consistent page manifest', async () => {
    const manifest = JSON.parse(
      await readFile(join(bookDir, 'pages', 'manifest.json'), 'utf8'),
    ) as BookManifest;

    expect(manifest.generatedFrom).toBe('research.pdf');
    expect(manifest.source).toBe('RESEARCH.md');
    expect(manifest.pageCount).toBeGreaterThan(1);
    expect(manifest.pages).toHaveLength(manifest.pageCount);
    expect(new Set(manifest.pages).size).toBe(manifest.pageCount);
    expect(manifest.aspect).toBeCloseTo(0.7727, 4);
    expect(manifest.sourceSha256).toBe(
      createHash('sha256')
        .update(await readFile(join(root, 'RESEARCH.md'), 'utf8'))
        .digest('hex'),
    );

    for (const page of manifest.pages) {
      expect(page).toMatch(/^pages\/p\d{2,3}\.webp$/u);
      const pageFile = join(bookDir, 'pages', page.split('/').at(-1) ?? '');
      expect((await stat(pageFile)).size).toBeGreaterThan(1_000);
    }
  });

  it('publishes the PDF, print edition, reader bundle, and styles', async () => {
    const pdf = await readFile(join(bookDir, 'research.pdf'));
    const printEdition = await readFile(
      join(bookDir, 'research-print.html'),
      'utf8',
    );

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(100_000);
    expect(printEdition).toContain(
      'Auditable Emergent Communication Between Isolated Artificial Agents',
    );
    expect(
      (await stat(join(bookDir, 'vendor', 'research-book.js'))).size,
    ).toBeGreaterThan(10_000);
    expect(
      (await stat(join(bookDir, 'vendor', 'read-as-book.css'))).size,
    ).toBeGreaterThan(1_000);
  });

  it('links the project site to an auto-opening book view', async () => {
    const projectSite = await readFile(join(root, 'index.html'), 'utf8');
    const bookPage = await readFile(join(root, 'research-book.html'), 'utf8');

    expect(projectSite).toContain('research-book.html?open=1');
    expect(bookPage).toContain('id="open-research-book"');
    expect(bookPage).toContain('book/vendor/research-book.js');
    expect(bookPage).toContain('book/research.pdf');
  });
});
