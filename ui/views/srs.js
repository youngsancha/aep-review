// SRS 플래시카드 — Quizlet/Drops/Anki 의 검증된 패턴 영어 적용.
//
// 학습 효율 설계:
//   - Active recall: 의미(definition)부터 보여주고 term 을 산출하게 함
//   - 3-stage layered reveal: 0(definition) → 1(audio + first letter) → 2(full reveal + example)
//   - 2-grade binary (Again/Got it) — 결정 피로 최소화
//   - Re-queue: "Again" 카드 같은 세션 끝에 다시
//   - Book-flip drag: 손가락 위치 ↔ 반응 일치, 운동기억 강화
//   - Haptic + auto-TTS at stage entry
//   - Keyboard: Space=advance, ←/→=grade, R=replay
import { escapeHtml, highlightTerm, toast } from '/app.js';
import { srsQueue, srsReview } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { playSentenceClip, stopClip } from '/clip.js';

// 같은 해시 재렌더(헤더 ↻ sync 는 hashchange 없이 route→renderSrs 재실행)로 keydown 리스너가
// 중첩되지 않게 직전 핸들러를 모듈 스코프에 보관 → 새로 붙이기 전에 제거한다(버그헌트 #4).
let _srsOnKey = null;

const GRADES = {
  again: { label: 'Again',  cls: 'again', dir: 'left',  arrow: '↺', requeue: true  },
  good:  { label: 'Got it', cls: 'good',  dir: 'right', arrow: '✓', requeue: false },
};

function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }

// "definition (Korean gloss)\n\n— example" → definition / example 분리
function splitBack(back) {
  const s = String(back || '');
  const parts = s.split(/\n\s*—\s*/);
  return { def: (parts[0] || '').trim(), example: (parts[1] || '').trim() };
}

function maskTerm(term) {
  // "clear up" → "c__ __" — 첫 글자만 노출, 길이 hint
  return term.split(' ').map((w) => {
    if (!w) return '';
    return w[0] + '_'.repeat(Math.max(0, w.length - 1));
  }).join(' ');
}

