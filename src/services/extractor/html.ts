import * as cheerio from 'cheerio';

const BLOCK_SELECTOR = 'p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre';

/**
 * Extract plain text from an HTML buffer using cheerio.
 * Strips script/style/noscript entirely, then inserts newlines around
 * block-level elements before pulling text — otherwise adjacent block
 * elements (e.g. two <p> tags) collapse into one run-on line, which hurts
 * chunking/embedding quality downstream.
 */
export function extractHtml(buffer: Buffer): string {
  const $ = cheerio.load(buffer.toString('utf-8'));
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  $(BLOCK_SELECTOR).after('\n');

  const text = $.root().text();
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
