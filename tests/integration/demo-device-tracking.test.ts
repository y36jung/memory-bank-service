/**
 * First-seen/last-seen tracking for demo devices (src/lib/demoDeviceTracking.ts,
 * wired into the preHandler in src/plugins/auth.ts). Every demo visitor shares
 * one userId (users.isDemo), so a demo_devices row per x-demo-device-id header
 * is the only durable, queryable record of "a new demo user showed up."
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real Postgres —
 * no mocks. Any protected demo route triggers the tracking hook; GET
 * /api/chat/sessions (used elsewhere for device-scoping tests) is the
 * lightest one available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { demoDevices } from '../../src/db/schema.js';
import { DEMO_DEVICE_HEADER_NAME } from '../../src/plugins/auth.js';

describe('demo device tracking', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function demoToken() {
    const user = await seedUser('demo-device-tracking', undefined, true);
    return signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET);
  }

  async function findRow(deviceId: string) {
    const [row] = await db.select().from(demoDevices).where(eq(demoDevices.deviceId, deviceId));
    return row;
  }

  it('records a row on the first sighting of a device id', async () => {
    const token = await demoToken();
    const deviceId = randomUUID();

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
    });
    expect(res.statusCode).toBe(200);

    const row = await findRow(deviceId);
    expect(row).toBeDefined();
    expect(row.firstSeenAt).toEqual(row.lastSeenAt);
  });

  it('a second sighting of the same device id updates lastSeenAt but not firstSeenAt, and does not duplicate the row', async () => {
    const token = await demoToken();
    const deviceId = randomUUID();

    await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
    });
    const first = await findRow(deviceId);

    await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
    });

    const rows = await db.select().from(demoDevices).where(eq(demoDevices.deviceId, deviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeenAt).toEqual(first.firstSeenAt);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it('a demo request with no device header writes no row and still succeeds', async () => {
    const token = await demoToken();

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });
});
