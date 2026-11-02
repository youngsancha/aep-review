// What a transcript means, with no DOM and no network: sentences, paragraphs, ad ranges, translation keys
// and how hard a sentence is. Everything here is pure, so node tests import it directly.
//
// ⛔ resegment and trKey must stay identical to the Python port in scripts/translate_transcripts.py: a
// translation is stored under the text of its sentence, so any change here orphans existing _ko.json keys.
// tests/test_resegment_parity.py runs both over real transcripts.

// 번역 캐시 키 = '문장 텍스트'(정규화). 인덱스 기준이면 resegment/광고 슬라이스로 문장 경계가 바뀔 때
// 같은 인덱스가 다른 문장을 가리켜 번역이 엉뚱한 문장에 붙는다(영↔한 mismatch). 텍스트 기준이면 안전.
export function trKey(text) {
  // 종결 구두점은 키에서 제외한다. resegment 가 마침표가 빠진 문장에 '.' 을 보충하게 되면서
  // 문장 텍스트가 바뀌는데, 사전번역 `_ko.json`(521회차 전량, 비싼 Claude 배치 산출물)의 키는
  // 보충 전 텍스트로 굳어 있다. 실측: 그 변화의 92% 가 '마침표 하나 추가'뿐이었다 —
  // 키에서 종결 구두점을 떼면 재생성 없이 그 92% 가 그대로 다시 맞는다.
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/[.!?…]+$/, '').slice(0, 180);
}

