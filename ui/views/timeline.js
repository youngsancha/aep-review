// Library — Apple Podcasts style: cover hero + grouped episode rows.
import { escapeHtml, fmtDuration, fmtDate } from '/app.js';
import { listEpisodes, srsStats, cleanAudioUrl } from '/db.js';
import { player, getLatestProgress } from '/player.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';

const SVG_PLAY_SM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';

export async function renderTimeline(root) {
  root.innerHTML = skeletonHtml();  // shimmer 플레이스홀더 (로드 전 바로 표시)
  const items = await listEpisodes();
  const stats = await srsStats().catch(() => null);

  if (!items.length) {
    root.innerHTML = `
      ${heroHtml({total: 0, ready: 0, due: 0})}
      <div class="empty">
        에피소드가 아직 없습니다.<br />
        우측 상단 ↻ 버튼을 눌러 RSS 피드를 동기화하세요.
      </div>
    `;
    return;
  }

  const ready = items.filter((e) => e.vocab_count > 0).length;
  const due = stats?.today_batch || 0;

  let html = heroHtml({total: items.length, ready, due});
  html += continueHtml(getLatestProgress(), items);  // 이어듣기 (저장된 재생위치)
  html += featuredHtml(items[0]);                     // 최신 에피소드 피처 카드
  html += `<div class="ep-search-wrap"><input id="ep-search" class="ep-search" type="search" placeholder="🔍 에피소드 검색" autocomplete="off" /></div>`;
  html += `<div id="ep-groups">${groupsHtml(items)}</div>`;
  root.innerHTML = html;

  wirePlay(root, items);

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
        box.innerHTML = filtered.length ? groupsHtml(filtered) : '<div class="empty">검색 결과가 없어요.</div>';
        wirePlay(box, items);
      }, 150);
    });
  }
}

// ▶ 버튼(행/피처) → 인라인 재생
function wirePlay(scope, items) {
  scope.querySelectorAll('.ep-play, .feat-play').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const ep = items.find((x) => x.id === id);
      if (!ep || !ep.audio_url) return;
      player.load({
        id: ep.id,
        title: ep.title,
        show: 'American English Podcast',
        cover: SHOW_COVER_SM,
        src: cleanAudioUrl(ep.audio_url),
      });
      player.play();
    });
  });
}

// 시즌별(내림차순) 그룹 섹션 HTML
function groupsHtml(list) {
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
  for (const key of sortedKeys) {
    const eps = groups.get(key);
    html += `
      <div class="section-h">
        <h2>${escapeHtml(key)}</h2>
        <span class="count">${eps.length} episodes</span>
      </div>
      <div class="ep-list">${eps.map(rowHtml).join('')}</div>`;
  }
  return html;
}

// 이어듣기 카드 — 마지막으로 듣던 에피소드로 재개 (#/episode/:id → 저장위치에서 resume)
function continueHtml(prog, items) {
  if (!prog || !prog.id || !prog.t) return '';
  const ep = items.find((e) => e.id === prog.id);
  const title = (((ep && ep.title) || prog.title) || '').replace(/^\d+\s*[-:.]\s*/, '');
  if (!title) return '';
  const pct = prog.dur ? Math.min(100, Math.round((prog.t / prog.dur) * 100)) : 0;
  const left = prog.dur ? Math.max(1, Math.round((prog.dur - prog.t) / 60)) : 0;
  return `
    <div class="section-h"><h2>이어듣기</h2></div>
    <a class="cont-card" href="#/episode/${prog.id}">
      <img class="cont-cover" src="${SHOW_COVER_SM}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
      <div class="cont-body">
        <div class="cont-title">${escapeHtml(title)}</div>
        <div class="cont-bar"><span style="width:${pct}%"></span></div>
        <div class="cont-meta">${pct}% 들음 · ${left}분 남음</div>
      </div>
      <span class="cont-play">▶</span>
    </a>`;
}

