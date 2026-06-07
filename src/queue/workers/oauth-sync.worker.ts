import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { redisConnection } from '../index.js';
import type { OAuthSyncJobPayload } from '../index.js';
import { AppError } from '../../lib/errors.js';
import {
  getDecryptedTokens,
  hasScope,
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

      const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
      const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
      const gmailGranted = hasScope(tokenRow.scope, GMAIL_SCOPE);
      const driveGranted = hasScope(tokenRow.scope, DRIVE_SCOPE);

      if (!gmailGranted && !driveGranted) {
        throw new AppError(
          'NO_GRANTED_SCOPES',
          'No required Google scopes were granted; user must re-authenticate',
          403,
        );
      }

      let gmailResult = { synced: 0, skipped: 0 };
      if (gmailGranted) {
        gmailResult = await syncGmail(accessToken, tokenRow.lastSyncedAt, gmailQuery);
        void job.log(`Gmail: synced=${gmailResult.synced} skipped=${gmailResult.skipped}`);
      } else {
        void job.log('Gmail: skipped (scope not granted)');
      }

      let driveResult = { synced: 0, skipped: 0 };
      if (driveGranted) {
        driveResult = await syncGoogleDrive(accessToken, tokenRow.lastSyncedAt);
        void job.log(`Drive: synced=${driveResult.synced} skipped=${driveResult.skipped}`);
      } else {
        void job.log('Drive: skipped (scope not granted)');
      }

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
