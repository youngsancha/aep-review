// convo.js — 회화(Conversation) 턴 연습의 순수 로직 단일 출처.
//
// 왜 새 모드인가: 기존 8개 드릴은 전부 '정답 문자열 하나'와 비교한다(scoreText = 단어 편집거리).
// Speak 은 영어를 보고 따라 말하고, KR→EN 은 한국어를 보고 그 한 문장을 복원한다 — 둘 다 모방·번역이라
// 잘할수록 '암송'이 늘지 '대화'가 늘지 않는다. 실제 회화는 ① 상대 말에 ② 내 말로 ③ 몇 초 안에 답하는 것이고,
// 정답이 하나가 아니다. 그래서 이 모듈은 '한 문장과 얼마나 같은가' 대신 네 가지를 잰다:
//   ① 목표 표현을 실제로 썼는가(굴절·분리 허용)   ② 한 턴만큼 충분히 말했는가
//   ③ 첫 단어까지 몇 ms 걸렸는가(자동화)          ④ 말 속도·군말 비율(유창성)
//
// 브라우저 의존 없음(top-level 무접근) → node --test 에서 그대로 import 해 검증한다.

// ── 정규화 ──────────────────────────────────────────────────────────
// study.js 의 normWords 와 목적이 다르다: 저기는 '정답과의 일치', 여기는 '표현을 썼는가'라
// 축약을 펼치지 않고(=말한 그대로) 문장부호만 털어낸다.
export function normTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")           // 곡선 어포스트로피 → ASCII
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

// 아주 가벼운 어미 제거 — 굴절(hold/holds/held 는 못 잡지만 holds/holding/holded 류는 잡는다)을
// 관대하게 보기 위한 것이지 형태소 분석이 아니다. 과하게 자르면 오탐이 늘어 3글자 미만은 건드리지 않는다.
export function stem(w) {
  const x = String(w || '');
  if (x.length <= 3) return x;
  if (/[^aeiou]ies$/.test(x)) return x.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(x)) return x;
  if (/(sses|shes|ches|xes|zes)$/.test(x)) return x.slice(0, -2);
  if (/ing$/.test(x) && x.length > 5) return x.slice(0, -3);
  if (/ed$/.test(x) && x.length > 4) return x.slice(0, -2);
  if (/s$/.test(x)) return x.slice(0, -1);
  return x;
}

const stems = (arr) => arr.map(stem);

// 목표 표현을 답변 안에서 찾는다. 구동사는 목적어가 사이에 끼므로("hold off" → "hold it off")
// 부분들이 '순서대로' 나오되 사이에 GAP 단어까지 허용한다. 완전일치가 아니라 사용 여부 판정.
export const USE_GAP = 3;
export function usedExpression(said, term) {
  const t = stems(normTokens(term));
  if (!t.length) return false;
  const s = stems(normTokens(said));
  if (!s.length) return false;
  for (let start = 0; start <= s.length - 1; start++) {
    if (s[start] !== t[0]) continue;
    let i = start + 1, k = 1;
    while (k < t.length && i < s.length) {
      if (s[i] === t[k]) { k++; i++; continue; }
      // 사이에 낄 수 있는 단어 수 제한 — 문장 전체를 훑어 우연히 맞는 것을 막는다.
      if (i - start - k > USE_GAP) break;
      i++;
    }
    if (k === t.length) return true;
  }
  return false;
}

// 군말 — ASR 이 대부분 걸러내지만 Android Chrome 은 'um/uh' 를 자주 그대로 남긴다.
export const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'eh']);
export function countFillers(said) {
  const w = normTokens(said);
  let n = 0;
  for (let i = 0; i < w.length; i++) {
    if (FILLERS.has(w[i])) { n++; continue; }
    if (w[i] === 'like' && i > 0 && (FILLERS.has(w[i - 1]) || w[i - 1] === ',')) n++;  // "uh like"
  }
  return n;
}

