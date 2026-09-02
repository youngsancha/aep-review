// Supabase JS 클라이언트 (빌드 무필요 — ESM CDN import).
// 셀프호스팅 단일 파일 번들(scripts/vendor_supabase.sh). esm.sh 의 떠다니는 @2 포인터 + 17개 파일
// import 체인이 오프라인 부팅을 깨뜨렸다(v? + 스켈레톤) — 근거는 그 스크립트 상단 주석.
import { createClient } from '/vendor/supabase-js.mjs';
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
