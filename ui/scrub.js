// Apple Podcasts 식 스와이프/드래그 시크 바 — 미니플레이어와 트랜스크립트 시트가 공유.
// 가로 드래그(또는 탭)로 재생 위치를 옮긴다. Pointer Events 로 터치·마우스·펜을 한 번에 처리하고,
// setPointerCapture 로 손가락이 바 밖으로 나가도 끝까지 추적한다.
//
// 사용: const s = bindScrub(trackEl, { onPreview(frac), onSeek(frac) });
//   onPreview(frac) : 드래그 중 매 이동마다 호출(오디오는 아직 안 옮김 — fill/핸들/시간만 갱신해 부드럽게).
//   onSeek(frac)    : 손을 뗄 때 1회(실제 player.seek). 탭만 해도 그 지점으로 1회 호출된다.
//   s.isDragging()  : 드래그 중이면 true — 외부 refresh 루프가 fill 을 덮어쓰지 않게 게이트로 쓴다.
//   s.destroy()     : 라우트 이탈 시 리스너 해제(트랜스크립트 시트처럼 매번 새로 만들 때 필수).
//
// frac 은 항상 [0,1]. track 엔 CSS `touch-action: none` 을 줘야 가로 드래그 시 페이지가 안 스크롤된다.
export function bindScrub(track, { onPreview, onSeek } = {}) {
  let dragging = false;

  const fracAt = (clientX) => {
    const r = track.getBoundingClientRect();
    if (!r.width) return 0;                       // 숨김 상태(시트 닫힘 등) 방어
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const ptX = (e) =>
    e.touches && e.touches[0] ? e.touches[0].clientX
    : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX
    : e.clientX;

  const onDown = (e) => {
    dragging = true;
    track.classList.add('scrubbing');
    try { track.setPointerCapture(e.pointerId); } catch (_) {}
    onPreview && onPreview(fracAt(ptX(e)));
    e.preventDefault();
    e.stopPropagation();   // 미니플레이어(바깥 탭=에피소드로 이동) 등 부모 제스처와 충돌 방지
  };
  const onMove = (e) => {
    if (!dragging) return;
    onPreview && onPreview(fracAt(ptX(e)));
    e.preventDefault();
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('scrubbing');
    onSeek && onSeek(fracAt(ptX(e)));
  };
  // 드래그/탭 뒤 발생하는 click 이 부모로 전파돼(미니플레이어 네비게이트) 오작동하지 않게 차단.
  const onClick = (e) => { e.stopPropagation(); };

  track.addEventListener('pointerdown', onDown);
  track.addEventListener('pointermove', onMove);
  track.addEventListener('pointerup', onUp);
  track.addEventListener('pointercancel', onUp);
  track.addEventListener('click', onClick);

  return {
    isDragging: () => dragging,
    destroy() {
      track.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
      track.removeEventListener('click', onClick);
    },
  };
}
