import { v5 as uuidv5 } from 'uuid';

// RFC 4122 DNS namespace — fixed, well-known, deterministic across restarts.
// WARNING: changing this value invalidates all existing qdrantIds — requires a full re-index migration.
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function generateQdrantId(documentId: string, chunkIndex: number): string {
  return uuidv5(`${documentId}:${chunkIndex}`, NAMESPACE);
}
