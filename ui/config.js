// Supabase 공개 설정 — 커밋해도 안전(RLS 가 데이터를 보호).
// supabase/README.md 의 3단계에서 Project URL / anon public key 를 복사해 채운다.
//
// ⚠️ service_role(secret) 키는 절대 여기 넣지 말 것 (프론트는 publishable/anon 키만).
export const SUPABASE_URL = 'https://lbcvuztpyaapyckxmqhk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Ql1_5-UEpclxRc8LLQ3D2A_3748Xz07';
