import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { redisConnection } from '../index.js';
import type { OAuthSyncJobPayload } from '../index.js';
import {
  getDecryptedTokens,
  refreshAccessTokenIfNeeded,
  updateLastSyncedAt,
} from '../../services/oauth/google.js';
import { syncGmail } from '../../services/oauth/gmail.js';
import { syncGoogleDrive } from '../../services/oauth/gdrive.js';

export const oauthSyncWorker = new Worker<OAuthSyncJobPayload, void>(
  'oauth-sync',
  async (job: Job<OAuthSyncJobPayload>) => {
    const { provider, gmailQuery = '' } = job.data;
    if (provider === 'google') {
      const tokenRow = await getDecryptedTokens();
      const accessToken = await refreshAccessTokenIfNeeded(tokenRow);
      const gmailResult = await syncGmail(accessToken, tokenRow.lastSyncedAt, gmailQuery);
      void job.log(`Gmail: synced=${gmailResult.synced} skipped=${gmailResult.skipped}`);
      const driveResult = await syncGoogleDrive(accessToken, tokenRow.lastSyncedAt);
      void job.log(`Drive: synced=${driveResult.synced} skipped=${driveResult.skipped}`);
      await updateLastSyncedAt(tokenRow.id);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

oauthSyncWorker.on('failed', (job, err) => {
  console.error(`[oauth-sync-worker] job ${job?.id} failed:`, err.message);
});

oauthSyncWorker.on('error', (err) => {
  console.error('[oauth-sync-worker] error', err);
});