function skeletonHtml() {
  const row = '<div class="skel-row"><div class="skel-thumb"></div><div class="skel-lines"><span class="skel-line w40"></span><span class="skel-line w90"></span><span class="skel-line w60"></span></div></div>';
  return `<div class="skel-hero"></div>${Array(6).fill(row).join('')}`;
}

function heroHtml({total, ready, due}) {
  return `
    <div class="show-hero">
      <div class="show-hero-bg" style="background-image:url('${SHOW_COVER}')"></div>
      <img class="show-hero-cover" src="${SHOW_COVER}" alt="" onerror="this.src='/icons/icon-512.png'" />
      <h1 class="show-hero-title">American English Podcast</h1>
      <p class="show-hero-host">Shana Thompson · Language Learning</p>
      <div class="show-hero-stats">
        <span class="show-stat">${total} episodes</span>
        <span class="show-stat">${ready} ready</span>
        <span class="show-stat">${due} due</span>
      </div>
    </div>
  `;
}

function featuredHtml(e) {
  if (!e) return '';
  const title = (e.title || '').replace(/^\d+\s*[-:.]\s*/, '');
  const meta = [fmtDate(e.pub_date), e.duration_sec ? fmtDuration(e.duration_sec) : '', e.vocab_count ? `${e.vocab_count} vocab` : '']
    .filter(Boolean).join(' · ');
  const desc = (e.description || '').replace(/<[^>]+>/g, '').trim();
  return `
    <div class="section-h"><h2>최신 에피소드</h2></div>
    <div class="feat-card">
      <div class="feat-bg" style="background-image:url('${SHOW_COVER}')"></div>
      <div class="feat-inner">
        <img class="feat-cover" src="${SHOW_COVER_SM}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
        <div class="feat-body">
          <div class="feat-label">▶ 최신화</div>
          <a class="feat-title" href="#/episode/${e.id}">${escapeHtml(title)}</a>
          <div class="feat-meta">${escapeHtml(meta)}</div>
        </div>
      </div>
      ${desc ? `<p class="feat-desc">${escapeHtml(desc)}</p>` : ''}
      <div class="feat-actions">
        ${e.has_audio ? `<button class="feat-play" data-id="${e.id}">▶ 재생</button>` : ''}
        <a class="feat-script" href="#/episode/${e.id}">스크립트로 보기 ›</a>
      </div>
    </div>
  `;
}

function rowHtml(e) {
  const num = e.episode_no != null ? `#${e.episode_no}` : '';
  const desc = (e.description || '').replace(/<[^>]+>/g, '').trim();
  const chips = [];
  const isNew = e.pub_date && (Date.now() - new Date(e.pub_date).getTime()) < 21 * 864e5;
  if (isNew) chips.push('<span class="chip new-ep">NEW</span>');
  if (e.vocab_count > 0) chips.push(`<span class="chip vocab">${e.vocab_count} vocab</span>`);
  if (!e.transcribed_at && e.has_audio) chips.push(`<span class="chip warn">pending</span>`);

  const title = (e.title || '').replace(/^\d+\s*[-:.]\s*/, '');
  return `
    <a class="ep-row" href="#/episode/${e.id}">
      <div class="ep-thumb">
        <img src="${SHOW_COVER_SM}" alt="" loading="lazy" onerror="this.src='/icons/icon-192.png'" />
        ${num ? `<span class="ep-num">${escapeHtml(num)}</span>` : ''}
      </div>
      <div class="ep-body">
        <div class="ep-date">${escapeHtml(fmtDate(e.pub_date))}</div>
        <p class="ep-title">${escapeHtml(title)}</p>
        ${desc ? `<p class="ep-desc">${escapeHtml(desc)}</p>` : ''}
        <div class="ep-foot">
          ${e.has_audio ? `<button class="ep-play" data-id="${e.id}" aria-label="Play">${SVG_PLAY_SM}</button>` : ''}
          ${e.duration_sec ? `<span class="ep-meta">${escapeHtml(fmtDuration(e.duration_sec))}</span>` : ''}
          ${chips.length ? `<div class="ep-chips">${chips.join('')}</div>` : ''}
        </div>
      </div>
    </a>
  `;
}
