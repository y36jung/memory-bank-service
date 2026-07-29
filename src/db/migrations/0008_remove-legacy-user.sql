-- Custom SQL migration file, put your code below! --

-- Removes the synthetic "legacy@memory-bank.local" user seeded by
-- 0005_add_users_table.sql to own pre-existing single-tenant data during the
-- single→multi-user conversion. No longer needed now that every account is a
-- real registered (or beta/demo) user. This cascades (ON DELETE CASCADE) to
-- any documents/chat_sessions/refresh_tokens still owned by this user — safe
-- here since none exist, but note a raw SQL cascade does not clean up any
-- corresponding S3 objects or Qdrant vectors the way DELETE /auth/me does.
DELETE FROM "users" WHERE "id" = '00000000-0000-0000-0000-000000000001';