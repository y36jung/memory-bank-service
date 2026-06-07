/**
 * E2: Unit tests for src/services/oauth/token.ts
 *
 * Tests pure AES-256-GCM encrypt/decrypt functions.
 * No mocking needed — these are crypto-only functions.
 *
 * Criteria covered:
 * - Encrypt/decrypt round-trip produces the original plaintext.
 * - Two encryptions of the same plaintext produce different ciphertext (IV randomness).
 * - Decrypt throws AppError on tampered auth tag.
 * - Decrypt throws AppError on malformed ciphertext.
 * - encryptTokens / decryptTokens round-trip.
 * - encryptTokens with null refresh token returns null refreshToken.
 */

import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  encryptTokens,
  decryptTokens,
} from '../../../../src/services/oauth/token.js';
import { AppError } from '../../../../src/lib/errors.js';

describe('token encryption', () => {
  it('round-trips encrypt→decrypt', () => {
    const original = 'my-secret-access-token';
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('two encryptions of the same string produce different ciphertext', () => {
    const c1 = encrypt('same');
    const c2 = encrypt('same');
    expect(c1).not.toBe(c2);
  });

  it('decrypt throws on tampered auth tag', () => {
    const ct = encrypt('hello');
    const parts = ct.split(':');
    // Corrupt the auth tag (second segment)
    const tampered = [parts[0], 'AAAAAAAAAAAAAAAAAAAAAA==', parts[2]].join(':');
    expect(() => decrypt(tampered)).toThrow(AppError);
  });

  it('decrypt throws on malformed ciphertext', () => {
    expect(() => decrypt('not-valid-base64-only-two:parts')).toThrow(AppError);
  });

  it('encryptTokens / decryptTokens round-trip', () => {
    const { accessToken, refreshToken } = encryptTokens('access', 'refresh');
    const result = decryptTokens({ accessToken, refreshToken });
    expect(result.accessToken).toBe('access');
    expect(result.refreshToken).toBe('refresh');
  });

  it('encryptTokens with null refresh token returns null', () => {
    const { refreshToken } = encryptTokens('access', null);
    expect(refreshToken).toBeNull();
  });
});