export function resegment(segments) {
  // Whisper segment 는 문장 경계를 무시한 ~5초 덩어리다. 단어 타임스탬프를 모아
  // 구두점 기준으로 진짜 "문장"으로 재분할한다(정확한 start/end 보존) → 싱크·스크롤 정확도↑.
  //
  // ⓪ 신뢰 모드 — scripts/resegment_llm.py 가 로컬 LLM 으로 경계를 다시 잡아 저장한 transcript 는
  // segment 하나가 이미 '문장'이고 `sent: true` 표식이 있다. 그때는 아래 규칙을 다시 적용하지
  // 않는다: 규칙의 14어절·9초 상한은 구두점 없는 자막에서 문장 한복판을 자르는 바로 그 경로라,
  // LLM 이 살린 문장을 도로 자르게 된다(사용자 신고 "끊어짐이 어색하다·싱크가 안 맞는다"의 원인).
  // 전부 표식일 때만 믿는다 — 섞여 있으면 어느 경계가 검증된 건지 모르므로 규칙으로 간다.
  // scripts/translate_transcripts.py resegment 의 같은 블록과 1:1 (파리티 픽스처 10554 가 고정).
  const segsIn = segments || [];
  if (segsIn.length && segsIn.every((s) => s && s.sent === true)) {
    return segsIn.map((seg) => {
      const ws = (seg.words || []).filter((w) => w.word != null)
        .map((w) => ({ word: w.word, start: w.start ?? seg.start, end: w.end ?? seg.end }));
      // 저장된 text 를 그대로 쓴다 — 스크립트가 '문장 끝'에만 마침표를 붙였고 절 조각에는 안 붙였다.
      // 여기서 다시 붙이면 "upstairs in the." 같은 가짜 종결이 생긴다.
      const text = (seg.text || (ws.length ? ws.map((x) => x.word).join('') : '')).trim();
      const st = ws.map((w) => w.start).filter((v) => typeof v === 'number');
      const en = ws.map((w) => w.end).filter((v) => typeof v === 'number');
      return { start: st.length ? Math.min(...st) : seg.start, end: en.length ? Math.max(...en) : seg.end, words: ws, text };
    });
  }
  const words = [];
  for (const seg of segments || []) {
    if (seg.words && seg.words.length) {
      for (const w of seg.words) {
        if (w.word == null) continue;
        words.push({ word: w.word, start: w.start ?? seg.start, end: w.end ?? seg.end });
      }
    } else if (seg.text) {
      words.push({ word: seg.text, start: seg.start, end: seg.end });
    }
  }
  if (!words.length) return segments || [];

  // 광고/낭독처럼 구두점이 거의 없는 run-on 도 적절한 길이로 자른다:
  //  ① 종결 구두점(.?!…)  ② 문장 사이 큰 쉼(gap)  ③ 긴 절의 콤마  ④ 길이 하드캡.
  const ENDS = /[.!?…]["')\]]?$/;
  // 약어는 마침표로 끝나지만 '문장'을 끝내지 않는다. 이걸 종결로 보면 문장이 한복판에서 갈리고
  // 그 뒤가 앞 문장의 꼬리로 시작한다 — 실측(554/555)에서 "...voting in U.S." / "elections. And
  // she says…", "...from U.S." / "roads. Does the White House…", "Ms. Sanders I don't believe…"
  // 가 전부 이 경우였다. ① 이니셜/약어 형태(U.S., a.m., J.), ② 흔한 경칭·단위 약어.
  const ABBR = /^(?:[A-Za-z]\.)+$|^(?:mr|mrs|ms|dr|prof|sen|rep|gov|st|jr|sr|vs|etc|inc|ltd|co|no|dept|approx)\.$/i;
  const endsSent = (t) => ENDS.test(t) && !ABBR.test((t || '').replace(/^[^A-Za-z]+/, ''));
  const COMMA = /[,;:]["')\]]?$/;
  // 등위·종속 접속사 앞은 영어 절(clause)이 자연스럽게 갈리는 지점. 절이 이미 길면 '그 앞'에서
  // 끊어 "…is so | alive", "…layer of | yellow" 같은 구(句) 중간 하드캡 절단을 막는다.
  // 관계대명사(that/which/who)는 제외 — "the pollen that is in our area" 처럼 붙어야 자연스러운 절을 안 쪼개려고.
  const CONJ = /^(and|but|so|or|because|when|while|if|since|though|although|unless)$/i;
  // 종결 구두점이 빠진(소형 STT) 자막에서도 문장 경계를 잡는 대문자 '문장-시작어'. 절이 ≥3단어
  // 찼고 다음 단어가 대문자 시작어(But/They/If/He…)면 그 앞에서 끊는다('I'·고유명사는 목록에 없어 제외).
  // The/My 추가(실측): 53 회차(470-522) 전수 스캔에서 My 는 4/4 진짜 문장 경계(오탐 0). The 는
  // 14건 중 다수가 진짜 경계지만 "I enjoyed The Time Traveler's Wife"류 작품명 오탐도 섞여있다 —
  // 그래도 요구사항(원본 버그 사례)이라 포함. A/An/Our/His/Her 는 보류: A 는 50건 중 대부분이
  // "Shopify.com slash A-E-E"처럼 철자 나열(스폰서 코드)로 오탐, Their 는 실측 2/2 모두
  // "The Game of Their Lives"(작품명) 오탐이라 제외. An/Our/His/Her 는 표본에 0건이라 근거 없음.
  const STARTER = /^(But|And|So|Or|Now|Then|Well|Yeah|Yes|No|Okay|OK|Here|There|This|That|These|Those|He|She|It|They|We|You|Who|If|When|Where|What|Why|How|Because|Although|Though|While|Since|Maybe|Actually|Finally|However|Meanwhile|Anyway|Plus|Also|The|My)$/;
  const out = [];
  let cur = null;
  let prevEnd = null;
  const close = (forcePeriod) => {
    cur.text = cur.words.map((x) => x.word).join('').trim();
    // STARTER 분할은 Whisper 가 종결 구두점 자체를 빠뜨린 경계라, 문장이 구두점 없이 끝나면
    // groupIntoParagraphs()의 endsSentence()가 이 경계를 못 읽어 문단 분할이 오작동한다 → 보충.
    if (forcePeriod && cur.text && !ENDS.test(cur.text)) cur.text += '.';
    out.push(cur); cur = null;
  };
  for (const w of words) {
    const gap = (prevEnd != null && Number.isFinite(w.start)) ? (w.start - prevEnd) : 0;
    // ② 쉼(gap) 기반 분할 — diarization 없이 화자 전환/문장 경계를 추정한다.
    //    큰 쉼(≥0.8s)은 거의 항상 경계(화자 교대 포함)라 짧아도 끊고, 중간 쉼(≥0.45s)은
    //    절이 어느 정도 찼을 때만 끊는다 → Shana↔게스트가 한 문장으로 길게 이어지던 문제(#) 완화.
    if (cur && (gap > 1.5 ||                       // 큰 비발화 간격(긴 쉼·음악·광고구간 등)은 단어수 무관 분리
                (cur.words.length >= 3 && gap > 0.8) ||
                (cur.words.length >= 7 && gap > 0.45))) close();
    // ②' 접속사 앞 분할 — 절이 충분히 길 때(≥11단어) 접속사 '앞'에서 끊어 구 중간 절단 방지.
    if (cur && cur.words.length >= 11) {
      const lead = (w.word || '').trim().replace(/^[^A-Za-z']+/, '').toLowerCase();
      if (CONJ.test(lead)) close();
    }
    // ②'' 대문자 문장-시작어 앞 분할 — 구두점이 빠진 자막의 문장 경계 복원(절이 ≥3단어일 때).
    // 여기서 닫히는 문장은 구두점이 없는 채로 끝나는 경우가 흔해 forcePeriod=true 로 보충한다.
    if (cur && cur.words.length >= 3) {
      const raw = (w.word || '').trim().replace(/^[^A-Za-z']+/, '');
      if (/^[A-Z]/.test(raw) && STARTER.test(raw.split("'")[0])) close(true);
    }
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w);
    if (Number.isFinite(w.end)) { cur.end = w.end; prevEnd = w.end; }
    const txt = (w.word || '').trim();
    const n = cur.words.length;
    const dur = cur.end - cur.start;
    if ((endsSent(txt) && n >= 2) ||            // ① 종결 구두점(약어 제외 — ABBR 주석 참조)
        (COMMA.test(txt) && n >= 7) ||          // ③ 긴 절은 콤마에서(9→7: 더 짧게)
        dur > 9 || n >= 14) {                   // ④ 하드캡 — 18w/12s→14w/9s: 한 문장이 4줄↑로
                                                //    번역카드와 겹쳐 안 보이던 문제 방지(전체적으로 짧게)
      close();
    }
  }
  if (cur) { cur.text = cur.words.map((x) => x.word).join('').trim(); out.push(cur); }

  // ⑤ 후처리 — '앞 문장의 꼬리'가 다음 문장 머리에 남은 것을 되돌린다.
  // 화자가 강조로 한 박자 쉬고 마지막 단어를 말하는 일이 흔하다("...to thrive like never ▁ before.").
  // 그때 ② gap 규칙이 그 앞에서 문장을 닫아버리고, 남은 'before.' 는 새 문장의 첫 단어가 되는데
  // ① ENDS 규칙은 n>=2 라야 닫으므로(약어 "Mr." 하나로 문장이 끊기는 걸 막는 가드) 그 한 단어는
  // 닫히지도 못한 채 '다음' 문장을 통째로 끌어안는다 → "before. Just this week, the National
  // Association of Manufacturers, ..." 같은 문장이 나온다. 실측(554/555/556 세 회차, 2065문장):
  // 3.8% 가 이 꼴이었다.
  // 이게 단순 표시 문제가 아닌 이유: 쉐도잉 반복은 '문단' 단위로 되감으므로, 문단이 앞 문장의
  // 꼬리에서 시작하면 반복할 때마다 문장 중간에서 음성이 시작된다 → 사용자에겐 "싱크가 안 맞는"
  // 것으로 보인다(신고 2026-08-07). ⚠ 실제 타임스탬프는 정확했다 — 같은 구간을 medium.en 으로
  // 다시 인식해 단어 단위로 대조한 결과 중앙값 -0.01s(최대 0.29s)였다. 어긋난 건 경계다.
  // 앞 문장이 이미 종결 구두점으로 끝났으면 그 꼬리는 진짜 새 발화("Yes." "Thank you.")이므로 둔다.
  for (let i = out.length - 1; i >= 1; i--) {
    const s = out[i], p = out[i - 1];
    if (s.words.length < 2 || !p.words.length) continue;   // 한 단어짜리 문장 자체는 건드리지 않는다
    if (!endsSent((s.words[0].word || '').trim())) continue;
    if (endsSent((p.text || '').trim())) continue;
    const w0 = s.words.shift();
    p.words.push(w0);
    if (Number.isFinite(w0.end)) p.end = w0.end;
    if (Number.isFinite(s.words[0].start)) s.start = s.words[0].start;
    p.text = p.words.map((x) => x.word).join('').trim();
    s.text = s.words.map((x) => x.word).join('').trim();
  }
  return out;
}

// 문단 최소 길이(초) — resegment()가 문장 하나당 세그먼트 하나를 내놓게 되면서 _sents(문장수)가
// 짧은 맞장구("Yeah." "Sleep in." "So good.")만으로도 금방 2에 도달해 ~1초짜리 문단이 쏟아졌다.
// 그 상태로 shadow-loop 반복재생을 하면 경계마다 뚝뚝 끊겨 들린다(#버그: "문단이 너무 짧다").
// 실측(509/517/521/522, groupIntoParagraphs(resegment(segments))): MIN 미적용 시 2초 미만 문단이
// 12.6%, 중앙값 6.14s. MIN=4 로 올리면 9.0%로 줄고 중앙값 6.51s로 목표 구간(6~12s) 안쪽에 든다.
// MIN 을 5~7까지 더 올려도 2초 미만 비율은 8~9%대에서 더 안 줄어든다 — 남는 절반 이상은 gap 규칙
// (진짜 침묵으로 갈리는 맞장구 한마디짜리 문단, 예: "Thank you.")이라 MIN 을 더 올려도 안 잡히고
// 중앙값만 불필요하게 밀려 올라간다. 그래서 4에서 수확체감 — MIN_PARA_SEC=4.
const MIN_PARA_SEC = 4;

export function groupIntoParagraphs(segments) {
  const out = [];
  let cur = null;
  const endsSentence = (txt) => /[.!?…]["')\]]?\s*$/.test((txt || '').trim());
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const prev = i > 0 ? segments[i - 1] : null;
    const gap = prev ? s.start - prev.end : 0;
    const prevEnds = prev && endsSentence(prev.text);
    const paraLen = cur && prev ? prev.end - cur.start : 0;

    // 자연스러운 단락: 문장 끝에서 2~3문장마다, 또는 큰 쉼에서만 끊는다(절 중간 금지).
    // 문장수 규칙(_sents>=2)은 문단이 MIN_PARA_SEC 이상 찼을 때만 발동 — 그래야 대화체 맞장구
    // 두 개가 이어져도 그것만으로 문단이 끊기지 않는다. paraLen>9 안전판은 그대로 무조건 발동
    // (9 > MIN_PARA_SEC 이라 이미 상위호환) — 문단이 하염없이 길어지는 걸 막는 역할은 안 건드림.
    // gap 기반 분할(아래 두 줄)은 MIN_PARA_SEC 과 무관하게 그대로 둔다 — 진짜 침묵(pause)은
    // 문단이 짧아도 진짜 경계이므로 계속 끊겨야 한다.
    let brk = false;
    if (!cur) brk = true;
    else if (prevEnds && ((cur._sents >= 2 && paraLen >= MIN_PARA_SEC) || paraLen > 9)) brk = true;
    else if (prevEnds && gap > 0.5) brk = true;
    else if (gap > 1.6) brk = true;
    else if (paraLen > 16) brk = true;  // 안전 상한

    if (brk) {
      cur = { start: s.start, end: s.end, segments: [s], _sents: 0 };
      out.push(cur);
    } else {
      cur.segments.push(s);
      cur.end = s.end;
    }
    if (endsSentence(s.text)) cur._sents++;
  }
  return out;
}

// === 프리롤 광고(DAI) 구간 감지 (#) ===
// megaphone 동적광고(DAI)는 '재생할 때마다 다른' 광고를 끼워넣는다 → 우리가 STT 한 광고(자막)와
// 사용자가 실제로 듣는 광고(음성)가 서로 다르다. 그래서 광고 구간 자막은 음성과 절대 일치할 수 없다
// (재정렬·재STT 로도 못 고침). 본편 시작(진행자 인트로 "...my name is Shana...")을 앵커로 찾아
// 그 앞 광고 문장들을 자막에서 감추고 '광고' 플레이스홀더로 대체한다. 본편 자막/싱크는 손대지 않는다.
const AD_CONTENT_RE = /(my name is sh|welcome to the american english|this is the american english podcast)/i;
const AD_GREET_RE = /^["'\s]*(hi\b|hey\b|hello\b|welcome back|what'?s up|good (morning|afternoon|evening))/i;
export function detectContentStart(sentences) {
  const limit = Math.min(sentences.length, 50);  // 프리롤 영역만 탐색(본편/아웃트로 언급 오탐 방지)
  for (let i = 0; i < limit; i++) {
    if (AD_CONTENT_RE.test(sentences[i].text || '')) {
      let k = i;  // 바로 앞 인사말("Hi everybody")이 있으면 그것을 본편 시작으로 포함
      for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
        if (AD_GREET_RE.test(sentences[j].text || '')) k = j; else break;
      }
      return k;
    }
  }
  return 0;  // 앵커 없음 → 아무것도 감추지 않음(안전 폴백 — 기존 동작 유지)
}
// === 미드롤/엔드롤 광고(DAI) 감지 — 서드파티 광고 신호 점수화 ===
// 본편 중간/끝의 서드파티 광고(windows.com·blinds.com·"45% off"·"terms apply"·"learn more at"…)는
// DAI 라 음성과 다르다. Shana 자체 홍보(AmericanEnglishPodcast.com/Academy/premium)는 베이크된
// 콘텐츠라 싱크 정상 → 광고로 보지 않는다(화이트리스트). 오탐("go to Virginia city" 등) 방지 위해
// 강한 신호 점수≥3(앵커) 또는 ≥3문장 클러스터만 광고로 인정.
const AD_SELF_RE = /(americanenglishpodcast\.com|the academy|premium content|episode notes)/i;
function adScore(text) {
  const t = String(text || '').toLowerCase();
  if (!t || AD_SELF_RE.test(t)) return 0;                  // 빈문장/자체홍보 제외
  let s = 0;
  if (/\b[a-z][a-z0-9-]*\.com\b/.test(t)) s += 2;          // 서드파티 도메인
  if (/promo code|use code|coupon code/.test(t)) s += 2;
  if (/free trial|terms (and conditions )?apply|rules (and restrictions )?apply/.test(t)) s += 2;
  if (/brought to you by|sponsored by|this episode is sponsored/.test(t)) s += 2;
  if (/\d{1,3}\s?% off|percent off/.test(t)) s += 1;
  if (/learn more at|subscribe now at|sign up (now|today)|offer ends|limited[- ]time/.test(t)) s += 1;
  if (/\bslash\b/.test(t)) s += 1;                          // 광고 URL 읽기 "X.com slash Y"
  return s;
}
// 광고 시간구간 [{s,e}] (문장 인덱스, 끝 배타적). 프리롤(인트로 앵커 앞) + 강한 광고 클러스터.
export function detectAdRanges(sentences) {
  const ranges = [];
  const K = detectContentStart(sentences);
  if (K > 0) ranges.push({ s: 0, e: K });
  const score = sentences.map((x) => adScore(x.text));
  let i = Math.max(K, 0);
  while (i < sentences.length) {
    if (score[i] >= 2) {
      let last = i, gap = 0, maxs = score[i], cnt = 1;
      for (let k = i + 1; k < sentences.length; k++) {
        if (score[k] >= 2) { last = k; gap = 0; maxs = Math.max(maxs, score[k]); cnt++; }
        else { gap++; if (gap > 1) break; }   // 광고 사이 1문장 갭까지 한 블록으로 연결
      }
      if (maxs >= 3 || cnt >= 3) { ranges.push({ s: i, e: last + 1 }); i = last + 1; continue; }
    }
    i++;
  }
  ranges.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const r of ranges) {                    // 인접/겹침 병합(프리롤+첫 클러스터 등)
    const prev = merged[merged.length - 1];
    if (prev && r.s <= prev.e) prev.e = Math.max(prev.e, r.e);
    else merged.push({ ...r });
  }
  return merged;
}

// === 문장 난이도 판정 (#8) ===
// "조금이라도 easy 가 아닌" 문장만 번역카드를 띄운다. 흔한 기초 단어로만 이뤄진 짧은 문장은 easy.
// 길이≥4 인 단어 중 COMMON 목록에 없는 단어가 하나라도 있거나, 문장이 길면 not-easy 로 본다(번역 노출).
const COMMON_EASY = new Set((
  'the a an and or but so if then than that this these those there here when while because as of to in on ' +
  'at by for with from into over under about after before up down out off again very just only also too not no ' +
  'yes yeah okay ok well right sure i you he she it we they me him her us them my your his its our their mine ' +
  'is am are was were be been being do does did done have has had having will would can could shall should may ' +
  'might must want wants wanted need needs go goes went gone going get gets got gotten come comes came make makes ' +
  'made take takes took know knows knew think thinks see sees saw look looks like likes feel feels say says said ' +
  'tell told give gives gave find found use uses used work works call calls try keep let put mean means ' +
  'good bad nice great big small long short high low new old same other more most much many some any each every ' +
  'all both few little lot kind sort thing things people person man woman kid day days time year week now today ' +
  'really pretty maybe always never often sometimes still even back away around down what who how why which whose ' +
  'one two three first last next another such own way ways part lot bit'
).split(/\s+/).filter(Boolean));

export function easyByWords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return true;
  if (words.length > 9) return false;                 // 긴 문장 → not easy
  for (const w of words) {
    if (w.length >= 4 && !COMMON_EASY.has(w)) return false;  // 흔치 않은 단어 포함 → not easy
  }
  return true;
}
