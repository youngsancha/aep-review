// Supabase JS 클라이언트 (빌드 무필요 — ESM CDN import).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '/config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,        // 폰에서 1회 로그인 후 세션 유지
    autoRefreshToken: true,
    storage: window.localStorage,
    flowType: 'pkce',            // Google OAuth — PKCE(코드 교환). SPA 안전 표준.
    detectSessionInUrl: true,    // OAuth 리다이렉트(?code=) 복귀 시 자동으로 세션 교환
  },
});

// public Storage 객체 베이스 URL (transcripts/{id}.json, tts/{sha1}.mp3)
export const STORAGE_URL = `${SUPABASE_URL}/storage/v1/object/public`;
