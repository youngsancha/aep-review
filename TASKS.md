<!-- td-handoff 가 관리하는 파일. task-dashboard 에서 넘어온 할 일 목록입니다.
     항목을 끝내면 체크박스를 채우거나 `td-task done "제목"` 으로 대시보드에도 알려주세요.
     새 항목은 아래에 append 됩니다 — 기존 내용은 지워지지 않습니다. -->

# 할 일 — task-dashboard 핸드오프

## 2026-08-04 21:39 넘어옴

- [x] **P2** resegment parity 테스트가 fixture 없으면 SKIP — CI/새 체크아웃에서 조용히 초록 — 고침 2026-08-25 (fixture 커밋 + 부재 시 fail)
  - 메모: data/transcripts/ 가 비면 tests/test_resegment_parity.py 가 skip 한다. 실제 트랜스크립트 8개를 넣자 즉시 trKey JS<->Python 불일치를 잡아냈다(v1.56.0). 작은 fixture를 리포에 커밋하거나, fixture 부재 시 skip 대신 fail 하게 바꿀 것.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:a2986f8e-1d87-4957-80a3-978b9b454c00 -->

## 2026-08-07 09:00 넘어옴

- [ ] **P2** KR 패널 겹침 마지막 1건(t=11, 재생 시작 직후 첫 문장)이 폰에서 실제로 재현되는지 확인 — 하네스 기하가 실기기와 달라 계측 아티팩트일 가능성
  - 2026-08-25 메모(사람 몫으로 남김): 위 `--kr-overlay` 되먹임을 고치자 이 지점의 기하가 바뀌었다. 고치기 전 t=11 은 sentH 156 / usable 167 → 문장이 들어가서 `aboveNotes=True`(통과)였고, 고친 뒤엔 sentH 156 / usable 143 → **문장이 가용 영역보다 커서** `aboveNotes=False` 다. 이건 겹침 버그가 아니라 "둘 다 만족 못 하면 문장의 시작을 보여준다"는 설계된 동작(`_fits()` 분기)이고 `kr_panel` 판정은 여전히 통과한다. 다만 **원래 신고를 만든 그 계측치는 패딩이 망가진 상태에서 잰 값**이었으므로, 폰에서 확인할 땐 이 커밋 이후 빌드로 다시 볼 것. 영상 모드에서 156px 문장에 usable 143px 는 실제로 빠듯하다.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:e2dc1619-b6aa-44f9-ab0a-b4e80984742e -->
- [ ] **P2** 기존 aep/allears 480여 회차의 _ko.json 이 60~70% 죽어 있음 — 과거 resegment 변경 누적으로 키가 어긋남(측정: ep100 243/413, ep400 347/478, ep520 272/393, v1.63.0 이전 기준). 온라인은 즉석 번역으로 가려지지만 오프라인에선 한국어가 아예 안 보임. 재번역 규모/비용 판단 필요
  - **전 회차 실측 완료 2026-08-26 00:49 PDT — Roy 결정용 숫자.** ⚠ 문제의 전제가 낡았다: "60~70% 사망" 은 v1.63.0 이전 값이고, 그 뒤 ko-quality 패스들이 대부분 메웠다. 지금 커버리지는 **전체 93.2%** (265,941 / 285,205 문장), 미번역 **19,264문장**.
  - **633편 중 535편이 100%.** 손댈 회차는 **90편**(95% 미만)이고 미번역의 99%가 그 안에 있다.
  - 생존율 분포 (aep / allears / wh):
    - 0–24% — 1 / 10 / 1 = 12편, 4,337문장
    - 25–49% — 0 / 29 / 0 = 29편, 7,074문장
    - 50–79% — 1 / 32 / 5 = 38편, 7,192문장
    - 80–94% — 3 / 7 / 1 = 11편, 542문장
    - 95–99% — 6 / 2 / 0 = 8편, 119문장
    - 100% — 263 / 215 / 57 = **535편**
  - **작업량은 사실상 allears 하나다: 95% 미만 90편 중 78편이 allears 이고 미번역 16,393문장(85%).** aep 는 5편 745문장, wh 는 7편 2,007문장뿐. 쇼별 커버리지 aep 99.3% · allears 86.9% · wh 95.5%.
  - 최악 회차: allears ep288(1.3%) ep537(2.5%) ep528(2.7%) ep304(4.0%) ep282(14.8%), aep ep1(14.6%), wh ep558(22.9%).
  - ⛔⛔ **첫 측정치는 믿지 마라 — 이 항목의 앞선 숫자(커버리지 88.1%, "_ko.json 이 아예 없는 회차 29편", 미번역 31,261)는 틀렸다.** `_download` 가 모든 예외를 삼켜서 **일시적 네트워크 실패를 '파일 없음'과 구분하지 못했다**. 45분 간격 두 번 실행이 **89편에 대해 서로 다른 답**을 냈고 방향이 양쪽 다였다(자막없음→정상 43편, 정상→자막없음 8편) — 워커 탓이 아니라 계측 탓. 재시도 3회 + 404 와 그 외 오류 구분 + 실패 건수 표시로 고쳤고, 위 수치는 **다운로드 실패 0편**인 실행에서 나온 것이다. 실제로 `_ko.json` 이 없는 회차는 **0편**이다.
  - 재측정: `python -m scripts.audit_ko_coverage --all -w 8` (633편에 약 2분). 출력 맨 아래 "다운로드 실패 N편" 줄을 **반드시** 확인할 것 — 0 이 아니면 그 수치는 불완전하다.
  - ⚠ 이 스냅샷도 `com.roy.aep-ko-quality` Phase A 가 쇼별 최근 50편을 백필하는 도중에 찍었다.
  - 상세 회차별 JSON 을 원하면 위 명령에 `--json <path>`.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:83a89e63-8091-4019-a91b-f0ef30b219bc -->