// ── 목표치 ──────────────────────────────────────────────────────────
// 한 '턴'의 기준. 8단어 미만은 대답이 아니라 반응이고(“Yes, I did.”), 14단어쯤이면 이유·예가 붙은 턴이다.
export const MIN_WORDS = 8;
export const GOOD_WORDS = 14;
// 첫 단어까지의 시간. 원어민 L1 은 <1s, L2 자유발화는 2s 면 좋은 편, 8s 는 '문장을 조립하고 있다'.
export const FAST_MS = 2000;
export const SLOW_MS = 8000;
// 자연스러운 대화 속도대(wpm). 아래로 벗어나면 더듬는 것, 위로 벗어나면 외운 것을 쏟는 것에 가깝다.
export const WPM_LO = 100;
export const WPM_HI = 170;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 성분별 가중치. 측정 못 한 성분(마이크 타이밍 없음 등)은 빼고 '남은 것만으로' 재정규화한다 —
// 그러지 않으면 못 잰 축이 조용히 점수 상한을 깎아 '말을 잘해도 60점'이 된다.
export const WEIGHTS = { used: 0.35, length: 0.25, latency: 0.2, fluency: 0.2 };

// 한 턴 채점. said 는 ASR 이 받아쓴 내 말, term 은 써야 할 표현.
//   latencyMs: 마이크가 열린 뒤 첫 단어가 인식되기까지(ms, 없으면 null)
//   speakMs  : 첫 인식~마지막 인식 사이(ms, 없으면 null) — wpm 추정용
export function scoreTurn({ said = '', term = '', latencyMs = null, speakMs = null } = {}) {
  const words = normTokens(said).length;
  const used = term ? usedExpression(said, term) : false;
  const fillers = countFillers(said);
  const fillerRatio = words ? fillers / words : 0;
  // 말한 구간이 너무 짧으면(<700ms) 타이밍이 신뢰할 수 없다 — wpm 을 내지 않는다.
  const wpm = (speakMs != null && speakMs >= 700 && words > 0)
    ? Math.round((words / (speakMs / 1000)) * 60)
    : null;

  const parts = {};
  parts.used = used ? 1 : 0;
  parts.length = clamp01(words / GOOD_WORDS);
  if (latencyMs != null && latencyMs > 0) {
    parts.latency = clamp01((SLOW_MS - latencyMs) / (SLOW_MS - FAST_MS));
  }
  if (wpm != null) {
    // 밴드 안이면 만점, 밖이면 벗어난 만큼 선형 감점(±60wpm 에서 0).
    const off = wpm < WPM_LO ? WPM_LO - wpm : wpm > WPM_HI ? wpm - WPM_HI : 0;
    const rate = clamp01(1 - off / 60);
    const clean = clamp01(1 - fillerRatio / 0.25);   // 군말 25% 면 0점
    parts.fluency = rate * 0.7 + clean * 0.3;
  } else if (words > 0) {
    parts.fluency = clamp01(1 - fillerRatio / 0.25); // 속도를 못 재면 군말만으로
  }

  let sw = 0, s = 0;
  for (const k of Object.keys(WEIGHTS)) {
    if (parts[k] == null) continue;
    sw += WEIGHTS[k]; s += parts[k] * WEIGHTS[k];
  }
  // 말을 아예 안 했으면 0점 — 재정규화가 '침묵'에 점수를 주지 않게 한다.
  const score = (words === 0 || !sw) ? 0 : clamp01(s / sw);

  return { score, used, words, wpm, fillers, fillerRatio, latencyMs, parts, tips: turnTips({ used, term, words, wpm, latencyMs, fillerRatio }) };
}

// 다음 턴에 바꿀 것 하나를 집어준다 — 점수보다 이게 실력을 움직인다. 우선순위 = 회화에 미치는 영향 순.
export function turnTips({ used, term, words, wpm, latencyMs, fillerRatio }) {
  const tips = [];
  if (words === 0) return ['마이크를 켜고 한 문장이라도 소리 내어 답해보세요.'];
  if (!used && term) tips.push(`“${term}” 을 답변 안에 실제로 써보세요 — 아는 표현과 쓰는 표현은 다릅니다.`);
  if (words < MIN_WORDS) tips.push(`한 문장 더 — 이유나 예를 붙이면 턴이 됩니다 (지금 ${words}단어, 목표 ${MIN_WORDS}+).`);
  if (latencyMs != null && latencyMs > 4000) tips.push('완벽한 문장을 만들고 시작하지 마세요 — 3초 안에 첫 단어를 내는 연습이 자동화를 올립니다.');
  if (fillerRatio > 0.15) tips.push('um/uh 대신 잠깐 조용히 멈추는 편이 더 유창하게 들립니다.');
  if (wpm != null && wpm < WPM_LO) tips.push(`말 속도 ${wpm} wpm — 자연스러운 대화는 ${WPM_LO}~${WPM_HI} 입니다. 짧은 청크로 이어서 말해보세요.`);
  if (!tips.length) tips.push('좋습니다 — 다음 턴은 한 문장 더 길게, 예를 하나 붙여보세요.');
  return tips.slice(0, 2);
}

