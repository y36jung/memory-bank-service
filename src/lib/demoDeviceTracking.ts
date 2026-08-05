import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { demoDevices } from '../db/schema.js';

/**
 * Upserts a demo device sighting: inserts a fresh row on first sighting,
 * otherwise bumps lastSeenAt. Returns true only when the row was newly
 * inserted, so callers can log/notify on "new demo user" without a second
 * round trip.
 */
export async function recordDemoDeviceSeen(deviceId: string): Promise<boolean> {
  // xmax is the inserting transaction's id; it's 0 only on a row that was
  // just INSERTed, never on one reached via the ON CONFLICT UPDATE branch.
  const [row] = await db
    .insert(demoDevices)
    .values({ deviceId })
    .onConflictDoUpdate({
      target: demoDevices.deviceId,
      set: { lastSeenAt: sql`now()` },
    })
    .returning({ isNew: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error('recordDemoDeviceSeen: upsert returned no row');
  return row.isNew;
}
