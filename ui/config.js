// Supabase 공개 설정 — 커밋해도 안전(RLS 가 데이터를 보호).
// supabase/README.md 의 3단계에서 Project URL / anon public key 를 복사해 채운다.
//
// ⚠️ service_role(secret) 키는 절대 여기 넣지 말 것 (프론트는 publishable/anon 키만).
export const SUPABASE_URL = 'https://lbcvuztpyaapyckxmqhk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Ql1_5-UEpclxRc8LLQ3D2A_3748Xz07';

// 쇼 커버 아트워크 (megaphone imgix — w/h 리사이즈·webp 자동). RSS 에 에피소드별 이미지가
// 없어 전 에피소드가 공유한다. 앱 아이콘 대신 실제 팟캐스트 아트워크 사용 → Apple Podcasts 느낌.
const _COVER = 'https://megaphone.imgix.net/podcasts/15526600-fb41-11ee-92ae-93bb88e95bb6/image/17f5482ab2cc597b1acfc1f8b7dc45e8.jpg?auto=format,compress&fit=crop';
export const SHOW_COVER = _COVER + '&w=720&h=720';
export const SHOW_COVER_SM = _COVER + '&w=160&h=160';
