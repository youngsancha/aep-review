// proficiency.js — 영어 실력의 '5축 수치화' 단일 출처.
//
// 네이티브는 단일 숫자가 아니라 '벡터'다. 다섯 축으로 분해해 측정하고, 선택한 목표 밴드(B2/C1/C2)
// 대비 달성률(0~100)로 정규화한다. 그래서 Fluency Index=100 은 "모든 축에서 목표 밴드 도달".
//   ① Breadth     어휘폭   — 마스터(known) 표현 수 / 코퍼스 목표비율           (Supabase)
//   ② Retention   보존력   — 장기간격(>90d) 카드 비율                          (Supabase)
//   ③ Listening   청해     — dictation/cloze/listen 정확도 (unseen 우선)       (측정 로그)
//   ④ Production  산출     — speak/KR→EN 의 scoreText 평균                      (측정 로그)
//   ⑤ Automaticity 자동화 — 인식 응답 지연(ms)·shadowing reps                  (측정 로그)
//
// 설계: 순수 계산(축·지수·밴드·gap)과 localStorage I/O 를 분리한다. 순수 함수는 브라우저 의존이
// 없어 node --test 에서 직접 import 해 검증 가능(localStorage 접근은 함수 내부로 가둠 → top-level 무접근).
// 정직성: 코퍼스는 큐레이션된 표현이라 CEFR 직매핑은 근사치이고, ASR 은 발음 정확도가 아닌 '알아들힘',
// 외운 문장 점수≠실력 → unseen(레벨체크) 측정을 우선·별도 표기한다.

// ─────────────────────────── 저장 키 ───────────────────────────
export const LOG_KEY = 'aep-measure-log';     // [{t, mode, score(0~1), n, unseen, ms}]
export const TARGET_KEY = 'aep-prof-target';  // 'B2' | 'C1' | 'C2'
export const SNAP_KEY = 'aep-prof-snap';      // [{w:'YYYY-Www', t, idx, ax:{...}}]
export const SHADOW_KEY = 'aep-shadow-reps';  // { n }  — 1.0x shadowing 반복 누적
const LOG_MAX = 600;

// 어느 로그 모드가 어느 축을 먹이는지
export const LISTEN_MODES = ['listen', 'dictation', 'cloze'];
export const PROD_MODES = ['speak', 'prod'];
export const ACC_MODES = ['read', 'listen', 'dictation', 'cloze'];  // 정확도(정답률 pill)
const DEFAULT_BAND = 'C2';

// ─────────────────────────── localStorage I/O (가드형) ───────────────────────────
function _ls() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }
function _read(key, dflt) {
  const ls = _ls(); if (!ls) return dflt;
  try { const v = ls.getItem(key); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
}
function _write(key, val) { const ls = _ls(); if (!ls) return; try { ls.setItem(key, JSON.stringify(val)); } catch (e) { /* quota */ } }

// 측정 1건 기록 — 모든 퀴즈/드릴 종료 시 호출. score 는 0~1 정규화(정확도=correct/total, 발음=scoreText).
export function recordMeasure(mode, score, n = 1, opts = {}) {
  if (!mode || !(n > 0)) return;
  const log = _read(LOG_KEY, []);
  log.push({
    t: Date.now(), mode,
    score: Math.max(0, Math.min(1, Number(score) || 0)),
    n: Math.round(n),
    unseen: !!opts.unseen,
    ms: (opts.ms != null && opts.ms > 0) ? Math.round(opts.ms) : null,
  });
  _write(LOG_KEY, log.slice(-LOG_MAX));
}
export function loadLog() { return _read(LOG_KEY, []); }

export function getTarget() { const b = _read(TARGET_KEY, DEFAULT_BAND); return (b === 'B2' || b === 'C1' || b === 'C2') ? b : DEFAULT_BAND; }
export function setTarget(band) { if (band === 'B2' || band === 'C1' || band === 'C2') _write(TARGET_KEY, band); }

export function addShadowReps(n = 1) { const s = _read(SHADOW_KEY, { n: 0 }); s.n = (s.n || 0) + n; _write(SHADOW_KEY, s); return s.n; }
export function getShadowReps() { return (_read(SHADOW_KEY, { n: 0 }).n) || 0; }

// 주간 스냅샷(추세) — ISO 주차당 1건만(최신으로 덮어씀). 최근 ~80주 유지.
export function recordSnapshot(index, axes) {
  const w = isoWeek(new Date());
  const snaps = _read(SNAP_KEY, []).filter((s) => s.w !== w);
  snaps.push({ w, t: Date.now(), idx: Math.round(index), ax: axes });
  _write(SNAP_KEY, snaps.slice(-80));
}
export function loadSnapshots() { return _read(SNAP_KEY, []); }

// ─────────────────────────── 순수 계산 ───────────────────────────
// ISO 주차 'YYYY-Www' (스냅샷 dedupe 키)
export function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;             // 월=1..일=7
  dt.setUTCDate(dt.getUTCDate() + 4 - day);    // 그 주 목요일로
  const yStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - yStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

const _mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function _wmean(entries) {  // n(문항수) 가중 평균 score
  let sw = 0, s = 0;
  for (const e of entries) { const w = e.n || 1; sw += w; s += (e.score || 0) * w; }
  return sw ? s / sw : 0;
}
function _median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y); const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

