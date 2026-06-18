// Library — Apple Podcasts style: cover hero + grouped episode rows.
import { escapeHtml, fmtDuration, fmtDate } from '/app.js';
import { listEpisodes, srsStats, cleanAudioUrl } from '/db.js';
import { player } from '/player.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';

const SVG_PLAY_SM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';

export async function renderTimeline(root) {
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

  // Group by season (descending)
  const groups = new Map();
  for (const e of items) {
    const key = e.season != null ? `Season ${e.season}` : 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const ax = parseInt(a.replace('Season ', '')) || -1;
    const bx = parseInt(b.replace('Season ', '')) || -1;
    return bx - ax;
  });

  let html = heroHtml({total: items.length, ready, due});
  for (const key of sortedKeys) {
    const eps = groups.get(key);
    html += `
      <div class="section-h">
        <h2>${escapeHtml(key)}</h2>
        <span class="count">${eps.length} episodes</span>
      </div>
      <div class="ep-list">
        ${eps.map(rowHtml).join('')}
      </div>
    `;
  }
  root.innerHTML = html;

  // Wire ▶ buttons — start playback inline (no nav)
  document.querySelectorAll('.ep-row .ep-play').forEach((btn) => {
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

function heroHtml({total, ready, due}) {
  return `
    <div class="show-hero">
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

function rowHtml(e) {
  const num = e.episode_no != null ? `#${e.episode_no}` : '';
  const desc = (e.description || '').replace(/<[^>]+>/g, '').trim();
  const chips = [];
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
