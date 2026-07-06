/**
 * Unit tests for `buildDocumentStorageKey` — Slice 3 (S3 key re-namespacing
 * per user), plan §9 row 1 and row 4 (unit half of the collision criterion).
 *
 * Pure string builder: no S3, no DB, no I/O. Runs under the hermetic unit
 * suite (tests/unit/setup.ts fake env values) — the function never touches
 * the S3 client.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentStorageKey } from '../../../src/services/storage.js';

describe('buildDocumentStorageKey', () => {
  it("returns 'users/u1/documents/d1/report.pdf' for ('u1', 'd1', 'report.pdf') — plan §9 row 1", () => {
    expect(buildDocumentStorageKey('u1', 'd1', 'report.pdf')).toBe(
      'users/u1/documents/d1/report.pdf',
    );
  });

  it('is a pure synchronous function (returns string, not a Promise)', () => {
    const result = buildDocumentStorageKey('u1', 'd1', 'report.pdf');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('string');
  });

  it('produces distinct keys for two different users uploading identically-named files (plan §9 row 4, unit half)', () => {
    const keyA = buildDocumentStorageKey('user-a', 'doc-a', 'report.pdf');
    const keyB = buildDocumentStorageKey('user-b', 'doc-b', 'report.pdf');
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('users/user-a/documents/doc-a/report.pdf');
    expect(keyB).toBe('users/user-b/documents/doc-b/report.pdf');
  });

  it('produces distinct keys for the same user uploading the same filename twice (fresh documentId per upload) — edge case #3', () => {
    const first = buildDocumentStorageKey('u1', 'doc-1', 'report.pdf');
    const second = buildDocumentStorageKey('u1', 'doc-2', 'report.pdf');
    expect(first).not.toBe(second);
  });

  it('interpolates filename verbatim with no sanitization — edge case #4 (path separators, dots, spaces, unicode)', () => {
    expect(buildDocumentStorageKey('u1', 'd1', '../../etc/passwd')).toBe(
      'users/u1/documents/d1/../../etc/passwd',
    );
    expect(buildDocumentStorageKey('u1', 'd1', 'a file with spaces.txt')).toBe(
      'users/u1/documents/d1/a file with spaces.txt',
    );
    expect(buildDocumentStorageKey('u1', 'd1', '日本語.pdf')).toBe(
      'users/u1/documents/d1/日本語.pdf',
    );
  });

  it('handles an empty-string filename by producing a trailing slash — edge case #5', () => {
    expect(buildDocumentStorageKey('u1', 'd1', '')).toBe('users/u1/documents/d1/');
  });

  it('is a strict superset-prefixing of the legacy `documents/<id>/<name>` format', () => {
    const key = buildDocumentStorageKey('u1', 'd1', 'report.pdf');
    expect(key.endsWith('documents/d1/report.pdf')).toBe(true);
    expect(key.startsWith('users/u1/')).toBe(true);
  });
});
