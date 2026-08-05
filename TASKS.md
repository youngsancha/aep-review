<!-- td-handoff 가 관리하는 파일. task-dashboard 에서 넘어온 할 일 목록입니다.
     항목을 끝내면 체크박스를 채우거나 `td-task done "제목"` 으로 대시보드에도 알려주세요.
     새 항목은 아래에 append 됩니다 — 기존 내용은 지워지지 않습니다. -->

# 할 일 — task-dashboard 핸드오프

## 2026-08-04 21:39 넘어옴

- [ ] **P2** resegment parity 테스트가 fixture 없으면 SKIP — CI/새 체크아웃에서 조용히 초록
  - 메모: data/transcripts/ 가 비면 tests/test_resegment_parity.py 가 skip 한다. 실제 트랜스크립트 8개를 넣자 즉시 trKey JS<->Python 불일치를 잡아냈다(v1.56.0). 작은 fixture를 리포에 커밋하거나, fixture 부재 시 skip 대신 fail 하게 바꿀 것.
  - 대시보드: https://task-dashboard-three-mu.vercel.app/p/aep-review
  <!-- td:a2986f8e-1d87-4957-80a3-978b9b454c00 -->
