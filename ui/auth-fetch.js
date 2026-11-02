// A token refresh the server did not actually judge must never end the session.
//
// supabase-js splits refresh failures in two. Retryable ones (no response, or a 5xx with no JSON body)
// keep the session. Everything else counts as "this refresh token is bad", and once the access token
// has expired it calls _removeSession(). So an outage logged the owner out: on 2026-10-11 the Storage
// quota restriction made every call answer 402, the one-hour JWT lapsed, and the app silently dropped
// to the login screen with a refresh token that was still perfectly valid.
//
// These statuses say nothing about the token, so they are reported as a 503, which the library retries
// and then gives up on without touching the session. A real verdict (400 refresh_token_not_found or
// refresh_token_already_used, 401, 403) passes through untouched: that one must still sign out.
const REFRESH_PATH = '/auth/v1/token?grant_type=refresh_token';
const NOT_A_VERDICT = new Set([402, 408, 425, 429]);

export function keepSessionOnOutage(baseFetch) {
  return async (input, init) => {
    const res = await baseFetch(input, init);
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (!NOT_A_VERDICT.has(res.status) || !url.includes(REFRESH_PATH)) return res;
    console.warn('[auth] token refresh answered', res.status, '— keeping the session');
    return new Response(null, { status: 503, statusText: `Refresh unavailable (${res.status})` });
  };
}
