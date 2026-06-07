/**
 * Vitest setup file — must run before any test file imports src/ modules.
 * Populates process.env with the minimum set of values required to pass
 * the Zod env schema in src/config/env.ts without calling process.exit(1).
 */

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/memorybank_test';
process.env['QDRANT_URL'] = 'http://localhost:6333';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['AWS_REGION'] = 'us-east-1';
process.env['AWS_ACCESS_KEY_ID'] = 'test-access-key-id';
process.env['AWS_SECRET_ACCESS_KEY'] = 'test-secret-access-key';
process.env['S3_BUCKET_NAME'] = 'test-bucket';
process.env['OPENAI_API_KEY'] = 'sk-test-openai-key-placeholder-for-unit-tests';
process.env['JWT_SECRET'] = 'test-jwt-secret-that-is-at-least-32-chars!!';
process.env['GOOGLE_CLIENT_ID'] = 'test-google-client-id';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-google-client-secret';
process.env['GOOGLE_REDIRECT_URI'] = 'http://localhost:3000/api/oauth/google/callback';
process.env['OAUTH_ENCRYPTION_KEY'] = 'a'.repeat(64); // 64 valid hex chars
