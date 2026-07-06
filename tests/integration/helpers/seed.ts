import { randomUUID } from 'node:crypto';
import { db } from '../../../src/db/index.js';
import { users, documents, chatSessions } from '../../../src/db/schema.js';

export async function seedUser(emailPrefix: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `${emailPrefix}-${randomUUID()}@test.local` })
    .returning();
  if (!user) throw new Error('seedUser: insert returned no row');
  return user;
}

export async function seedDocument(
  userId: string,
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  const [doc] = await db
    .insert(documents)
    .values({
      userId,
      filename: 'seed.txt',
      originalName: 'seed.txt',
      sourceType: 'upload',
      mimeType: 'text/plain',
      storageKey: `documents/${randomUUID()}/seed.txt`,
      status: 'indexed',
      ...overrides,
    })
    .returning();
  if (!doc) throw new Error('seedDocument: insert returned no row');
  return doc;
}

export async function seedChatSession(
  userId: string,
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
) {
  const [session] = await db
    .insert(chatSessions)
    .values({ userId, title: 'Seeded session', ...overrides })
    .returning();
  if (!session) throw new Error('seedChatSession: insert returned no row');
  return session;
}