## 2026-08-10 09:00 넘어옴

- [x] **P2** _pwtest LIBRARY-VIDEO-LAYOUT 실패: 하네스에서 .tx-scroll 이 .tx-sheet-card 보다 918px 크게 잡힘(sc.bottom 1698 vs card.bottom 780). CSS 체인(92vh → flex:1 → flex:1)은 정상이고 실기기는 멀쩡함 — 하네스 페이지의 높이 컨텍스트(html/body height) 의심. 이 값이 KR 패널 기하 계산의 usable 을 비현실적으로 작게 만들어 다른 판정까지 왜곡함
  - **고침 2026-08-25 — 하네스 아티팩트가 아니라 앱 버그였다.** html/body 는 정확히 780px 로 멀쩡했고(가설 기각), 실제 원인은 `--kr-overlay` 가 1200px 까지 부풀어 `.tx-scroll` 의 padding-bottom 이 1310px 이 된 것. box-sizing:border-box 라 flex 아이템의 사용 높이는 패딩 합에서 바닥을 치므로(min-height:0 는 콘텐츠박스만 0 으로 줄일 뿐 패딩은 못 줄인다) 718px 카드 안에서 1328px 이 됐다. `syncNotesOverlayPad()` 가 gap 을 `scroll.getBoundingClientRect().bottom` 에서 쟀는데 그 bottom 이 바로 이 함수가 설정하는 패딩에 따라 움직인다 — 자기 출력이 자기 입력으로 되먹임. 실측으로 임계점 확인: 패딩(399)이 가용 높이(371)를 넘는 순간 scBottom 이 791 로 카드(780)를 벗어나고 그 초과분이 다음 계산에 그대로 더해진다. 기준 모서리를 패딩과 무관한 `.tx-sheet-card` 의 bottom 으로 바꾸고 카드 높이로 clamp. 스코프 없던 `document.querySelector('.tx-scroll')` 도 `$sheet` 로 한정. 결과: sc.bottom 780 = card.bottom, 초과 0px, `EP-SUBFAILED` 에서 libvideo 소멸.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:09b04df0-44b6-4ecc-b402-32a2d3b95a8b -->

## 2026-08-14 09:00 넘어옴

- [x] **P3** 완료된 aep-wh-ingest LaunchAgent 은퇴: launchctl bootout + plist 보관 (08-08 브리핑 64/64 인제스트 완료) — 완료 2026-08-25
  - 메모: agent-fleet INVENTORY.md F5
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:8881312d-d519-43ba-bbff-174c92cb1dbe -->

## 2026-08-15 09:00 넘어옴

- [ ] **P2** aep-review: _ko.json 고아 키 정리 — 회차당 최대 42퍼센트가 옛 문장분절의 죽은 키 (ep520 386문장에 고아 283개). 앱이 회차마다 통째로 내려받으므로 오프라인 핀/로딩에 불필요한 무게. 정리 스크립트는 워커가 파일을 쓰는 중엔 절대 돌리지 말 것
  - **측정 완료 2026-08-26 00:49 PDT (정리는 일부러 안 돌림 — `com.roy.aep-ko-quality` Phase A 가 파일을 쓰는 중이었다).** `scripts/audit_ko_coverage.py --all` 로 전 회차(633편, 다운로드 실패 0편) 실측: **고아 171,961 / 전체 키 430,923 = 39.9%**. 쇼별 aep 41.0% · allears 46.4% · wh 6.5%. "회차당 최대 42%" 가 아니라 **평균이 약 40%** 다. 가장 심한 회차: ep304(536/544=98.5%) ep288(348/354=98.3%) ep537(95.8%) ep528(95.1%) ep1(938/1005=93.3%).
  - ⛔ **기존 고아 계산식이 틀려 있었다(내 변경 전부터).** `orphan_keys = max(0, len(ko) - hit)` 인데 `hit` 은 문장을 **중복 포함**해서 센다 — "Right." 가 다섯 번 나오면 키 하나에 hit 5 다. 그래서 죽은 키가 남아 있어도 0 으로 바닥을 쳤다(실제 사례: ep1025 는 문장 554·적중 491·키 465 라 옛 식으로 고아 0). 집합 차집합으로 고쳤다. xcheck 패널의 gemini·grok 이 **각각 독립적으로** 잡았다.
  - ⛔ 자막이 없는 회차는 `_ko.json` 을 읽기도 전에 early-return 해서 그 키가 고아 합계에서 통째로 빠져 있었다(gemini 지적). 자막이 없으면 그 키는 **전부** 고아다 — 고쳤다.
  - 다음 단계(사람 판단): 정리는 워커가 멈춘 뒤에만. 지우기 전에 재번역 계획과 순서를 정할 것 — 고아 키를 지우면 되돌릴 수 없고, 아래 재번역 항목과 같은 파일을 건드린다.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:431eebb2-a1f5-4718-8ac5-99a35fa535fb -->

## 2026-08-24 09:00 넘어옴

- [x] **P3** aep-review scripts/release.py is broken for semver versions — 고침 2026-08-25 (semver 매치 + 두 상수 dry-run 검증)
  - 메모: release.py bumps both APP_VERSION and the service worker VERSION in one step, but its regex is window\.APP_VERSION = .(\\d+). — it assumes an integer version like 137. The project moved to semver (1.68.0), so the match fails and the script exits with "APP_VERSION 을 index.html 에서 못 찾음". Versions have to be bumped by hand meanwhile, which is exactly the drift the script exists to prevent: the two constants MUST stay equal or a deploy serves a new shell against an old service worker cache.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:b321d7b1-026c-4017-8d77-ae39fd75ad96 -->
