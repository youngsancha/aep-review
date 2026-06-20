// Supabase 공개 설정 — 커밋해도 안전(RLS 가 데이터를 보호).
// supabase/README.md 의 3단계에서 Project URL / anon public key 를 복사해 채운다.
//
// ⚠️ service_role(secret) 키는 절대 여기 넣지 말 것 (프론트는 publishable/anon 키만).
export const SUPABASE_URL = 'https://lbcvuztpyaapyckxmqhk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Ql1_5-UEpclxRc8LLQ3D2A_3748Xz07';

// Cloudflare R2 공개(읽기) 베이스 — 우리가 STT 한 '바로 그 오디오'를 호스팅. 공개 URL 이라 커밋 OK.
// 앱은 호스팅된 회차(audio_hosted.json 매니페스트)만 여기서 스트리밍 → 자막=오디오 영구 일치(완전 자동 싱크).
export const R2_PUBLIC_BASE = 'https://pub-6226ae33abbc474dbea6ae140582eb8d.r2.dev';
export function hostedAudioUrl(id) { return `${R2_PUBLIC_BASE}/${id}.mp3`; }

// MyMemory 번역 API 무료 한도 키. 익명은 하루 ~1천 단어로 금방 소진(429) → 이메일 지정 시
// 하루 5만 단어. 이 repo 는 PRIVATE 이라 노출 위험 없음. 비우면 익명으로 동작(권장X).
export const TRANSLATE_EMAIL = 'yscha.roy@gmail.com';

// 쇼 커버 아트워크 (megaphone imgix — w/h 리사이즈·webp 자동). RSS 에 에피소드별 이미지가
// 없어 전 에피소드가 공유한다. 앱 아이콘 대신 실제 팟캐스트 아트워크 사용 → Apple Podcasts 느낌.
const _COVER = 'https://megaphone.imgix.net/podcasts/15526600-fb41-11ee-92ae-93bb88e95bb6/image/17f5482ab2cc597b1acfc1f8b7dc45e8.jpg?auto=format,compress&fit=crop';
export const SHOW_COVER = _COVER + '&w=720&h=720';
export const SHOW_COVER_SM = _COVER + '&w=160&h=160';
