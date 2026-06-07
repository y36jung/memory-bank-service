import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

function getKey(): Buffer {
  if (!env.OAUTH_ENCRYPTION_KEY) {
    throw new AppError('OAUTH_NOT_CONFIGURED', 'OAUTH_ENCRYPTION_KEY is not set', 500);
  }
  return Buffer.from(env.OAUTH_ENCRYPTION_KEY, 'hex');
}

// Returns "iv_b64:authTag_b64:ciphertext_b64"
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(
    ':',
  );
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivB64, authTagB64, encB64] = ciphertext.split(':');
  if (!ivB64 || !authTagB64 || !encB64) {
    throw new AppError('DECRYPT_FAILED', 'Malformed ciphertext', 500);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError('DECRYPT_FAILED', 'Token decryption failed', 500);
  }
}

export function encryptTokens(access: string, refresh: string | null | undefined) {
  return {
    accessToken: encrypt(access),
    refreshToken: refresh != null ? encrypt(refresh) : null,
  };
}

export function decryptTokens(row: { accessToken: string; refreshToken: string | null }) {
  return {
    accessToken: decrypt(row.accessToken),
    refreshToken: row.refreshToken != null ? decrypt(row.refreshToken) : null,
  };
}
