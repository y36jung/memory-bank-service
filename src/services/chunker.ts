import { countTokens } from '../lib/tokenizer.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Chunk {
  content: string;
  tokenCount: number;
  chunkIndex: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 150;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split text at sentence boundaries. Returns an array of sentence-level
 * segments (may include trailing whitespace from the delimiter).
 */
function splitBySentence(text: string): string[] {
  // Split on '. ', '! ', '? ', '.\n', '!\n', '?\n' — keep delimiter with preceding segment.
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.length > 0);
}

/**
 * Split a single segment into word-level pieces.
 */
function splitByWord(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Given a list of text pieces, greedily assemble chunks of up to TARGET_TOKENS,
 * then begin the next chunk by backtracking OVERLAP_TOKENS into the previous chunk.
 */
function assembleChunks(segments: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = countTokens(seg);

    if (currentTokens + segTokens > TARGET_TOKENS && current.length > 0) {
      // Flush current chunk.
      const chunkText = current.join(' ');
      chunks.push(chunkText);

      // Build overlap: walk backwards through current segments to collect ~150 tokens.
      const overlapSegments: string[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const s = current[i];
        if (s === undefined) break;
        const t = countTokens(s);
        if (overlapTokens + t > OVERLAP_TOKENS) break;
        overlapSegments.unshift(s);
        overlapTokens += t;
      }

      current = [...overlapSegments, seg];
      currentTokens = overlapTokens + segTokens;
    } else {
      current.push(seg);
      currentTokens += segTokens;
    }
  }

  // Flush the last chunk if non-empty.
  if (current.length > 0) {
    const chunkText = current.join(' ');
    if (chunkText.trim().length > 0) {
      chunks.push(chunkText);
    }
  }

  return chunks;
}

/**
 * Detects section headings and splits `text` into section-scoped blocks so a
 * single chunk never straddles two unrelated sections (a section that itself
 * exceeds TARGET_TOKENS is still further split downstream by the normal
 * paragraph/sentence assembly, scoped to that section). Recognizes two
 * heading conventions:
 *   - Markdown ATX headers: a line starting with 1-6 '#' followed by a space.
 *   - Setext-style headers: a non-blank line immediately followed by a line
 *     of 3+ repeated '-' or '=' characters (e.g. "HTTP STATUS CODES\n-----").
 * Falls back to returning the whole text as one section when no headings are
 * found, preserving prior behavior for unstructured documents.
 */
function splitIntoSections(text: string): string[] {
  const lines = text.split('\n');
  const headingIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (/^#{1,6}\s+\S/.test(line)) {
      headingIndices.push(i);
      continue;
    }

    const next = lines[i + 1];
    if (line.trim().length > 0 && next !== undefined && /^(-{3,}|={3,})$/.test(next.trim())) {
      headingIndices.push(i);
    }
  }

  if (headingIndices.length === 0) {
    return [text];
  }

  const sections: string[] = [];

  // Preserve any preamble text before the first detected heading.
  const firstHeadingLine = headingIndices[0] as number;
  if (firstHeadingLine > 0) {
    const preamble = lines.slice(0, firstHeadingLine).join('\n');
    if (preamble.trim().length > 0) {
      sections.push(preamble);
    }
  }

  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i] as number;
    const end = i + 1 < headingIndices.length ? (headingIndices[i + 1] as number) : lines.length;
    sections.push(lines.slice(start, end).join('\n'));
  }

  return sections;
}

/**
 * Split text into fine-grained segments (sentence or word level) suitable for
 * overlap-aware chunk assembly. Always splits to at least sentence granularity
 * so the overlap walk in assembleChunks can pick up ~150 tokens cleanly.
 *
 * Priority: paragraph (\n\n) > sentence (. / ! / ?) > word
 */
function splitToSegments(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const result: string[] = [];

  for (const para of paragraphs) {
    const sentences = splitBySentence(para);
    if (sentences.length > 1) {
      for (const sent of sentences) {
        if (countTokens(sent) > TARGET_TOKENS) {
          result.push(...splitByWord(sent));
        } else {
          result.push(sent);
        }
      }
    } else {
      if (countTokens(para) > TARGET_TOKENS) {
        result.push(...splitByWord(para));
      } else {
        result.push(para);
      }
    }
  }

  return result.filter((s) => s.trim().length > 0);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Split `text` into overlapping chunks of ~800 tokens with 150-token overlap.
 *
 * - Returns [] for empty or whitespace-only input.
 * - Returns a single chunk if the text is <= TARGET_TOKENS.
 * - `chunkIndex` is 0-based and sequential.
 */
export function chunkText(text: string): Chunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const totalTokens = countTokens(text);
  if (totalTokens <= TARGET_TOKENS) {
    return [{ content: text, tokenCount: totalTokens, chunkIndex: 0 }];
  }

  // Split into topically-coherent sections first (so a chunk never bundles
  // unrelated sections together and dilutes its embedding), then within each
  // section, produce fine-grained segments and greedily reassemble into
  // chunks with overlap.
  const sections = splitIntoSections(text);
  const rawChunks = sections.flatMap((section) => {
    if (section.trim().length === 0) return [];
    const segments = splitToSegments(section);
    return assembleChunks(segments);
  });

  return rawChunks.map((content, idx) => ({
    content,
    tokenCount: countTokens(content),
    chunkIndex: idx,
  }));
}
