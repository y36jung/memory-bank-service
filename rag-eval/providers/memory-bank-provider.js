/**
 * Custom promptfoo provider for the Memory Bank /api/chat endpoints.
 *
 * Auth: every route is JWT-gated and scoped to the calling user. On first
 * use, registers (or logs in, if already registered) a dedicated eval user
 * and caches the access token for the lifetime of this `promptfoo eval`
 * process; re-authenticates once on a 401 from any downstream call.
 *
 * Session: a fresh chat session is created per test case (per `callApi`
 * call) unless `context.vars.sessionId` is explicitly provided, so unrelated
 * test cases never see each other's chat history.
 *
 * SSE: the real stream has no named `event:` field — every line is
 * `data: <json>` with a `type` discriminator (`delta` | `done` | `error`).
 */

import { getAccessToken } from '../scripts/auth.mjs';

const BASE_URL = process.env.MEMORY_BANK_API_URL || 'http://localhost:3000';
const EVAL_USER_EMAIL = process.env.EVAL_USER_EMAIL;
const EVAL_USER_PASSWORD = process.env.EVAL_USER_PASSWORD;

let tokenPromise = null;

function getToken() {
  if (!tokenPromise) {
    if (!EVAL_USER_EMAIL || !EVAL_USER_PASSWORD) {
      throw new Error('EVAL_USER_EMAIL and EVAL_USER_PASSWORD must be set (see .env.example)');
    }
    tokenPromise = getAccessToken(BASE_URL, EVAL_USER_EMAIL, EVAL_USER_PASSWORD);
  }
  return tokenPromise;
}

function resetToken() {
  tokenPromise = null;
}

async function authedFetch(path, init, retrying = false) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && !retrying) {
    resetToken();
    return authedFetch(path, init, true);
  }

  return res;
}

async function createSession() {
  const res = await authedFetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'promptfoo-eval' }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create chat session: HTTP ${res.status}: ${await res.text()}`);
  }

  const { data } = await res.json();
  return data.id;
}

async function sendMessage(sessionId, message) {
  const res = await authedFetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send message: HTTP ${res.status}: ${await res.text()}`);
  }

  let buffer = '';
  let answer = '';
  let sources = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;

    buffer += decoder.decode(value, { stream: true });
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = JSON.parse(line.slice(6));

        if (payload.type === 'delta') {
          answer += payload.content;
        } else if (payload.type === 'done') {
          sources = payload.sources || [];
        } else if (payload.type === 'error') {
          throw new Error(`Chat stream error: ${payload.message}`);
        }
      }
    }
  }

  return { answer, sources };
}

// promptfoo's file:// loader does `new (importedDefaultExport)(options)`, so
// the default export must be a constructor, not a plain object.
export default class MemoryBankChatProvider {
  constructor(options) {
    this.providerId = options?.id || 'memory-bank-chat';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    try {
      const sessionId = context?.vars?.sessionId || (await createSession());
      const { answer, sources } = await sendMessage(sessionId, prompt);

      return {
        output: answer,
        metadata: { sources },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
