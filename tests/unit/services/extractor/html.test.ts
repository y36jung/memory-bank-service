import { describe, it, expect } from 'vitest';
import { extractHtml } from '../../../../src/services/extractor/html.js';

describe('extractHtml', () => {
  it('strips tags and returns plain text', () => {
    const html = '<html><body><h1>Title</h1><p>Some paragraph text.</p></body></html>';
    const text = extractHtml(Buffer.from(html));
    expect(text).toContain('Title');
    expect(text).toContain('Some paragraph text.');
    expect(text).not.toMatch(/<[a-z]+[^>]*>/i);
  });

  it('removes script, style, and noscript content entirely', () => {
    const html =
      '<html><body><p>Visible</p><script>alert("xss")</script><style>.a{color:red}</style><noscript>no-js</noscript></body></html>';
    const text = extractHtml(Buffer.from(html));
    expect(text).toContain('Visible');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('no-js');
  });

  it('separates adjacent block-level elements with a newline instead of gluing them together', () => {
    const html = '<p>First</p><p>Second</p>';
    const text = extractHtml(Buffer.from(html));
    expect(text).not.toContain('FirstSecond');
    expect(text.split('\n').map((l) => l.trim())).toEqual(
      expect.arrayContaining(['First', 'Second']),
    );
  });

  it('converts <br> into a line break', () => {
    const html = '<p>Line one<br>Line two</p>';
    const text = extractHtml(Buffer.from(html));
    expect(text).toContain('Line one');
    expect(text).toContain('Line two');
    expect(text).not.toContain('Line oneLine two');
  });

  it('returns an empty string for empty/whitespace-only HTML', () => {
    expect(extractHtml(Buffer.from('<html><body></body></html>'))).toBe('');
  });
});
