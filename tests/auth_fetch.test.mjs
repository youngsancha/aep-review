// keepSessionOnOutage against the real vendored supabase-js: an outage answer on token refresh must not
// log the owner out, and a real "bad refresh token" answer still must.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../ui/vendor/supabase-js.mjs';
import { keepSessionOnOutage } from '../ui/auth-fetch.js';

const URL_BASE = 'https://proj.supabase.co';
const KEY_NAME = 'sb-proj-auth-token';
const REFRESH_URL = `${URL_BASE}/auth/v1/token?grant_type=refresh_token`;

const memoryStorage = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
};
const jwtBody = (exp) => Buffer.from(JSON.stringify({ sub: 'u1', exp, role: 'authenticated' })).toString('base64url');
const session = (exp) => ({
  access_token: `h.${jwtBody(exp)}.s`, refresh_token: 'still-valid', token_type: 'bearer',
  expires_in: 3600, expires_at: exp, user: { id: 'u1', aud: 'authenticated' },
});
const expired = () => session(Math.floor(Date.now() / 1000) - 60);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Runs one refresh of an expired session through `fetchImpl`, returns what is left in storage.
async function refreshOnce(fetchImpl) {
  const storage = memoryStorage({ [KEY_NAME]: JSON.stringify(expired()) });
  const client = createClient(URL_BASE, 'anon', {
    auth: { storage, storageKey: KEY_NAME, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
  const { error } = await client.auth.getSession();
  return { stored: storage.getItem(KEY_NAME), error };
}

test('control: without the wrapper a 402 on refresh removes the session', async () => {
  const { stored } = await refreshOnce(async () => json(402, { code: 'exceed_storage_size_quota', message: 'quota' }));
  assert.equal(stored, null);
});

test('a 402 on refresh keeps the session: the library retries and the next answer logs in', async () => {
  const answers = [json(402, { message: 'quota' })];
  let calls = 0;
  const wrapped = keepSessionOnOutage(async () => {
    calls++;
    return answers.shift() ?? json(200, session(Math.floor(Date.now() / 1000) + 3600));
  });
  const { stored, error } = await refreshOnce(wrapped);
  assert.equal(calls, 2, 'the wrapped 503 must be retried');
  assert.equal(error, null);
  assert.ok(stored, 'session survived');
});

for (const status of [402, 408, 425, 429]) {
  test(`${status} on the refresh URL becomes a retryable 503`, async () => {
    const res = await keepSessionOnOutage(async () => json(status, {}))(REFRESH_URL, {});
    assert.equal(res.status, 503);
  });
}

test('a real verdict on the refresh token still signs out', async () => {
  const wrapped = keepSessionOnOutage(async () => json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }));
  const { stored } = await refreshOnce(wrapped);
  assert.equal(stored, null);
});

test('only the refresh call is rewritten', async () => {
  const f = keepSessionOnOutage(async () => json(402, {}));
  assert.equal((await f(`${URL_BASE}/rest/v1/episodes?select=*`, {})).status, 402);
  assert.equal((await f(`${URL_BASE}/auth/v1/token?grant_type=password`, {})).status, 402);
});

test('Request and URL inputs are recognised too', async () => {
  const f = keepSessionOnOutage(async () => json(429, {}));
  assert.equal((await f(new Request(REFRESH_URL, { method: 'POST' }))).status, 503);
  assert.equal((await f(new URL(REFRESH_URL))).status, 503);
});

test('a 200 passes through untouched', async () => {
  const ok = json(200, {});
  assert.equal(await keepSessionOnOutage(async () => ok)(REFRESH_URL, {}), ok);
});
