// Shared register-or-login helper for the eval user. Used by the promptfoo
// provider, setup.mjs, and lifecycle-eval.mjs so the register/login/retry
// dance lives in one place.

export async function getAccessToken(baseUrl, email, password) {
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (registerRes.ok) {
    const { data } = await registerRes.json();
    return data.accessToken;
  }

  if (registerRes.status !== 409) {
    throw new Error(
      `Failed to register eval user: HTTP ${registerRes.status}: ${await registerRes.text()}`,
    );
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    throw new Error(
      `Failed to log in eval user: HTTP ${loginRes.status}: ${await loginRes.text()}`,
    );
  }

  const { data } = await loginRes.json();
  return data.accessToken;
}
