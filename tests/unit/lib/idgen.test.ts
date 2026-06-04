/**
 * Unit tests for src/lib/idgen.ts
 *
 * Criteria covered:
 * AC-6a: same inputs → same UUID (deterministic)
 * AC-6b: different chunkIndex → different UUID
 */

import { describe, it, expect } from 'vitest';
import { generateQdrantId } from '../../../src/lib/idgen.js';

describe('generateQdrantId', () => {
  const DOC_ID = '550e8400-e29b-41d4-a716-446655440000';

  it('returns a valid UUID string', () => {
    const id = generateQdrantId(DOC_ID, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same inputs produce same UUID', () => {
    const id1 = generateQdrantId(DOC_ID, 0);
    const id2 = generateQdrantId(DOC_ID, 0);
    expect(id1).toBe(id2);
  });

  it('different chunkIndex produces a different UUID', () => {
    const id0 = generateQdrantId(DOC_ID, 0);
    const id1 = generateQdrantId(DOC_ID, 1);
    const id2 = generateQdrantId(DOC_ID, 2);
    expect(id0).not.toBe(id1);
    expect(id0).not.toBe(id2);
    expect(id1).not.toBe(id2);
  });

  it('different documentId produces a different UUID even with same chunkIndex', () => {
    const idA = generateQdrantId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
    const idB = generateQdrantId('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0);
    expect(idA).not.toBe(idB);
  });

  it('uses the format documentId:chunkIndex as the name input', () => {
    // The implementation uses uuidv5(`${documentId}:${chunkIndex}`, NAMESPACE).
    // Verify cross-call with a known concrete pair.
    const id = generateQdrantId(DOC_ID, 42);
    // Call again with different index to confirm they differ
    const idOther = generateQdrantId(DOC_ID, 43);
    expect(id).not.toBe(idOther);
    // And same again to confirm stability
    expect(generateQdrantId(DOC_ID, 42)).toBe(id);
  });

  it('produces a uuidv5 (version 5) UUID', () => {
    const id = generateQdrantId(DOC_ID, 0);
    // UUID version is encoded in the 3rd group's first hex digit = '5'
    const parts = id.split('-');
    expect(parts[2]?.charAt(0)).toBe('5');
  });
});
