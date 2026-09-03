import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bookDir = join(root, 'book');
const printPath = join(bookDir, 'research-print.html');
const pdfPath = join(bookDir, 'research.pdf');
const pagesDir = join(bookDir, 'pages');
const vendorDir = join(bookDir, 'vendor');

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  for (const candidate of chromeCandidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Chrome or Edge not found. Set CHROME_PATH and retry.');
}

function printableHtml(markdown) {
  const rendered = marked.parse(markdown, {
    gfm: true,
    breaks: false,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Auditable Emergent Communication Between Isolated Artificial Agents</title>
  <style>
    @page {
      size: Letter;
      margin: 0.68in 0.72in 0.72in;
    }
    * { box-sizing: border-box; }
    html { font-size: 10pt; }
    body {
      margin: 0;
      color: #18223a;
      background: white;
      font-family: Georgia, "Times New Roman", serif;
      line-height: 1.42;
    }
    h1, h2, h3, h4 {
      color: #111a2f;
      font-family: "Segoe UI", Arial, sans-serif;
      page-break-after: avoid;
      break-after: avoid-page;
    }
    h1 {
      margin: 1.35in 0 0.28in;
      color: #193b73;
      font-size: 29pt;
      line-height: 1.08;
      letter-spacing: -0.03em;
    }
    h1 + h2 {
      margin-top: 0;
      color: #56627a;
      font-size: 15pt;
      font-weight: 500;
      line-height: 1.3;
    }
    h2 {
      margin: 0 0 0.18in;
      padding-top: 0.05in;
      border-top: 1.5pt solid #9eb5d6;
      font-size: 17pt;
      page-break-before: always;
      break-before: page;
    }
    h3 { margin: 0.24in 0 0.08in; font-size: 12.5pt; }
    h4 { margin: 0.18in 0 0.06in; font-size: 10.5pt; }
    p, li { orphans: 3; widows: 3; }
    p { margin: 0 0 0.11in; }
    ul, ol { margin: 0.04in 0 0.13in; padding-left: 0.24in; }
    li { margin: 0 0 0.035in; }
    blockquote {
      margin: 0.13in 0;
      padding: 0.11in 0.16in;
      border-left: 3pt solid #527eb8;
      background: #f2f6fb;
      color: #39465f;
    }
    blockquote p:last-child { margin-bottom: 0; }
    a { color: #194f91; text-decoration: none; }
    code {
      border-radius: 2pt;
      padding: 0.5pt 2pt;
      background: #edf2f7;
      font-family: Consolas, "Courier New", monospace;
      font-size: 8.4pt;
    }
    pre {
      margin: 0.12in 0;
      padding: 0.12in;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      border: 0.5pt solid #c8d4e3;
      background: #f6f8fb;
      break-inside: avoid;
    }
    pre code { padding: 0; background: transparent; font-size: 7.8pt; }
    table {
      width: 100%;
      margin: 0.12in 0 0.17in;
      border-collapse: collapse;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 7.4pt;
      line-height: 1.24;
    }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td {
      padding: 4pt 5pt;
      vertical-align: top;
      border: 0.5pt solid #bdc9d8;
    }
    th { background: #e9f0f8; color: #17253d; text-align: left; }
    hr {
      margin: 0.24in 0;
      border: 0;
      border-top: 0.5pt solid #c6d1df;
    }
    img { max-width: 100%; break-inside: avoid; }
    .running-footer {
      position: fixed;
      right: 0;
      bottom: -0.46in;
      left: 0;
      color: #778399;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 7pt;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="running-footer">
    Ethical Tech CoLab · Working research manuscript · September 2026
  </div>
  ${rendered}
</body>
</html>`;
}

async function printPdf(chrome) {
  const profile = await mkdtemp(join(tmpdir(), 'ald-research-book-'));
  try {
    const result = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        '--print-to-pdf-no-header',
        `--print-to-pdf=${pdfPath}`,
        '--virtual-time-budget=10000',
        pathToFileURL(printPath).href,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(`Chrome PDF rendering failed with exit ${result.status}`);
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }

  if (!(await exists(pdfPath)) || (await stat(pdfPath)).size === 0) {
    throw new Error('Chrome did not create a research PDF');
  }
}

async function renderPages() {
  const renderer = join(
    root,
    'node_modules',
    'read-as-book',
    'bin',
    'render-pages.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [
      renderer,
      pdfPath,
      '--out',
      pagesDir,
      '--base',
      'pages',
      '--scale',
      '1.5',
      '--quality',
      '82',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`Page rasterization failed with exit ${result.status}`);
  }
}

async function stampManifest(markdown) {
  const manifestPath = join(pagesDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.source = 'RESEARCH.md';
  manifest.sourceSha256 = createHash('sha256').update(markdown).digest('hex');
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

async function bundleViewer() {
  await mkdir(vendorDir, { recursive: true });
  const bundlePath = join(vendorDir, 'research-book.js');
  await build({
    entryPoints: [join(root, 'scripts', 'research-book-entry.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'browser',
    target: ['es2020'],
  });
  const bundle = await readFile(bundlePath, 'utf8');
  await writeFile(
    bundlePath,
    bundle.replace(/[ \t]+$/gmu, ''),
    'utf8',
  );
  await copyFile(
    join(root, 'node_modules', 'read-as-book', 'styles.css'),
    join(vendorDir, 'read-as-book.css'),
  );
}

async function main() {
  const markdown = await readFile(join(root, 'RESEARCH.md'), 'utf8');
  await mkdir(bookDir, { recursive: true });
  await writeFile(printPath, printableHtml(markdown), 'utf8');

  const chrome = await findChrome();
  console.log(`Printing RESEARCH.md with ${chrome}`);
  await printPdf(chrome);
  await renderPages();
  const manifest = await stampManifest(markdown);
  await bundleViewer();
  console.log(
    `Research book ready: ${manifest.pageCount} pages, aspect ${manifest.aspect}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
