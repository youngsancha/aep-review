<!-- td-handoff 가 관리하는 파일. task-dashboard 에서 넘어온 할 일 목록입니다.
     항목을 끝내면 체크박스를 채우거나 `td-task done "제목"` 으로 대시보드에도 알려주세요.
     새 항목은 아래에 append 됩니다 — 기존 내용은 지워지지 않습니다. -->

# 할 일 — task-dashboard 핸드오프

## 2026-08-04 21:39 넘어옴

- [ ] **P2** resegment parity 테스트가 fixture 없으면 SKIP — CI/새 체크아웃에서 조용히 초록
  - 메모: data/transcripts/ 가 비면 tests/test_resegment_parity.py 가 skip 한다. 실제 트랜스크립트 8개를 넣자 즉시 trKey JS<->Python 불일치를 잡아냈다(v1.56.0). 작은 fixture를 리포에 커밋하거나, fixture 부재 시 skip 대신 fail 하게 바꿀 것.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:a2986f8e-1d87-4957-80a3-978b9b454c00 -->

## 2026-08-07 09:00 넘어옴

- [ ] **P2** KR 패널 겹침 마지막 1건(t=11, 재생 시작 직후 첫 문장)이 폰에서 실제로 재현되는지 확인 — 하네스 기하가 실기기와 달라 계측 아티팩트일 가능성
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:e2dc1619-b6aa-44f9-ab0a-b4e80984742e -->
- [ ] **P2** 기존 aep/allears 480여 회차의 _ko.json 이 60~70% 죽어 있음 — 과거 resegment 변경 누적으로 키가 어긋남(측정: ep100 243/413, ep400 347/478, ep520 272/393, v1.63.0 이전 기준). 온라인은 즉석 번역으로 가려지지만 오프라인에선 한국어가 아예 안 보임. 재번역 규모/비용 판단 필요
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:83a89e63-8091-4019-a91b-f0ef30b219bc -->

## 2026-08-10 09:00 넘어옴

- [ ] **P2** _pwtest LIBRARY-VIDEO-LAYOUT 실패: 하네스에서 .tx-scroll 이 .tx-sheet-card 보다 918px 크게 잡힘(sc.bottom 1698 vs card.bottom 780). CSS 체인(92vh → flex:1 → flex:1)은 정상이고 실기기는 멀쩡함 — 하네스 페이지의 높이 컨텍스트(html/body height) 의심. 이 값이 KR 패널 기하 계산의 usable 을 비현실적으로 작게 만들어 다른 판정까지 왜곡함
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:09b04df0-44b6-4ecc-b402-32a2d3b95a8b -->
