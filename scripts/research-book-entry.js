import {
  loadBookManifest,
  openBookViewer,
} from '../node_modules/read-as-book/src/index.ts';

const button = document.querySelector('#open-research-book');
const status = document.querySelector('#book-status');
let manifestPromise;
let opening = false;

function loadManifest() {
  manifestPromise ??= loadBookManifest('book/pages/manifest.json');
  return manifestPromise;
}

async function openResearchBook() {
  if (opening) return;

  opening = true;
  button.disabled = true;
  status.textContent = 'Loading the page-turn edition...';

  try {
    const book = await loadManifest();
    await openBookViewer({
      pages: book.pages,
      aspect: book.aspect,
      title: 'Auditable Emergent Communication Between Isolated Artificial Agents',
      pdfUrl: 'book/research.pdf',
      hint: 'Use the arrow keys or page controls to turn pages. Press Esc to close.',
      className: 'research-book-overlay',
      onClose: () => {
        status.textContent = `${book.pageCount} pages available`;
      },
    });
    status.textContent = `${book.pageCount} pages available`;
  } catch (error) {
    console.error(error);
    status.textContent =
      'The book could not open. Use the Markdown or PDF links instead.';
  } finally {
    opening = false;
    button.disabled = false;
  }
}

button.addEventListener('click', openResearchBook);

void loadManifest()
  .then((book) => {
    status.textContent = `${book.pageCount} pages available`;
  })
  .catch((error) => {
    console.error(error);
    status.textContent =
      'Book metadata is unavailable. Use the Markdown or PDF links instead.';
  });

if (new URLSearchParams(globalThis.location.search).get('open') === '1') {
  globalThis.requestAnimationFrame(() => {
    void openResearchBook();
  });
}
