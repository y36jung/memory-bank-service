# Future Slices

Deferred items from completed milestones that are below the HIGH threshold but worth addressing.

---

## From Milestone 2 (media extraction)

### MEDIUM — Unbounded keyframe count in `video.ts`

**File:** `src/services/extractor/video.ts`
**Issue:** `extractKeyframes` extracts one frame every 10 seconds with no ceiling. A 2-hour video produces ~720 frames, each triggering a GPT-4o Vision call. This can result in very long processing times, high API costs, and potential timeouts even with `MEDIA_EXTRACT_TIMEOUT_MS`.
**Suggested fix:** Cap keyframe count (e.g., max 60 frames). Sample evenly across the video duration using ffmpeg's `select='not(mod(n,N))'` filter or a calculated fps value, so a 2-hour video still gets representative coverage without 720 calls.

### INFO — Sidecar key suffix not shared between `image.ts` and `video.ts`

**File:** `src/services/extractor/video.ts` (line where sidecarKey is constructed)
**Issue:** `video.ts` hard-codes `'.vision-cache.json'` as an inline string, while `image.ts` defines a module-level `SIDECAR_SUFFIX` constant. The two are currently in sync, but a future rename could cause them to diverge silently.
**Suggested fix:** Move `SIDECAR_SUFFIX = '.vision-cache.json'` to a shared location (e.g., `src/services/extractor/constants.ts` or the bottom of `index.ts`) and import it in both `image.ts` and `video.ts`.