// CEFR 어휘(워드패밀리) 거친 앵커 — 표현 코퍼스라 근사. 헤드라인 '≈ 밴드' 추정용.
export const CEFR_VOCAB = [['A1', 1000], ['A2', 2000], ['B1', 3250], ['B2', 5000], ['C1', 8000], ['C2', 16000]];
export function cefrBand(known) {
  let band = '—', nextLabel = 'A1', nextAt = CEFR_VOCAB[0][1];
  for (let i = 0; i < CEFR_VOCAB.length; i++) {
    if (known >= CEFR_VOCAB[i][1]) { band = CEFR_VOCAB[i][0]; nextLabel = CEFR_VOCAB[i + 1]?.[0] || null; nextAt = CEFR_VOCAB[i + 1]?.[1] || null; }
  }
  return { band, nextLabel, nextAt, toNext: nextAt != null ? Math.max(0, nextAt - known) : 0 };
}

// 밴드별 목표 벡터. breadthFrac=마스터/코퍼스 목표비율, listening/production=정확도(0~1),
// retentionFrac=장기간격>90d 비율, latencyMs=목표 응답시간(낮을수록 좋음).
export function bandTargets(band) {
  const T = {
    B2: { breadthFrac: 0.30, listening: 0.75, production: 0.65, retentionFrac: 0.40, latencyMs: 4000 },
    C1: { breadthFrac: 0.60, listening: 0.85, production: 0.75, retentionFrac: 0.60, latencyMs: 3000 },
    C2: { breadthFrac: 0.90, listening: 0.92, production: 0.85, retentionFrac: 0.75, latencyMs: 2200 },
  };
  return T[band] || T.C2;
}

// 측정 로그 + DB 입력 → 각 축의 raw 측정치(0~1, latency 는 ms).
//   db: { known, corpusTotal, retentionFrac }
export function rawFromLog(log, db = {}) {
  const corpus = db.corpusTotal || 0;
  const listenAll = log.filter((e) => LISTEN_MODES.includes(e.mode));
  const listenUnseen = listenAll.filter((e) => e.unseen);
  const prod = log.filter((e) => PROD_MODES.includes(e.mode));
  const lats = log.map((e) => e.ms).filter((m) => m != null && m > 0);
  return {
    breadthFrac: corpus ? (db.known || 0) / corpus : 0,
    retentionFrac: db.retentionFrac || 0,
    // unseen(레벨체크) 측정이 있으면 그것을 신뢰(비편향), 없으면 전체.
    listening: _wmean(listenUnseen.length ? listenUnseen : listenAll),
    listeningUnseen: listenUnseen.length ? _wmean(listenUnseen) : null,
    production: prod.length ? _mean(prod.map((e) => e.score)) : 0,
    latencyMs: lats.length ? _median(lats) : 0,
    samples: { listen: listenAll.length, listenUnseen: listenUnseen.length, prod: prod.length, lat: lats.length },
  };
}

// raw + 목표 → 각 축 0~100(목표 대비 달성률). 표본이 없는 축은 null(미측정 → 회색 표시).
export function axisScores(raw, target) {
  const pct = (v, t) => (t > 0 ? Math.max(0, Math.min(100, Math.round((v / t) * 100))) : 0);
  const s = raw.samples || {};
  return {
    breadth: pct(raw.breadthFrac, target.breadthFrac),
    retention: pct(raw.retentionFrac, target.retentionFrac),
    listening: s.listen ? pct(raw.listening, target.listening) : null,
    production: s.prod ? pct(raw.production, target.production) : null,
    // 자동화: 목표시간/실제 (빠를수록 ↑). 표본 없으면 null.
    automaticity: (s.lat && raw.latencyMs) ? Math.max(0, Math.min(100, Math.round((target.latencyMs / raw.latencyMs) * 100))) : null,
  };
}

// 가중 종합 — 측정된 축만 평균(미측정 축은 지수에서 제외, 단 breadth/retention 은 항상 존재).
export const AXIS_WEIGHTS = { breadth: 1, retention: 1, listening: 1.1, production: 1, automaticity: 0.8 };
export function fluencyIndex(scores, weights = AXIS_WEIGHTS) {
  let sw = 0, s = 0;
  for (const k of Object.keys(weights)) {
    const v = scores[k];
    if (v == null) continue;
    sw += weights[k]; s += v * weights[k];
  }
  return sw ? Math.round(s / sw) : 0;
}

// 누적 정확도(정답률 pill) — read/listen/dictation/cloze 의 n 가중 평균.
export function accuracyPct(log) {
  const acc = log.filter((e) => ACC_MODES.includes(e.mode));
  if (!acc.length) return null;
  return Math.round(_wmean(acc) * 100);
}

// 종합 — study.js 가 DB 입력을 모아 호출하는 메인 진입점. 순수 계산을 localStorage 로그/목표와 결합.
//   db: { known, corpusTotal, retentionFrac }
export function readProficiency(db = {}) {
  const log = loadLog();
  const band = getTarget();
  const target = bandTargets(band);
  const raw = rawFromLog(log, db);
  const scores = axisScores(raw, target);
  const index = fluencyIndex(scores);
  return {
    band, target, raw, scores, index,
    cefr: cefrBand(db.known || 0),
    accuracy: accuracyPct(log),
    shadowReps: getShadowReps(),
  };
}

// 가장 약한(달성률 최저) 축 — 적응형 'Today's plan' 이 여기로 학습을 민다.
export function weakestAxis(scores) {
  let worst = null, wv = Infinity;
  for (const k of Object.keys(AXIS_WEIGHTS)) {
    const v = scores[k];
    if (v == null) continue;       // 미측정은 제외(아직 모름)
    if (v < wv) { wv = v; worst = k; }
  }
  return worst;
}
