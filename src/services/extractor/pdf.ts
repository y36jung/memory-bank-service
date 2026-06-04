import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Disable worker in Node.js — prevents pdfjs from attempting to spawn a browser
// worker thread that would require browser-only globals.
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

/**
 * Extract plain text from a PDF buffer using pdfjs-dist (legacy Node build).
 * Pages are joined with '\n\n'. Returns '' for PDFs with no extractable text
 * (e.g. image-only pages).
 *
 * Propagates pdfjs exceptions (PasswordException, InvalidPDFException) so the
 * ingestion worker can mark the document as failed.
 */
export async function extractPdf(buffer: Buffer): Promise<string> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
  });

  const pdfDocument = await loadingTask.promise;
  const numPages = pdfDocument.numPages;
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageText = textContent.items
      .filter((item): item is typeof item & { str: string } => 'str' in item)
      .map((item) => item.str)
      .join('');

    pageTexts.push(pageText);
    page.cleanup();
  }

  await pdfDocument.cleanup();

  return pageTexts.join('\n\n');
}
