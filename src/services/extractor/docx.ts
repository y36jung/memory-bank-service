import mammoth from 'mammoth';

/**
 * Extract plain text from a DOCX buffer using mammoth.
 * Uses extractRawText (not convertToHtml) so the chunker receives clean
 * plain text without any HTML markup.
 *
 * Propagates exceptions from mammoth (e.g. corrupt ZIP / invalid DOCX) so
 * the ingestion worker can mark the document as failed.
 */
export async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
