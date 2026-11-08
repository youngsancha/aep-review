// An account RLS shuts out gets 200 and zero rows, the same as an empty show. libraryAccess() is what
// lets the library tell "you are not allowed" apart from "no episodes yet" (owner report 2026-11-08:
// a second account saw "0 episodes · all ready" on a healthy network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUiModules, installStorage } from './helpers/ui-modules.mjs';

installStorage();
globalThis.__sb = { session: null, rows: [], error: null, hang: false, signedOut: 0 };
resolveUiModules({
  '/config.js': `export const MULTISHOW = true; export const currentShow = () => 'aep';
    export const hostedAudioUrl = (u) => u;`,
  '/supabase.js': `const sb = () => globalThis.__sb;
    const query = { select() { return query; }, limit() { return query; }, eq() { return query; },
      order() { return query; },
      then(res, rej) {
        if (sb().hang) return new Promise(() => {}).then(res, rej);
        return Promise.resolve({ data: sb().rows, error: sb().error }).then(res, rej);
      } };
    export const supabase = {
      auth: { getSession: async () => ({ data: { session: sb().session } }),
              signOut: async () => { sb().signedOut++; } },
      from: () => query,
    };
    export const STORAGE_URL = 'https://x/storage';`,
});
const { libraryAccess, signOutForSwitch } = await import('/db.js');
const set = (o) => Object.assign(globalThis.__sb, { session: null, rows: [], error: null, hang: false }, o);
const me = { user: { email: 'b@example.com' } };

test('signed in and any show readable: ok (this show is just empty)', async () => {
  set({ session: me, rows: [{ id: 1 }] });
  assert.deepEqual(await libraryAccess(), { state: 'ok', email: 'b@example.com' });
});

test('signed in but the policy returns nothing at all: denied, with the email', async () => {
  set({ session: me, rows: [] });
  assert.deepEqual(await libraryAccess(), { state: 'denied', email: 'b@example.com' });
});

test('no session: signed-out, without asking the database', async () => {
  set({ session: null, rows: [{ id: 1 }] });
  assert.equal((await libraryAccess()).state, 'signed-out');
});

test('a failed probe says nothing new', async () => {
  set({ session: me, error: { message: 'boom' } });
  assert.equal((await libraryAccess()).state, 'unknown');
});

test('a probe that never answers gives up as unknown instead of hanging', { timeout: 10000 }, async () => {
  set({ session: me, hang: true });
  assert.equal((await libraryAccess()).state, 'unknown');
});

test('signOutForSwitch signs out', async () => {
  const before = globalThis.__sb.signedOut;
  await signOutForSwitch();
  assert.equal(globalThis.__sb.signedOut, before + 1);
});

// The offline bypass in app.js lets a phone in on a stored session. Since the move to roy-hub, phones
// still carry the old project's token, which must not count: it has no session on this project.
test('only the current project\'s stored token counts as a session', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const body = /export function storedSessionKey\([^)]*\) \{\n([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, 'storedSessionKey not found in ui/app.js');
  const storedSessionKey = new Function('url', body[1]);
  const { SUPABASE_URL } = await import(new URL('../ui/config.js', import.meta.url).href);
  assert.equal(storedSessionKey(SUPABASE_URL), `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`);
  assert.equal(storedSessionKey('https://lbcvuztpyaapyckxmqhk.supabase.co'), 'sb-lbcvuztpyaapyckxmqhk-auth-token');
  assert.doesNotMatch(src, /startsWith\('sb-'\)/, 'hasStoredSession must not accept any project\'s token');
});
