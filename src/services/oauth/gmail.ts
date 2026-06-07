import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import * as cheerio from 'cheerio';
import { putObject } from '../storage.js';
import { db } from '../../db/index.js';
import { documents, ingestionJobs } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import { ingestionQueue } from '../../queue/index.js';
import { randomUUID } from 'node:crypto';
import { withTimeout } from '../../lib/utils.js';

interface GmailThread {
  threadId: string;
  subject: string;
  fullText: string;
}

function buildGmailClient(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

export function decodeBase64Url(encoded: string): string {
  // Gmail uses URL-safe base64 — replace - with + and _ with /
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

function extractMessageBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  // Prefer text/plain
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Walk parts recursively
  if (payload.parts && payload.parts.length > 0) {
    // First pass: look for text/plain in parts
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Second pass: recurse into multipart parts
    for (const part of payload.parts) {
      const result = extractMessageBody(part);
      if (result) return result;
    }
  }

  // Fall back to HTML
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decodeBase64Url(payload.body.data);
    const $ = cheerio.load(html);
    return $.text();
  }

  return '';
}

async function fetchThread(gmail: gmail_v1.Gmail, threadId: string): Promise<GmailThread> {
  const response = await withTimeout(
    gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }),
    30_000,
    'gmail thread fetch',
  );

  const messages = (response.data.messages ?? []).slice().reverse(); // oldest-first
  let subject = '';
  const parts: string[] = [];

  for (const message of messages) {
    const headers = message.payload?.headers ?? [];
    const subjectHeader = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
    const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
    const date = headers.find((h) => h.name?.toLowerCase() === 'date')?.value ?? '';
    if (!subject && subjectHeader) subject = subjectHeader;
    const body = extractMessageBody(message.payload ?? undefined);
    parts.push(`\n\n---\nFrom: ${from}\nDate: ${date}\nSubject: ${subjectHeader}\n\n${body}\n`);
  }

  return { threadId, subject, fullText: parts.join('') };
}

async function listThreadIds(
  gmail: gmail_v1.Gmail,
  query: string,
  afterDate?: Date,
): Promise<string[]> {
  let q = query;
  if (afterDate) {
    q = `${q} after:${Math.floor(afterDate.getTime() / 1000)}`.trim();
  }

  const threadIds: string[] = [];
  let pageToken: string | undefined;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const response = await withTimeout(
      gmail.users.threads.list({
        userId: 'me',
        q,
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      }),
      15_000,
      'gmail thread list',
    );

    for (const thread of response.data.threads ?? []) {
      if (thread.id) threadIds.push(thread.id);
    }

    if (!response.data.nextPageToken) break;
    pageToken = response.data.nextPageToken;
  }

  return threadIds;
}

async function isThreadAlreadyIndexed(threadId: string): Promise<boolean> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      sql`${documents.sourceType} = 'gmail'
        AND ${documents.metadata}->>'gmailThreadId' = ${threadId}
        AND ${documents.status} IN ('pending', 'processing', 'indexed')`,
    )
    .limit(1);
  return rows.length > 0;
}

async function uploadThreadToS3(thread: GmailThread): Promise<string> {
  const key = `oauth/gmail/${thread.threadId}.txt`;
  await putObject(key, thread.fullText, 'text/plain');
  return key;
}

async function enqueueThreadAsDocument(thread: GmailThread, storageKey: string): Promise<string> {
  const documentId = randomUUID();
  const bullJobId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      filename: `gmail-thread-${thread.threadId}.txt`,
      originalName: thread.subject || `Gmail Thread ${thread.threadId}`,
      sourceType: 'gmail',
      mimeType: 'text/plain',
      storageKey,
      status: 'pending',
      metadata: { gmailThreadId: thread.threadId, subject: thread.subject },
    });
    await tx.insert(ingestionJobs).values({
      documentId,
      bullJobId,
      status: 'queued',
      attempt: 1,
    });
  });

  await ingestionQueue.add('ingest', { documentId, storageKey, attempt: 1 }, { jobId: bullJobId });
  return documentId;
}

export async function syncGmail(
  accessToken: string,
  lastSyncedAt: Date | null,
  query = '',
): Promise<{ synced: number; skipped: number }> {
  const gmail = buildGmailClient(accessToken);
  const threadIds = await listThreadIds(gmail, query, lastSyncedAt ?? undefined);

  let synced = 0;
  let skipped = 0;

  for (const threadId of threadIds) {
    if (await isThreadAlreadyIndexed(threadId)) {
      skipped++;
      continue;
    }
    const thread = await fetchThread(gmail, threadId);
    const storageKey = await uploadThreadToS3(thread);
    await enqueueThreadAsDocument(thread, storageKey);
    synced++;
  }

  return { synced, skipped };
}
