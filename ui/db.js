// 데이터 접근 shim — 기존 /api/* 응답 모양을 Supabase 직접 호출로 재현.
// 뷰(timeline/episode/srs)는 받는 데이터 모양만 같으면 거의 그대로 동작한다.
import { supabase, STORAGE_URL } from '/supabase.js';
import { hostedAudioUrl } from '/config.js';

const NEW_LIMIT = 5;
const REVIEW_LIMIT = 50;

// 로컬(폰) 기준 오늘 날짜 YYYY-MM-DD — srs due_date 비교용
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────── episodes ───────────────────────────
// GET /api/episodes 대체
export async function listEpisodes() {
  const { data, error } = await supabase
    .from('episodes_list')
    .select('*')
    .order('pub_date', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// 광고 리다이렉트 체인(podtrac/pscrb/swap.fm…)을 벗겨 megaphone CDN 직접 URL 로.
// RSS audio_url 은 6단계 302 광고 추적 래퍼라 모바일에서 재생 시작이 느리고/불안정하며,
// 요청마다 동적 광고가 끼어 길이가 달라져 트랜스크립트 타임스탬프와 어긋난다.
// 다행히 최종 megaphone 경로가 원본 문자열 끝에 그대로 박혀 있어 정규식으로 추출 가능.
const _MEGAPHONE = /(traffic\.megaphone\.fm\/[A-Za-z0-9_-]+\.mp3)/;
export function cleanAudioUrl(u) {
  if (!u) return u;
  const m = u.match(_MEGAPHONE);
  return m ? 'https://' + m[1] : u;
}

// 호스팅 완료 매니페스트 — 이 목록의 회차만 R2(자막=오디오)로 스트리밍. 1회 fetch 후 메모리 캐시.
let _hosted = null, _hostedP = null;
export async function hostedSet() {
  if (_hosted) return _hosted;
  if (!_hostedP) {
    _hostedP = fetch(`${STORAGE_URL}/transcripts/audio_hosted.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => { _hosted = new Set((a || []).map(Number)); return _hosted; })
      .catch(() => { _hosted = new Set(); return _hosted; });
  }
  return _hostedP;
}
// 회차 오디오 소스 결정: 호스팅됐으면 R2(광고 로테이션 무관·완전 일치), 아니면 기존 megaphone clean.
export async function audioSrcFor(id, audioUrl) {
  const h = await hostedSet();
  return h.has(Number(id)) ? hostedAudioUrl(id) : cleanAudioUrl(audioUrl);
}

// GET /api/episodes/{id} 대체 → { ...episode, vocab, transcript }
export async function getEpisode(id) {
  const { data: ep, error } = await supabase
    .from('episodes')
    .select(
      '*, vocab:vocab_cards(id, term, kind, definition, example_sentence, sentence_start_sec, sentence_end_sec)'
    )
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);

  // 원본 정렬: 타임스탬프 있는 것 먼저, 그 안에서 start asc, 그 다음 id asc
  ep.vocab = (ep.vocab || []).sort((a, b) => {
    const an = a.sentence_start_sec, bn = b.sentence_start_sec;
    if (an == null && bn == null) return a.id - b.id;
    if (an == null) return 1;
    if (bn == null) return -1;
    return an - bn || a.id - b.id;
  });
  ep.audio_url = await audioSrcFor(ep.id, ep.audio_url);  // 호스팅됐으면 R2(자막=오디오), 아니면 megaphone
  ep.transcript = await fetchTranscript(id, ep.transcribed_at);
  return ep;
}

async function fetchTranscript(id, transcribedAt) {
  if (!transcribedAt) return null;
  try {
    const r = await fetch(`${STORAGE_URL}/transcripts/${id}.json`, { cache: 'force-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────── Study (표현 탐색 허브) ───────────────────────────
async function _count(table, build) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

const STUDY_KINDS = ['idiom', 'phrasal_verb', 'collocation', 'word'];

// "알아요/마스터" 센티넬: interval_days >= 365 (markKnown 만 설정). 일반 SM-2 로는 잘 도달 안 함.
const KNOWN_INTERVAL = 365;

// Study 홈 통계 — 전체 표현 / 학습(reps>0) / 오늘 복습 / 알아요(마스터) / 종류별 개수
export async function studyOverview() {
  const today = todayStr();
  const [total, learned, due, known, ...kindCounts] = await Promise.all([
    _count('vocab_cards'),
    _count('srs_cards', (q) => q.gt('reps', 0)),
    _count('srs_cards', (q) => q.lte('due_date', today)),
    _count('srs_cards', (q) => q.gte('interval_days', KNOWN_INTERVAL)),
    ...STUDY_KINDS.map((k) => _count('vocab_cards', (q) => q.eq('kind', k))),
  ]);
  const byKind = STUDY_KINDS.map((k, i) => ({ kind: k, total: kindCounts[i] }));
  return { total, learned, due, known, byKind };
}

// "알아요" — 해당 vocab 의 SRS 카드를 마스터(1년 뒤 복습) 상태로. 진도(known)에 즉시 반영된다.
export async function markKnown(vocabId) {
  const due = new Date();
  due.setDate(due.getDate() + KNOWN_INTERVAL);
  const { error } = await supabase
    .from('srs_cards')
    .update({ interval_days: KNOWN_INTERVAL, reps: 4, ease: 2.6, due_date: todayStr(due) })
    .eq('vocab_id', vocabId);
  if (error) throw new Error(error.message);
}

// 종류별 표현 목록 (+ 에피소드 제목). 각 kind 는 1000행 미만이라 단일 쿼리로 충분.
export async function expressionsByKind(kind, limit = 800) {
  const { data, error } = await supabase
    .from('vocab_cards')
    .select('id, term, kind, definition, example_sentence, episode_id, sentence_start_sec, sentence_end_sec, episodes(title, audio_url), srs:srs_cards(interval_days)')
    .eq('kind', kind)
    .order('term', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map((v) => ({
    ...v,
    episode_title: v.episodes?.title || '',
    audio_url: cleanAudioUrl(v.episodes?.audio_url || ''),  // '맥락에서 듣기' 인라인 재생용(실제 음성)
    known: Array.isArray(v.srs) && v.srs.some((s) => (s.interval_days || 0) >= KNOWN_INTERVAL),
  }));
}

// ─────────────────────────── SRS ───────────────────────────
const GRADE_TO_Q = { again: 0, hard: 3, good: 4, easy: 5 };

// SM-2 업데이트 — SRS 채점의 단일 출처(클라이언트)
function sm2(ease, interval, reps, grade) {
  const q = GRADE_TO_Q[grade];
  if (q < 3) return { ease: Math.max(1.3, ease - 0.2), interval: 1, reps: 0 };
  const nreps = reps + 1;
  let ni;
  if (nreps === 1) ni = 1;
  else if (nreps === 2) ni = 6;
  else ni = Math.max(1, Math.round(interval * ease));
  const nease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { ease: nease, interval: ni, reps: nreps };
}

const QUEUE_SELECT =
  '*, episodes(title, audio_url), vocab_cards(example_sentence, sentence_start_sec, sentence_end_sec, kind)';

function flattenCard(r) {
  return {
    ...r,
    episode_title: r.episodes?.title || '',
    audio_url: cleanAudioUrl(r.episodes?.audio_url || ''),  // '맥락에서 듣기' 인라인 재생용(실제 음성)
    example_sentence: r.vocab_cards?.example_sentence ?? null,
    sentence_start_sec: r.vocab_cards?.sentence_start_sec ?? null,
    sentence_end_sec: r.vocab_cards?.sentence_end_sec ?? null,
    vkind: r.vocab_cards?.kind ?? null,
  };
}

// GET /api/srs/queue 대체
export async function srsQueue() {
  const today = todayStr();
  const review = await supabase
    .from('srs_cards').select(QUEUE_SELECT)
    .lte('due_date', today).gt('reps', 0)
    .order('due_date', { ascending: true }).order('id', { ascending: true })
    .limit(REVIEW_LIMIT);
  if (review.error) throw new Error(review.error.message);

  const fresh = await supabase
    .from('srs_cards').select(QUEUE_SELECT)
    .lte('due_date', today).eq('reps', 0)
    .order('id', { ascending: true })
    .limit(NEW_LIMIT);
  if (fresh.error) throw new Error(fresh.error.message);

  return [...review.data, ...fresh.data].map(flattenCard);
}

// POST /api/srs/review 대체
export async function srsReview(cardId, grade) {
  const { data: row, error } = await supabase
    .from('srs_cards').select('ease, interval_days, reps').eq('id', cardId).single();
  if (error) throw new Error(error.message);

  const r = sm2(row.ease, row.interval_days, row.reps, grade);
  const due = new Date();
  due.setDate(due.getDate() + r.interval);
  const dueStr = todayStr(due);

  const { error: uerr } = await supabase
    .from('srs_cards')
    .update({ ease: r.ease, interval_days: r.interval, reps: r.reps, due_date: dueStr })
    .eq('id', cardId);
  if (uerr) throw new Error(uerr.message);

  return { card_id: cardId, ease: r.ease, interval_days: r.interval, reps: r.reps, due_date: dueStr };
}

// GET /api/srs/stats 대체
export async function srsStats() {
  const today = todayStr();
  const base = () => supabase.from('srs_cards').select('*', { count: 'exact', head: true });
  const run = async (q) => {
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count || 0;
  };

  const [total, dueReview, dueNew, backlogNew, learned] = await Promise.all([
    run(base()),
    run(base().lte('due_date', today).gt('reps', 0)),
    run(base().lte('due_date', today).eq('reps', 0)),
    run(base().gt('due_date', today).eq('reps', 0)),
    run(base().gt('reps', 0)),
  ]);

  return {
    total,
    today_batch: Math.min(dueReview, REVIEW_LIMIT) + Math.min(dueNew, NEW_LIMIT),
    today_review: Math.min(dueReview, REVIEW_LIMIT),
    today_new: Math.min(dueNew, NEW_LIMIT),
    backlog_new: backlogNew,
    learned,
  };
}
