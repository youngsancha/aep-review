// Library — Apple Podcasts style: cover hero + grouped episode rows.
import { escapeHtml, fmtDuration, fmtDate, toast } from '/app.js';
import { listEpisodes, audioSrcFor } from '/db.js';
import { player, getProgressMap, getCompleted } from '/player.js';
import { showCover, currentShow, setCurrentShow, MULTISHOW, showOptions, showMeta } from '/config.js';

const SVG_PLAY_SM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';

let _prog = {};        // 에피소드별 재생 진도 맵 (행에 들은 정도 표시)
let _done = new Set(); // 완료(끝까지 들음) 집합
// 현재 쇼 커버(사이즈 변형) — 정적 import 대신 렌더마다 갱신해 쇼 전환 시 즉시 반영(멀티-쇼).
let _coverLg = '', _coverSm = '';
function refreshCovers() {
  const c = showCover(currentShow());
  _coverLg = c + '&w=720&h=720';
  _coverSm = c + '&w=160&h=160';
}

export async function renderTimeline(root) {
  refreshCovers();
  root.innerHTML = skeletonHtml();  // shimmer 플레이스홀더 (로드 전 바로 표시)
  const _startHash = location.hash;
  const items = await listEpisodes();
  // 스테일 렌더 방지: listEpisodes 를 기다리는 사이 다른 화면(에피소드 등)으로 이동했으면 중단
  // (느린 초기 로드 중 회차 탭 → 열린 에피소드를 라이브러리가 덮어쓰던 경우). 해시 없는 하니스는 무영향.
  if (location.hash !== _startHash) return;
  _prog = getProgressMap();
  _done = getCompleted();

  if (!items.length) {
    root.innerHTML = `
      ${showSwitchHtml()}
      ${heroHtml({total: 0, ready: 0})}
      <div class="empty">
        No episodes yet.<br />
        Tap the ↻ button (top right) to sync the RSS feed.
      </div>
    `;
    wireShowSwitch(root);
    return;
  }

  const ready = items.filter((e) => e.vocab_count > 0).length;

  let html = showSwitchHtml();
  // 오프라인이면 안내 배너 — ⬇ 배지 회차만 재생 가능함을 미리 알린다.
  if (!navigator.onLine) html += `<div class="offline-note">📴 Offline — episodes marked ⬇ are available</div>`;
  html += heroHtml({total: items.length, ready});
  html += continueHtml(items);  // 이어듣기 (현재 쇼에서 마지막으로 듣던 회차)
  html += featuredHtml(items[0]);                     // 최신 에피소드 피처 카드
  html += `<div class="ep-search-wrap"><input id="ep-search" class="ep-search" type="search" placeholder="🔍 Search episodes" autocomplete="off" /></div>`;
  html += `<div id="ep-groups">${groupsHtml(items)}</div>`;
  root.innerHTML = html;

  wireShowSwitch(root);
  wirePlay(root, items);
  markOfflineReady(root);

  // 에피소드 검색 — 제목/설명 클라이언트 필터
  const $s = root.querySelector('#ep-search');
  if ($s) {
    let timer = 0;
    $s.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = $s.value.trim().toLowerCase();
        const filtered = !q ? items : items.filter((e) =>
          (e.title || '').toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q));
        const box = root.querySelector('#ep-groups');
        box.innerHTML = filtered.length ? groupsHtml(filtered, true) : '<div class="empty">No results.</div>';
        wirePlay(box, items);
        markOfflineReady(box);
      }, 150);
    });
  }
}