export async function renderSrs(root) {
  // srsQueue 는 REST 쿼리라 SW 가 캐시 못 함 → 오프라인이면 throw. 막다른 에러 대신 상태별 안내.
  // (Study 홈의 studyOverview 오프라인 처리와 동일 원칙, v1.41.0 정밀진단 수정.)
  let initial;
  try {
    initial = await srsQueue();
  } catch (e) {
    const offline = !navigator.onLine;
    root.innerHTML = `
      <div class="empty srs-done">
        <div class="srs-done-emoji">${offline ? '📴' : '⚠️'}</div>
        <p class="srs-done-title">${offline ? 'You are offline' : 'Could not load'}</p>
        <p class="srs-done-sub">${offline
          ? 'The review queue loads online. Try again once you are connected.'
          : escapeHtml(e.message)}</p>
        <button class="btn primary srs-done-cta" id="srs-retry">Try again</button>
        <a class="btn srs-done-cta" href="#/study">📚 Study</a>
      </div>`;
    root.querySelector('#srs-retry')?.addEventListener('click', () => renderSrs(root));
    return;
  }
  if (!initial.length) {
    root.innerHTML = `
      <div class="empty srs-done">
        <div class="srs-done-emoji">🎉</div>
        <p class="srs-done-title">Review complete!</p>
        <p class="srs-done-sub">No cards due. Explore more expressions in the Study tab,<br/>or practice with quizzes and sentences.</p>
        <a class="btn primary srs-done-cta" href="#/study">📚 Explore Study</a>
      </div>`;
    return;
  }

  const queue = [...initial];
  const total = queue.length;
  let done = 0, mastered = 0, againCount = 0;
  // 진짜 first-pass: 카드별 '첫 채점' 결과만 집계한다. done/mastered 는 재시도(again 후 재큐)를
  // 포함하므로 최종 정답률이지 첫 시도 정답률이 아니다 — 예전엔 그 값을 'first-pass' 로 표시했다.
  const _gradedOnce = new Set();
  let firstTry = 0, firstGood = 0;
  let stage = 0;
  let inFlight = false;

  // iOS 무음 첫 호출 방지
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => {});
  }

  function paint() {
    if (!queue.length) {
      const acc = firstTry > 0 ? Math.round(firstGood * 100 / firstTry) : 0;
      root.innerHTML = `
        <div class="srs-summary">
          <div class="srs-summary-num">${total}</div>
          <div class="srs-summary-title">Session complete</div>
          <div class="srs-summary-meta">
            ${done} reviews${againCount ? ` · ${againCount} retried` : ''} · ${acc}% first-pass
          </div>
          <div class="srs-summary-actions">
            <a class="btn primary" href="#/">Back to episodes</a>
            <!-- 예전엔 'Review again' + location.reload() 였는데, 방금 큐를 비운 직후라 새로고침해도
                 due 카드가 없어 항상 '복습 완료' 빈 화면으로 떨어졌다(약속과 다른 동작). 실제로
                 이어서 할 수 있는 곳으로 보낸다. -->
            <a class="btn secondary" href="#/study">📚 Study</a>
          </div>
        </div>`;
      return;
    }

    const c = queue[0];
    const term = c.front;
    const { def, example: backEx } = splitBack(c.back);
    const example = c.example_sentence || backEx;
    const startSec = c.sentence_start_sec;
    const masteryPct = total ? (mastered / total) * 100 : 0;

    // 다음 카드 (스택 underlay)
    const next = queue[1];

    root.innerHTML = `
      <div class="srs-progress-bar">
        <span class="srs-pchip">${queue.length} left</span>
        <span class="srs-ptrack"><span style="width:${masteryPct}%"></span></span>
        <span class="srs-pcount">${mastered} / ${total}</span>
      </div>
      ${(done > 0) ? `
        <div class="srs-session-stats">
          ${mastered > 0 ? `<span class="srs-pill good">+${mastered} got it</span>` : ''}
          ${againCount > 0 ? `<span class="srs-pill again">${againCount} retried</span>` : ''}
        </div>
      ` : ''}

      <div class="srs-deck">
        ${next ? `<div class="srs-card-back" aria-hidden="true"></div>` : ''}
        <div class="srs-flashcard srs-stage-${stage}" id="card">
          <div class="srs-card-inner">
            <div class="srs-ep">${escapeHtml(c.episode_title || '')}${c.vkind ? ` · ${escapeHtml(c.vkind.replace('_',' '))}` : ''}</div>

            ${stage === 0 ? `
              <div class="srs-closed">
                <div class="srs-closed-mark">?</div>
                <div class="srs-closed-prompt">Recall the expression from this episode</div>
              </div>
            ` : ''}

            ${stage >= 1 ? `<div class="srs-def">${escapeHtml(def)}</div>` : ''}

            ${stage >= 1 ? `
              <div class="srs-listen-row">
                <button class="srs-listen-btn" id="tts-btn" aria-label="Replay audio">🔊</button>
                <!-- 마스킹 힌트는 '아직 못 본' 단계(1)에서만. stage 2 는 바로 아래 .srs-term 으로
                     정답을 통째로 보여주므로, 같이 두면 힌트가 정답 옆에서 무의미하게 남는다. -->
                ${stage === 1 ? `<span class="srs-hint-mono">${escapeHtml(maskTerm(term))}</span>` : ''}
              </div>
            ` : ''}

            ${stage === 2 ? `
              <div class="srs-term">${escapeHtml(term)}</div>
              ${example ? `
                <div class="srs-example" ${startSec ? `data-start="${startSec}"` : ''}>
                  ${highlightTerm(example, term)}
                </div>
                ${(startSec && c.audio_url) ? `<button class="srs-context-btn" data-url="${escapeHtml(c.audio_url)}" data-s="${startSec}" data-e="${c.sentence_end_sec ?? ''}">🎧 Hear in context</button>` : ''}
              ` : ''}
            ` : ''}

            ${stage < 2 ? `
              <div class="srs-stage-hint">
                ${stage === 0 ? 'Tap → show hint' : 'Tap → reveal'}
              </div>
            ` : ''}
          </div>

          <div class="srs-drag-tag drag-tag-left">  ↺ Again</div>
          <div class="srs-drag-tag drag-tag-right">Got it ✓</div>
        </div>
      </div>

      ${stage === 2 ? `
        <div class="srs-actions">
          <button class="btn danger"  data-grade="again">↺ Again<small>←</small></button>
          <button class="btn primary" data-grade="good">Got it ✓<small>→</small></button>
        </div>
        <div class="srs-swipe-hint">swipe ← Again · Got it → ·  Space to listen</div>
      ` : `
        <button class="btn primary srs-cta" id="advance-btn">
          ${stage === 0 ? '👁  Show hint' : '✨ Reveal'}
        </button>
        <div class="srs-swipe-hint">tap card · swipe ↑ / →</div>
      `}
    `;

    const card = root.querySelector('#card');

    if (stage === 0) {
      // 다음 stage 진입 시 즉시 재생되도록 미리 합성
      prefetch([term]);
    }

    // 이 렌더에서 이미 진행했는가. 스와이프는 뒤이어 합성 click 을 남기는데, 둘 다 advance 를
    // 호출하면 0→1→2 로 한 번에 튀어 '떠올리기' 단계가 통째로 스킵됐다. paint() 마다 새 클로저가
    // 만들어지므로 렌더 단위 플래그로 정확히 1회만 통과시킨다.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (stage === 0) {
        stage = 1;
        paint();
        requestAnimationFrame(() => speak(term));
      } else if (stage === 1) {
        stage = 2;
        paint();
        requestAnimationFrame(() => speak(term));
      }
    };

    if (stage < 2) {
      card.addEventListener('click', advance);
      root.querySelector('#advance-btn').addEventListener('click', advance);
      attachSimpleSwipe(card, (dir) => {
        if (dir === 'up' || dir === 'right') advance();
      });
      const ttsBtn = root.querySelector('#tts-btn');
      if (ttsBtn) ttsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        speak(term);
      });
    } else {
      // stage 2 — drag-to-grade with live visual feedback + buttons
      card.addEventListener('click', () => speak(term));
      root.querySelector('#tts-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        speak(term);
      });
      // example 클릭 시 (지금은) 오디오 X — 추후 episode 페이지로 점프 가능. v1 은 발음만 재생.
      const exEl = root.querySelector('.srs-example');
      if (exEl) exEl.addEventListener('click', (e) => {
        e.stopPropagation();
        speak(exEl.textContent.trim());
      });
      // '맥락에서 듣기' — 화면 전환 없이 그 문장의 '실제 음성'만 인라인 재생(#20).
      const ctxBtn = root.querySelector('.srs-context-btn');
      if (ctxBtn) ctxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playSentenceClip(ctxBtn.dataset.url, ctxBtn.dataset.s, ctxBtn.dataset.e, ctxBtn, undefined, false, 0, () => speak(example));
      });
      attachBookFlip(card, (dir) => {
        if (dir === 'right') grade('good');
        else if (dir === 'left') grade('again');
      });
      root.querySelectorAll('.srs-actions [data-grade]').forEach((btn) => {
        btn.addEventListener('click', () => grade(btn.dataset.grade));
      });
    }
  }

  async function grade(gradeKey) {
    if (inFlight) return;
    const g = GRADES[gradeKey];
    if (!g) return;
    inFlight = true;
    vibrate(15);

    const c = queue[0];
    const card = root.querySelector('#card');
    if (card) {
      card.style.transform = '';
      card.classList.remove('drag-right', 'drag-left');
      card.classList.add('book-flip-' + g.dir);
    }

    // 오프라인이면 채점 저장이 실패하는데, 카드는 애니메이션으로 사라지고 카운트만 올라가 사용자는
    // 저장된 줄 안다 → 정직하게 알린다(아직 오프라인 큐/재전송은 없음).
    srsReview(c.id, gradeKey).catch((e) => {
      console.warn('srs review failed', e);
      if (!navigator.onLine) toast('Offline — this review was not saved');
    });

    done++;
    if (gradeKey === 'again') againCount++;
    else mastered++;
    if (!_gradedOnce.has(c.id)) {          // 이 카드의 '첫' 채점만 first-pass 통계에 반영
      _gradedOnce.add(c.id);
      firstTry++;
      if (gradeKey !== 'again') firstGood++;
    }

    setTimeout(() => {
      stopClip();  // 다음 카드로 넘어가면 이전 맥락 재생 정지
      const removed = queue.shift();
      if (g.requeue) queue.push(removed);
      stage = 0;
      inFlight = false;
      paint();
    }, 320);
  }

  // ===== Keyboard shortcuts =====
  function onKey(e) {
    // 입력 위젯 안에서는 무시
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const c = queue[0];
    if (!c) return;
    const term = c.front;
    if (e.code === 'Space') {
      e.preventDefault();
      if (stage < 2) {
        // advance
        document.getElementById('advance-btn')?.click();
      } else {
        speak(term);
      }
    } else if (e.code === 'ArrowRight' || e.code === 'Enter') {
      if (stage === 2) { e.preventDefault(); grade('good'); }
      else { e.preventDefault(); document.getElementById('advance-btn')?.click(); }
    } else if (e.code === 'ArrowLeft' || e.code === 'Backspace') {
      if (stage === 2) { e.preventDefault(); grade('again'); }
    } else if (e.key && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      speak(term);
    }
  }
  if (_srsOnKey) window.removeEventListener('keydown', _srsOnKey);  // 직전 렌더의 핸들러 제거(중첩 방지 #4)
  _srsOnKey = onKey;
  window.addEventListener('keydown', onKey);
  // route 변경 시 리스너 정리 — hashchange 1회만 받고 unbind
  const cleanup = () => {
    window.removeEventListener('keydown', onKey);
    if (_srsOnKey === onKey) _srsOnKey = null;
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup);

  paint();
}

