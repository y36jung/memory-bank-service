import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { putObject } from '../storage.js';
import { db } from '../../db/index.js';
import { documents, ingestionJobs } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import { ingestionQueue } from '../../queue/index.js';
import { randomUUID } from 'node:crypto';
import { withTimeout } from '../../lib/utils.js';

const EXPORT_MIME_MAP: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

function buildDriveClient(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

async function listDriveFiles(
  drive: drive_v3.Drive,
  afterDate?: Date,
): Promise<drive_v3.Schema$File[]> {
  const mimeFilter = [
    "mimeType = 'application/vnd.google-apps.document'",
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "mimeType = 'application/vnd.google-apps.presentation'",
    "mimeType = 'application/pdf'",
    "mimeType = 'text/plain'",
  ].join(' OR ');

  let q = `(${mimeFilter}) AND trashed = false`;
  if (afterDate) {
    q += ` AND modifiedTime > '${afterDate.toISOString()}'`;
  }

  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  while (true) {
    const response = await withTimeout(
      drive.files.list({
        q,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
      15_000,
      'drive file list',
    );

    files.push(...(response.data.files ?? []));
    if (!response.data.nextPageToken || files.length >= 1000) break;
    pageToken = response.data.nextPageToken;
  }

  return files;
}

async function isDriveFileAlreadyIndexed(fileId: string, modifiedTime: string): Promise<boolean> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      sql`${documents.sourceType} = 'gdrive'
        AND ${documents.metadata}->>'driveFileId' = ${fileId}
        AND ${documents.metadata}->>'modifiedTime' = ${modifiedTime}
        AND ${documents.status} IN ('pending', 'processing', 'indexed')`,
    )
    .limit(1);
  return rows.length > 0;
}

async function exportGoogleDoc(
  drive: drive_v3.Drive,
  fileId: string,
  exportMimeType: string,
): Promise<Buffer> {
  const response = await withTimeout(
    drive.files.export({ fileId, mimeType: exportMimeType }, { responseType: 'arraybuffer' }),
    60_000,
    'drive export',
  );
  return Buffer.from(response.data as ArrayBuffer);
}

async function downloadDriveFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const response = await withTimeout(
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }),
    60_000,
    'drive download',
  );
  return Buffer.from(response.data as ArrayBuffer);
}

async function getFileBuffer(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { mimeType: fileMimeType, id: fileId } = file;
  if (!fileId || !fileMimeType) {
    throw new Error(`Drive file missing id or mimeType: ${JSON.stringify(file)}`);
  }

  if (fileMimeType in EXPORT_MIME_MAP) {
    const exportMimeType = EXPORT_MIME_MAP[fileMimeType];
    if (!exportMimeType) throw new Error(`No export MIME mapping for ${fileMimeType}`);
    const buffer = await exportGoogleDoc(drive, fileId, exportMimeType);
    return { buffer, mimeType: exportMimeType };
  }

  // Native file (PDF, text/plain)
  const buffer = await downloadDriveFile(drive, fileId);
  return { buffer, mimeType: fileMimeType };
}

async function uploadFileToS3(fileId: string, buffer: Buffer, mimeType: string): Promise<string> {
  const key = `oauth/gdrive/${fileId}`;
  await putObject(key, buffer, mimeType);
  return key;
}

async function enqueueDriveFileAsDocument(
  file: drive_v3.Schema$File,
  storageKey: string,
  mimeType: string,
): Promise<string> {
  if (!file.id || !file.modifiedTime) {
    throw new Error(`Drive file missing id or modifiedTime: ${JSON.stringify(file)}`);
  }
  const driveFileId = file.id;
  const modifiedTime = file.modifiedTime;
  const documentId = randomUUID();
  const bullJobId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      filename: file.name ?? `drive-file-${driveFileId}`,
      originalName: file.name ?? `drive-file-${driveFileId}`,
      sourceType: 'gdrive',
      mimeType,
      storageKey,
      status: 'pending',
      sizeBytes: file.size ? parseInt(file.size, 10) : null,
      metadata: { driveFileId, modifiedTime },
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

export async function syncGoogleDrive(
  accessToken: string,
  lastSyncedAt: Date | null,
): Promise<{ synced: number; skipped: number }> {
  const drive = buildDriveClient(accessToken);
  const files = await listDriveFiles(drive, lastSyncedAt ?? undefined);

  let synced = 0;
  let skipped = 0;

  for (const file of files) {
    if (!file.id || !file.modifiedTime) continue;
    if (await isDriveFileAlreadyIndexed(file.id, file.modifiedTime)) {
      skipped++;
      continue;
    }
    const { buffer, mimeType } = await getFileBuffer(drive, file);
    const storageKey = await uploadFileToS3(file.id, buffer, mimeType);
    await enqueueDriveFileAsDocument(file, storageKey, mimeType);
    synced++;
  }

  return { synced, skipped };
}