// 오프라인 준비된(오디오 캐시 완료) 회차에 ⬇ 배지 부착 — 캐시 조회가 비동기라 렌더 후 처리.
// 실패해도(캐시 미지원 등) 라이브러리는 평소대로 동작한다.
function markOfflineReady(scope) {
  import('/offline.js').then(async (m) => {
    const ready = await m.offlineReadyIds();
    // 상태줄: 준비된 회차 수 + 마지막 프리페치 실행 상태 — "오프라인이 안 된다"의 원인을 화면에서 진단.
    const $st = document.getElementById('lib-offline');
    if ($st) {
      const target = m.offlineCount();
      const st = m.offlineRunStatus ? m.offlineRunStatus() : null;
      let txt = '';
      if (target > 0 && !navigator.onLine) txt = `⬇ ${ready.size} episodes available offline`;
      else if (target > 0) {
        txt = `⬇ Offline: ${ready.size}/${target} ready`;
        if (st && st.phase === 'running') txt += ' · downloading…';
        else if (st && st.phase === 'skipped') txt += ` · paused: ${st.note || ''}`;
        else if (st && st.phase === 'error') txt += ` · error: ${st.note || ''}`;
        else if (st && st.note) txt += ` · last issue: ${st.note}`;
      } else txt = '⬇ Offline downloads off · tap to enable';
      $st.textContent = txt;
      $st.classList.add('tappable');
      // 유지 회차 수를 devtools 없이 한 탭으로 조절(0→5→15→30 순환). 켜면 즉시 프리페치 재실행.
      // markOfflineReady 는 검색/재렌더로 여러 번 불리므로 리스너는 1회만 붙인다.
      if (!$st.dataset.wired) {
        $st.dataset.wired = '1';
        $st.setAttribute('role', 'button');
        $st.setAttribute('tabindex', '0');
        const cycle = async () => {
          const CYCLE = [0, 5, 15, 30];
          const i = CYCLE.indexOf(m.offlineCount());
          const next = CYCLE[(i + 1) % CYCLE.length];
          m.setOfflineCount(next);
          if (next > 0) { toast(`오프라인 저장: 최근 ${next}개 받는 중…`); m.forceRun && m.forceRun(); }
          else toast('오프라인 저장 끔');
          setTimeout(() => markOfflineReady(scope), 400);   // 상태줄 즉시 반영
        };
        $st.addEventListener('click', cycle);
        $st.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle(); } });
      }
    }
    if (!ready.size) return;
    scope.querySelectorAll('.ep-row[data-id]').forEach((row) => {
      if (!ready.has(Number(row.dataset.id)) || row.querySelector('.offline-ep')) return;
      const foot = row.querySelector('.ep-foot');
      if (!foot) return;
      let chips = foot.querySelector('.ep-chips');
      if (!chips) {
        chips = document.createElement('div');
        chips.className = 'ep-chips';
        foot.appendChild(chips);
      }
      const b = document.createElement('span');
      b.className = 'chip offline-ep';
      b.textContent = '⬇';
      b.title = 'Available offline';
      chips.appendChild(b);
    });
  }).catch(() => {});
}

// ▶ 버튼(행/피처/이어재생) → 인라인 재생. 이어재생은 저장 위치에서 resume.
function wirePlay(scope, items) {
  scope.querySelectorAll('.ep-play, .feat-play, .cont-play').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const ep = items.find((x) => x.id === id);
      if (!ep || !ep.audio_url) return;
      const src = await audioSrcFor(ep.id, ep.audio_url);  // 호스팅됐으면 R2, 아니면 megaphone(에피소드 뷰와 동일)
      player.load({
        id: ep.id,
        title: ep.title,
        show: showMeta(currentShow()).name,
        cover: _coverSm,
        src,
      });
      // 이어재생: 저장 위치로 seek 후 재생. (metadata 준비 전이면 meta 이벤트에서)
      const resume = parseFloat(btn.dataset.resume || '0') || 0;
      const go = () => { if (resume > 0) player.seek(resume); player.play(); };
      if (player.duration) go();
      else { const offMeta = player.on((ev) => { if (ev === 'meta') { go(); offMeta(); } }); }
    });
  });
  // "스크립트로 보기" → transcript 화면 진입 + 자동재생 + 시트 자동 열기 (논스톱)
  // sessionStorage 플래그를 남기고 링크 이동 → episode 뷰가 읽어서 처리.
  scope.querySelectorAll('.feat-script, .cont-script').forEach((a) => {
    a.addEventListener('click', () => {
      try { sessionStorage.setItem('aep-open-script', a.dataset.id || ''); } catch (e) {}
    });
  });
}