// ---------- 단순 4방향 swipe (stage 0/1 advance) ----------
function attachSimpleSwipe(el, onDir) {
  let sx = 0, sy = 0, t0 = 0;
  const THRESHOLD = 60;
  const VELOCITY  = 0.3;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    t0 = Date.now();
  }, {passive: true});

  el.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const dt = Math.max(1, Date.now() - t0);
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const v  = Math.max(ax, ay) / dt;
    if (Math.max(ax, ay) < THRESHOLD && v < VELOCITY) return;
    let dir;
    if (ax > ay) dir = dx > 0 ? 'right' : 'left';
    else         dir = dy > 0 ? 'down'  : 'up';
    onDir(dir);
  });
}

// ---------- 책장 넘기기 drag (stage 2, live rotate + tint) ----------
function attachBookFlip(el, onDir) {
  let sx = 0, sy = 0, dragging = false;
  const COMMIT_PX = 90;

  function setDrag(dx) {
    const rotY = Math.max(-22, Math.min(22, dx / 7));
    el.style.transform = `translateX(${dx}px) rotate(${rotY * 0.4}deg)`;
    el.classList.toggle('drag-right', dx > 30);
    el.classList.toggle('drag-left', dx < -30);
  }
  function reset() {
    el.style.transition = 'transform 220ms cubic-bezier(0.4,0,0.2,1)';
    el.style.transform = '';
    el.classList.remove('drag-right', 'drag-left');
    setTimeout(() => { el.style.transition = ''; }, 240);
  }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    dragging = true;
    el.style.transition = 'none';
  }, {passive: true});

  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 20) {
      dragging = false; reset(); return;
    }
    setDrag(dx);
  }, {passive: true});

  el.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - sx;
    if (dx > COMMIT_PX) onDir('right');
    else if (dx < -COMMIT_PX) onDir('left');
    else reset();
  });

  // 데스크톱 mouse — 단순 버전
  let mDown = false;
  el.addEventListener('mousedown', (e) => {
    sx = e.clientX; sy = e.clientY; mDown = true;
    el.style.transition = 'none';
  });
  el.addEventListener('mousemove', (e) => { if (mDown) setDrag(e.clientX - sx); });
  el.addEventListener('mouseup', (e) => {
    if (!mDown) return;
    mDown = false;
    const dx = e.clientX - sx;
    if (dx > COMMIT_PX) onDir('right');
    else if (dx < -COMMIT_PX) onDir('left');
    else reset();
  });
  el.addEventListener('mouseleave', () => { if (mDown) { mDown = false; reset(); } });
}
