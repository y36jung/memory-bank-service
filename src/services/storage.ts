import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Stream an object to S3 using multipart upload. The Upload class from @aws-sdk/lib-storage
 * performs true streaming multipart upload without materialising the body in memory.
 *
 * @param key         S3 object key
 * @param stream      Readable stream of the file content
 * @param contentType MIME type
 */
export async function uploadStream(
  key: string,
  stream: Readable,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: { Bucket: env.S3_BUCKET_NAME, Key: key, Body: stream, ContentType: contentType },
  });
  await upload.done();
}

/**
 * Return a Readable stream for an S3 object.
 * Throws AppError('S3_NOT_FOUND', ..., 404) if the key does not exist.
 */
export async function getStream(key: string): Promise<Readable> {
  const { stream } = await getStreamWithLength(key);
  return stream;
}

/**
 * Return a Readable stream and the S3 ContentLength for an object.
 * Throws AppError('S3_NOT_FOUND', ..., 404) if the key does not exist.
 */
export async function getStreamWithLength(
  key: string,
): Promise<{ stream: Readable; contentLength: number | null }> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET_NAME,
        Key: key,
      }),
    );

    const contentLength = response.ContentLength ?? null;

    if (!(response.Body instanceof Readable)) {
      const body = response.Body;
      if (body == null) {
        throw new AppError('S3_NOT_FOUND', 'Object not found', 404);
      }
      return { stream: body as unknown as Readable, contentLength };
    }

    return { stream: response.Body, contentLength };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const name = (err as { name?: string }).name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      throw new AppError('S3_NOT_FOUND', 'Object not found', 404);
    }
    throw err;
  }
}

/**
 * Delete an S3 object. Idempotent — S3 delete of a non-existent key is a no-op.
 */
export async function deleteObject(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    }),
  );
}

/**
 * Delete every S3 object under a key prefix. Paginates ListObjectsV2
 * (ContinuationToken/IsTruncated) and batch-deletes each page via
 * DeleteObjects. Both AWS operations cap at 1000 keys, so one list page maps
 * to exactly one delete batch.
 *
 * Errors are PROPAGATED (not swallowed) — same contract as deleteObject; the
 * caller decides fatal vs non-fatal. DeleteObjects can return HTTP 200 with a
 * non-empty `Errors` array for per-key failures the SDK does NOT throw for, so
 * this function throws a summarizing Error in that case for uniform handling.
 */
export async function deleteObjectsByPrefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined = undefined;
  do {
    const listed: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string')
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      const deleted = await s3.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET_NAME,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if (deleted.Errors && deleted.Errors.length > 0) {
        const summary = deleted.Errors.map((e) =>
          `${e.Key ?? '?'}: ${e.Code ?? ''} ${e.Message ?? ''}`.trim(),
        ).join('; ');
        throw new Error(
          `deleteObjectsByPrefix: ${deleted.Errors.length} key(s) failed to delete: ${summary}`,
        );
      }
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Returns the ContentLength of an S3 object in bytes, or null if the key does not exist.
 */
export async function headObject(key: string): Promise<number | null> {
  try {
    const response = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }));
    return response.ContentLength ?? null;
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound' || name === '404') return null;
    throw err;
  }
}

/**
 * Writes a Buffer or string to S3. Used for sidecar cache files.
 */
export async function putObject(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Downloads an S3 object and returns it as a Buffer.
 * Returns null if the key does not exist (NoSuchKey / NotFound).
 */
export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }));
    if (!response.Body) return null;
    const stream = response.Body as unknown as import('node:stream').Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound' || name === '404') return null;
    throw err;
  }
}

/**
 * Build the S3 object key for an uploaded document, namespaced by owning user.
 *
 * Pure — no I/O. The returned key is persisted verbatim into documents.storage_key
 * and later dereferenced as-is by every read/delete path (file.ts, list.ts), so the
 * format is free to differ from any legacy key already stored.
 *
 * @param userId     owning users.id (request.user.id)
 * @param documentId the freshly-minted document UUID
 * @param filename   the uploaded file's name (passed through verbatim, no sanitization)
 * @returns `users/<userId>/documents/<documentId>/<filename>`
 */
export function buildDocumentStorageKey(
  userId: string,
  documentId: string,
  filename: string,
): string {
  return `users/${userId}/documents/${documentId}/${filename}`;
}