// === 멀티-쇼 선택기 — 두 팟캐스트 전환(MULTISHOW 활성 시만 노출). 단일쇼면 '' 반환 → 기존 동일. ===
// aep 라이브러리 톤(커버 + 이름 + 레벨, 활성=그라데이션)에 맞춘 세그먼트 카드.
function showSwitchHtml() {
  if (!MULTISHOW) return '';
  const opts = showOptions();
  if (opts.length < 2) return '';
  const segs = opts.map((s) => `
    <button class="show-seg${s.active ? ' active' : ''}" data-show="${s.slug}" role="tab" aria-selected="${s.active}">
      <img class="show-seg-cover" src="${s.cover}&w=120&h=120" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <span class="show-seg-txt">
        <span class="show-seg-name">${escapeHtml(s.short || s.name)}</span>
        <span class="show-seg-level">${escapeHtml(s.level)}</span>
      </span>
      <span class="show-seg-check" aria-hidden="true">✓</span>
    </button>`).join('');
  return `<div class="show-switch" role="tablist" aria-label="팟캐스트 선택">${segs}</div>`;
}

function wireShowSwitch(scope) {
  scope.querySelectorAll('.show-seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.show;
      if (!slug || slug === currentShow()) return;
      setCurrentShow(slug);
      if (navigator.vibrate) navigator.vibrate(8);
      // 새 쇼 기준으로 라이브러리 전체 재렌더(에피소드 목록·커버·이어듣기 모두 새 쇼).
      const root = btn.closest('#app') || document.getElementById('app') || scope;
      renderTimeline(root);
    });
  });
}

// 시즌별(내림차순) 그룹 — 최신 시즌만 펼치고 이전 시즌은 접이식(<details>). openAll=검색 시 전부 펼침.
function groupsHtml(list, openAll = false) {
  const groups = new Map();
  for (const e of list) {
    const key = e.season != null ? `Season ${e.season}` : 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const ax = parseInt(a.replace('Season ', '')) || -1;
    const bx = parseInt(b.replace('Season ', '')) || -1;
    return bx - ax;
  });
  let html = '';
  sortedKeys.forEach((key, i) => {
    const eps = groups.get(key);
    const open = openAll || i === 0;  // 최신 시즌(i=0)만 기본 펼침
    html += `
      <details class="season-group"${open ? ' open' : ''}>
        <summary class="section-h season-head">
          <h2>${escapeHtml(key)}</h2>
          <span class="season-right"><span class="count">${eps.length} episodes</span><span class="season-caret" aria-hidden="true">⌄</span></span>
        </summary>
        <div class="ep-list">${eps.map(rowHtml).join('')}</div>
      </details>`;
  });
  return html;
}

// 이어듣기 카드 — '현재 쇼'에서 마지막으로 듣던 회차로 재개(쇼별 독립).
// 멀티쇼 버그 수정: 예전엔 getLatestProgress()(전역 마지막 재생)를 현재쇼 items 위에 그렸다 →
// 다른 쇼 회차면 items.find 가 못 찾아 커버는 현재쇼(AEE)인데 제목/오디오는 stale(AEP) + Resume 死.
// 이제 현재 쇼 items 에 속한 진행만 본다 → 커버·제목·resume 이 항상 같은 쇼로 일치.
function continueHtml(items) {
  const map = getProgressMap();
  let prog = null, ep = null;
  for (const e of items) {
    const p = map[e.id];
    if (p && p.t && (!prog || p.at > prog.at)) { prog = p; ep = e; }
  }
  if (!prog || !ep) return '';
  const title = (ep.title || '').replace(/^\d+\s*[-:.]\s*/, '');
  if (!title) return '';
  const pct = prog.dur ? Math.min(100, Math.round((prog.t / prog.dur) * 100)) : 0;
  const left = prog.dur ? Math.max(1, Math.round((prog.dur - prog.t) / 60)) : 0;
  return `
    <div class="section-h"><h2>Continue</h2></div>
    <div class="cont-card">
      <a class="cont-cover-link" href="#/episode/${ep.id}" aria-label="${escapeHtml(title)}">
        <img class="cont-cover" src="${_coverSm}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
      </a>
      <div class="cont-body">
        <a class="cont-title" href="#/episode/${ep.id}">${escapeHtml(title)}</a>
        <div class="cont-bar"><span style="width:${pct}%"></span></div>
        <div class="cont-meta">${pct}% played · ${left} min left</div>
        <div class="cont-actions">
          <button class="cont-play" data-id="${ep.id}" data-resume="${prog.t}">▶ Resume</button>
          <a class="cont-script" data-id="${ep.id}" href="#/episode/${ep.id}">View Script ›</a>
        </div>
      </div>
    </div>`;
}

