// 데이터 접근 shim — 기존 /api/* 응답 모양을 Supabase 직접 호출로 재현.
// 뷰(timeline/episode/srs)는 받는 데이터 모양만 같으면 거의 그대로 동작한다.
import { supabase, STORAGE_URL } from '/supabase.js';

const NEW_LIMIT = 5;
const REVIEW_LIMIT = 50;

// 로컬(폰) 기준 오늘 날짜 YYYY-MM-DD — srs due_date 비교용 (api/routes_srs.py 의 date.today() 대응)
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

// ─────────────────────────── SRS ───────────────────────────
const GRADE_TO_Q = { again: 0, hard: 3, good: 4, easy: 5 };

// api/routes_srs.py::sm2_update 포팅
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
  '*, episodes(title), vocab_cards(example_sentence, sentence_start_sec, sentence_end_sec, kind)';

function flattenCard(r) {
  return {
    ...r,
    episode_title: r.episodes?.title || '',
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

  const total = await run(base());
  const dueReview = await run(base().lte('due_date', today).gt('reps', 0));
  const dueNew = await run(base().lte('due_date', today).eq('reps', 0));
  const backlogNew = await run(base().gt('due_date', today).eq('reps', 0));
  const learned = await run(base().gt('reps', 0));

  return {
    total,
    today_batch: Math.min(dueReview, REVIEW_LIMIT) + Math.min(dueNew, NEW_LIMIT),
    today_review: Math.min(dueReview, REVIEW_LIMIT),
    today_new: Math.min(dueNew, NEW_LIMIT),
    backlog_new: backlogNew,
    learned,
  };
}
