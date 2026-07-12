// 데이터 접근 shim — 기존 /api/* 응답 모양을 Supabase 직접 호출로 재현.
// 뷰(timeline/episode/srs)는 받는 데이터 모양만 같으면 거의 그대로 동작한다.
import { supabase, STORAGE_URL } from '/supabase.js';
import { hostedAudioUrl, currentShow, MULTISHOW } from '/config.js';

const NEW_LIMIT = 5;
const REVIEW_LIMIT = 50;

// 멀티-쇼: 활성화(MULTISHOW)면 현재 쇼로 필터(episodes_list/vocab_cards/srs_cards 모두 show 보유).
// 비활성(기본)이면 무필터 → 기존 단일쇼 동작·스키마와 완전히 동일(컬럼 없어도 안전). id 로 직접
// 찾는 getEpisode/markKnown/srsReview 는 id 가 전역 유일이라 쇼 필터 불필요.
const withShow = (q) => (MULTISHOW ? q.eq('show', currentShow()) : q);

// 로컬(폰) 기준 오늘 날짜 YYYY-MM-DD — srs due_date 비교용
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────── episodes ───────────────────────────
// GET /api/episodes 대체
export async function listEpisodes() {
  const { data, error } = await withShow(
    supabase.from('episodes_list').select('*'))
    .order('pub_date', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// 이전/다음 '에피소드'(곡) id — ⏮/⏭ 트랙 이동용. 라이브러리와 같은 쇼 안에서 시간순(pub_date asc)
// 으로 줄세워, 더 나중에 나온 화가 '다음'(다음 회차), 더 예전 화가 '이전'(이전 곡)이 된다.
// id+pub_date 만 가볍게 받아 메모리에서 인접 회차를 찾는다(수백 행이라 단일 쿼리로 충분).
export async function episodeNav(id) {
  const { data, error } = await withShow(
    supabase.from('episodes_list').select('id, pub_date'))
    .order('pub_date', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);
  const ids = (data || []).map((e) => e.id);
  const i = ids.indexOf(Number(id));
  if (i < 0) return { prevId: null, nextId: null };
  return {
    prevId: i > 0 ? ids[i - 1] : null,
    nextId: i < ids.length - 1 ? ids[i + 1] : null,
  };
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
    _hostedP = (async () => {
      // 최대 3회 재시도. 성공해야만 영구 캐시(_hosted). 끝까지 실패하면 이 세션을 megaphone(DAI)로
      // '오염'시키지 않도록 빈 집합을 굳히지 않고(_hostedP 리셋) 다음 호출이 다시 받게 한다.
      // (과거 버그: 일시적 fetch 실패 → 빈 집합 캐시 → 그 세션 전체가 megaphone 폴백 → 자막 desync.)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${STORAGE_URL}/transcripts/audio_hosted.json`, { cache: 'no-cache' });
          if (r.ok) {
            const a = await r.json();
            _hosted = new Set((a || []).map(Number));
            return _hosted;
          }
        } catch (e) { /* 재시도 */ }
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      _hostedP = null;            // 실패는 캐시하지 않음 → 다음 호출 재시도
      return new Set();
    })();
  }
  return _hostedP;
}
// 예문 한국어 사전번역 맵(vocab_id → ko). 1회 fetch 후 메모리 캐시. (scripts/translate_examples 생성)
let _exKo = null, _exKoP = null;
export async function examplesKo() {
  if (_exKo) return _exKo;
  if (!_exKoP) {
    _exKoP = fetch(`${STORAGE_URL}/transcripts/examples_ko.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { _exKo = m || {}; return _exKo; })
      .catch(() => { _exKo = {}; return _exKo; });
  }
  return _exKoP;
}
// 자막 문장 한국어 사전번역 맵(trKey(문장) → ko). episode.js 가 재생 중 즉시 조회(직역 MyMemory 대체).
// transcribed_at 으로 버전키 → 재싱크로 자막이 바뀌면 새 번역을 받는다. 회차별 메모리 캐시.
const _trKoCache = new Map();
export async function transcriptKo(id, transcribedAt) {
  if (!transcribedAt) return {};
  if (_trKoCache.has(id)) return _trKoCache.get(id);
  const p = fetch(`${STORAGE_URL}/transcripts/${id}_ko.json?v=${encodeURIComponent(transcribedAt)}`, { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((m) => m || {})
    .catch(() => ({}));
  _trKoCache.set(id, p);
  return p;
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
  [ep.transcript, ep.transcript_ko] = await Promise.all([
    fetchTranscript(id, ep.transcribed_at),
    transcriptKo(id, ep.transcribed_at),   // 문맥 인지 사전번역(있으면 직역 대체)
  ]);
  return ep;
}

async function fetchTranscript(id, transcribedAt) {
  if (!transcribedAt) return null;
  try {
    // 캐시버스트: transcribed_at 을 URL 버전키로 → 재싱크(--from-r2)로 transcript 가 바뀌면
    // URL 이 달라져 항상 새 자막을 받는다. force-cache 는 '버전별 불변 URL' 이라 그대로 유지
    // (한 번 받은 버전은 영구 캐시 → 빠름). 이게 없으면 옛 자막이 새 R2 오디오와 ~1s 어긋나던 버그.
    const r = await fetch(`${STORAGE_URL}/transcripts/${id}.json?v=${encodeURIComponent(transcribedAt)}`, { cache: 'force-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────── Study (표현 탐색 허브) ───────────────────────────
async function _count(table, build) {
  let q = withShow(supabase.from(table).select('*', { count: 'exact', head: true }));
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
  const [total, learned, dueReview, dueNew, known, ...kindCounts] = await Promise.all([
    _count('vocab_cards'),
    _count('srs_cards', (q) => q.gt('reps', 0)),
    _count('srs_cards', (q) => q.lte('due_date', today).gt('reps', 0)),
    _count('srs_cards', (q) => q.lte('due_date', today).eq('reps', 0)),
    _count('srs_cards', (q) => q.gte('interval_days', KNOWN_INTERVAL)),
    ...STUDY_KINDS.map((k) => _count('vocab_cards', (q) => q.eq('kind', k))),
  ]);
  const byKind = STUDY_KINDS.map((k, i) => ({ kind: k, total: kindCounts[i] }));
  // due = 오늘 실제 복습 세션 크기(srsQueue 상한과 동일: 복습 50 + 신규 5) — 'N due' CTA 가 실제 풀 양과 일치.
  const due = Math.min(dueReview, REVIEW_LIMIT) + Math.min(dueNew, NEW_LIMIT);
  return { total, learned, due, dueReview, dueNew, known, byKind };
}

// 보존력(retention) 통계 — Proficiency 5축 중 '안 잊는 힘'. 학습(reps>0) 카드 중 장기간격(>90d) 비율.
// strong(>90d) 에는 markKnown(interval 365)·실제 장기복습 도달분이 모두 포함된다. mature(>21d)는 참고치.
// (lapse 율은 SM-2 가 again 시 reps=0 으로 리셋해 신규처럼 위장 → 별도 추적 필요, 본 버전 범위 밖.)
export async function retentionStats() {
  const [learned, strong, mature] = await Promise.all([
    _count('srs_cards', (q) => q.gt('reps', 0)),
    _count('srs_cards', (q) => q.gt('reps', 0).gt('interval_days', 90)),
    _count('srs_cards', (q) => q.gt('reps', 0).gt('interval_days', 21)),
  ]);
  return { learned, strong, mature, retentionFrac: learned ? strong / learned : 0 };
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

// "알아요" 해제 — SRS 카드를 다시 복습 대상으로 되돌린다(known 진도에서 빠짐). 카드 왼쪽 스와이프용.
export async function markUnknown(vocabId) {
  const { error } = await supabase
    .from('srs_cards')
    .update({ interval_days: 0, reps: 0, ease: 2.5, due_date: todayStr(new Date()) })
    .eq('vocab_id', vocabId);
  if (error) throw new Error(error.message);
}

// vocab 행 → 뷰 표준 모양(에피소드 제목·재생 audio_url·known·예문 한글). expressionsByKind/allExpressions 공용.
const VOCAB_SELECT =
  'id, term, kind, definition, example_sentence, episode_id, sentence_start_sec, sentence_end_sec, episodes(title, audio_url), srs:srs_cards(interval_days)';
function _mapVocab(v, hosted, exKo) {
  return {
    ...v,
    episode_title: v.episodes?.title || '',
    // 인라인 문장 재생용 — 호스팅된 회차는 R2(자막 문장시각과 일치) 아니면 megaphone clean.
    audio_url: hosted.has(Number(v.episode_id)) ? hostedAudioUrl(v.episode_id) : cleanAudioUrl(v.episodes?.audio_url || ''),
    known: Array.isArray(v.srs) && v.srs.some((s) => (s.interval_days || 0) >= KNOWN_INTERVAL),
    example_ko: exKo[String(v.id)] || null,   // 사전번역(있으면 KR 버튼 즉시 표시)
  };
}

// 종류별 표현 목록 (+ 에피소드 제목). 각 kind 는 1000행 미만이라 단일 쿼리로 충분.
export async function expressionsByKind(kind, limit = 800) {
  const { data, error } = await withShow(
    supabase.from('vocab_cards').select(VOCAB_SELECT).eq('kind', kind))
    .order('term', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const [hosted, exKo] = await Promise.all([hostedSet(), examplesKo()]);
  return (data || []).map((v) => _mapVocab(v, hosted, exKo));
}

// 전 kind 통합 — 약점(미마스터) 집중 퀴즈용(B4). 호출부가 known=false 우선 샘플링.
export async function allExpressions(limit = 1500) {
  const { data, error } = await withShow(
    supabase.from('vocab_cards').select(VOCAB_SELECT))
    .limit(limit);
  if (error) throw new Error(error.message);
  const [hosted, exKo] = await Promise.all([hostedSet(), examplesKo()]);
  return (data || []).map((v) => _mapVocab(v, hosted, exKo));
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

function flattenCard(r, hosted) {
  return {
    ...r,
    episode_title: r.episodes?.title || '',
    // 호스팅된 회차는 R2(자막 문장시각 일치) 아니면 megaphone clean.
    audio_url: (hosted && hosted.has(Number(r.episode_id))) ? hostedAudioUrl(r.episode_id) : cleanAudioUrl(r.episodes?.audio_url || ''),
    example_sentence: r.vocab_cards?.example_sentence ?? null,
    sentence_start_sec: r.vocab_cards?.sentence_start_sec ?? null,
    sentence_end_sec: r.vocab_cards?.sentence_end_sec ?? null,
    vkind: r.vocab_cards?.kind ?? null,
  };
}

// GET /api/srs/queue 대체
export async function srsQueue() {
  const today = todayStr();
  // review·fresh·hostedSet 은 서로 독립 → 순차 3 RTT 대신 병렬 1회분으로(Review 탭 열림 지연 단축).
  const [review, fresh, hosted] = await Promise.all([
    withShow(supabase.from('srs_cards').select(QUEUE_SELECT)
      .lte('due_date', today).gt('reps', 0))
      .order('due_date', { ascending: true }).order('id', { ascending: true })
      .limit(REVIEW_LIMIT),
    withShow(supabase.from('srs_cards').select(QUEUE_SELECT)
      .lte('due_date', today).eq('reps', 0))
      .order('id', { ascending: true })
      .limit(NEW_LIMIT),
    hostedSet(),
  ]);
  if (review.error) throw new Error(review.error.message);
  if (fresh.error) throw new Error(fresh.error.message);
  return [...review.data, ...fresh.data].map((r) => flattenCard(r, hosted));
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
  const base = () => withShow(supabase.from('srs_cards').select('*', { count: 'exact', head: true }));
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