// ── 프롬프트(상대의 턴) ─────────────────────────────────────────────
// 런타임 LLM 없이 만든다: 표현을 문법적으로 끼워 넣으면("you had to under the weather") 망가지므로
// 표현은 항상 따옴표 안에 '인용'하고, 문장으로 쓰는 것은 학습자 몫으로 남긴다.
// 표현 자체가 문장부호로 끝나는 카드가 많다("What's up?" · "My bad.") — 템플릿이 마침표를 또 붙이면
// `say "My bad.".` 이 되고 TTS 도 그대로 읽는다. 인용이 문장 끝에 오는 템플릿만 자기 마침표를 접는다.
export function endStop(t) { return /[.?!]\s*$/.test(String(t || '')) ? '' : '.'; }

export const ASK_TEMPLATES = [
  { en: (t) => `Tell me about a time when you would say "${t}"${endStop(t)}`, ko: (t) => `“${t}” 이라고 말할 만한 상황을 이야기해 주세요.` },
  { en: (t) => `What does "${t}" mean to you? Give an example from your own life.`, ko: (t) => `“${t}” 은 당신에게 어떤 뜻인가요? 본인 경험으로 예를 들어 주세요.` },
  { en: (t) => `When was the last time "${t}" applied to you? What happened?`, ko: (t) => `최근에 “${t}” 이 들어맞았던 때는 언제인가요? 무슨 일이 있었죠?` },
  { en: (t) => `A friend asks you what "${t}" means. How would you explain it?`, ko: (t) => `친구가 “${t}” 이 무슨 뜻이냐고 묻습니다. 어떻게 설명하시겠어요?` },
];

// 같은 카드가 늘 같은 질문을 받도록 안정 해시(테스트 가능·학습자에게 일관).
export function hashKey(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 카드 하나 → 상대의 턴. example_sentence 가 있으면 '상대가 그 문장을 말한다'(원어민 오디오를 그대로
// 대화 상대로 쓴다 — 이 앱만 가진 자산)로, 없으면 열린 질문으로.
export function buildTurn(card = {}) {
  const term = String(card.term || '').trim();
  const ex = String(card.example_sentence || '').trim();
  const h = hashKey(term + '|' + ex);
  // 예문이 있는 카드는 2/3 확률로 reply(상대 발화에 답하기) — 회화에 더 가깝다.
  if (ex && h % 3 !== 0) {
    // 예문은 대개 표현을 '이미 포함한' 원문장이다 — 즉 상대가 그 표현을 먼저 쓴다. 그걸 숨기고
    // "표현을 써서 답하세요" 라고 하면 힌트 없는 산출 과제처럼 보이지만 답이 이미 들려 있다.
    // 그래서 있는 그대로 말한다: 되받아 쓰기(uptake)는 실제 회화에서 청크를 습득하는 방식이고,
    // 표현 사용은 점수의 35%뿐이라 나머지(길이·반응속도·유창성)는 여전히 스스로 만들어야 한다.
    const echoes = usedExpression(ex, term);
    return {
      kind: 'reply',
      partner: ex,
      partnerKo: String(card.example_ko || '').trim() || null,
      instruction: echoes
        ? `상대가 “${term}” 표현을 씁니다 — 같은 표현을 되받아 두 문장으로 답하세요.`
        : `“${term}” 표현을 써서 상대의 말에 자연스럽게 답하세요.`,
      term,
      echoes,
    };
  }
  const tpl = ASK_TEMPLATES[h % ASK_TEMPLATES.length];
  return {
    kind: 'ask',
    partner: tpl.en(term),
    partnerKo: tpl.ko(term),
    instruction: '영어로 소리 내어 답하세요 — 두 문장 이상.',
    term,
  };
}
