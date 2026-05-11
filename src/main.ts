import { buildApp } from './app.js';
import { closeDb } from './db/index.js';

const port = Number(process.env['PORT'] ?? 3000);
const app = await buildApp();
await app.listen({ port, host: '0.0.0.0' });

const shutdown = async () => {
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] error during graceful shutdown:', err);
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