function skeletonHtml() {
  const row = '<div class="skel-row"><div class="skel-thumb"></div><div class="skel-lines"><span class="skel-line w40"></span><span class="skel-line w90"></span><span class="skel-line w60"></span></div></div>';
  return `<div class="skel-hero"></div>${Array(6).fill(row).join('')}`;
}

function heroHtml({total, ready}) {
  // 브랜딩 히어로(커버+'American English Podcast' 로고) 제거 — 슬림한 라이브러리 헤더로 정리.
  return `
    <div class="library-head">
      <h1 class="library-title">Library</h1>
      <div class="library-sub">${total} episodes${ready < total ? ` · ${total - ready} preparing` : ' · all ready'}</div>
      <div id="lib-offline" class="library-offline"></div>
    </div>
  `;
}

function featuredHtml(e) {
  if (!e) return '';
  const title = (e.title || '').replace(/^\d+\s*[-:.]\s*/, '');
  const meta = [fmtDate(e.pub_date), e.duration_sec ? fmtDuration(e.duration_sec) : '']
    .filter(Boolean).join(' · ');
  const desc = (e.description || '').replace(/<[^>]+>/g, '').trim();
  return `
    <div class="section-h"><h2>Latest Episode</h2></div>
    <div class="feat-card">
      <div class="feat-bg" style="background-image:url('${_coverLg}')"></div>
      <div class="feat-inner">
        <img class="feat-cover" src="${_coverSm}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
        <div class="feat-body">
          <a class="feat-title" href="#/episode/${e.id}">${escapeHtml(title)}</a>
          <div class="feat-meta">${escapeHtml(meta)}</div>
        </div>
      </div>
      ${desc ? `<p class="feat-desc">${escapeHtml(desc)}</p>` : ''}
      <div class="feat-actions">
        ${e.has_audio ? `<button class="feat-play" data-id="${e.id}">▶ Play</button>` : ''}
        <a class="feat-script" data-id="${e.id}" href="#/episode/${e.id}">View Script ›</a>
      </div>
    </div>
  `;
}

function rowHtml(e) {
  const num = e.episode_no != null ? `#${e.episode_no}` : '';
  const desc = (e.description || '').replace(/<[^>]+>/g, '').trim();
  const title = (e.title || '').replace(/^\d+\s*[-:.]\s*/, '');
  // 들은 진도(부분 청취) — Apple Podcasts 처럼 행에 얇은 막대 + 남은 시간 표시
  const p = _prog[e.id];
  const pct = (p && p.dur && p.t) ? Math.min(99, Math.round(p.t / p.dur * 100)) : 0;
  const leftMin = (pct && p.dur) ? Math.max(1, Math.round((p.dur - p.t) / 60)) : 0;
  const done = !pct && _done.has(e.id);  // 완료(이어듣기 중이 아닐 때만 ✓)

  const chips = [];
  const isNew = e.pub_date && (Date.now() - new Date(e.pub_date).getTime()) < 21 * 864e5;
  if (isNew) chips.push('<span class="chip new-ep">NEW</span>');
  if (done) chips.push('<span class="chip done-ep">✓ Played</span>');
  if (!e.transcribed_at && e.has_audio) chips.push(`<span class="chip warn">pending</span>`);

  return `
    <a class="ep-row${pct ? ' resumable' : ''}${done ? ' played' : ''}" data-id="${e.id}" href="#/episode/${e.id}">
      <div class="ep-thumb">
        <img src="${_coverSm}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
        ${num ? `<span class="ep-num">${escapeHtml(num)}</span>` : ''}
      </div>
      <div class="ep-body">
        <div class="ep-date">${escapeHtml(fmtDate(e.pub_date))}</div>
        <p class="ep-title">${escapeHtml(title)}</p>
        ${desc ? `<p class="ep-desc">${escapeHtml(desc)}</p>` : ''}
        <div class="ep-foot">
          ${e.has_audio ? `<button class="ep-play" data-id="${e.id}" aria-label="Play">${SVG_PLAY_SM}</button>` : ''}
          <span class="ep-meta">${pct ? `▶ ${leftMin} min left` : (e.duration_sec ? escapeHtml(fmtDuration(e.duration_sec)) : '')}</span>
          ${chips.length ? `<div class="ep-chips">${chips.join('')}</div>` : ''}
        </div>
        ${pct ? `<div class="ep-progress" aria-label="${pct}% played"><span style="width:${pct}%"></span></div>` : ''}
      </div>
    </a>
  `;
}
