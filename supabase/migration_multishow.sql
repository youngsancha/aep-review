-- 멀티-쇼 마이그레이션: 단일쇼(aep) → 두 영어 팟캐스트(aep + allears).
-- Supabase SQL Editor 에서 1회 실행. 라이브 aep 데이터(264 episodes / 1905 vocab / 1905 srs)를
-- 보존하며 show 차원을 추가한다. 기존 행은 전부 show='aep' 로 백필됨(컬럼 default + 명시 update).
-- 멱등(여러 번 실행해도 안전). 이 마이그레이션 적용 후 ui/config.js 의 MULTISHOW 를 true 로.
--
-- 설계: episode id 는 두 쇼가 공유하는 단일 시퀀스(전역 유일)라 R2 키·transcript 경로는 불변.
-- 쇼 구분은 episodes.show 한 컬럼 + (show, guid) 복합 유일. vocab/srs 는 show 비정규화(카운트/필터용).

-- ── 1) episodes: show 컬럼 + (show, guid) 유일 + 인덱스 ──
alter table episodes add column if not exists show text not null default 'aep';

-- 기존 단일 guid unique 제거 → (show, guid) 복합 유일(두 피드가 독립적으로 dedupe).
alter table episodes drop constraint if exists episodes_guid_key;
create unique index if not exists episodes_show_guid_key on episodes(show, guid);
create index if not exists idx_episodes_show_pub on episodes(show, pub_date desc);

-- ── 2) vocab_cards / srs_cards: show 비정규화(episode.show 상속) ──
alter table vocab_cards add column if not exists show text not null default 'aep';
alter table srs_cards   add column if not exists show text not null default 'aep';

-- 기존 행 백필(이미 default 'aep' 지만, 향후 재실행/혼합 데이터 대비 명시 동기화 — 멱등).
update vocab_cards v set show = e.show
  from episodes e where v.episode_id = e.id and v.show is distinct from e.show;
update srs_cards s set show = e.show
  from episodes e where s.episode_id = e.id and s.show is distinct from e.show;

create index if not exists idx_vocab_show on vocab_cards(show, kind);
create index if not exists idx_srs_show_due on srs_cards(show, due_date);

-- ── 3) episodes_list 뷰에 show 노출(프론트 .eq('show', …) 필터용) ──
-- ⚠️ CREATE OR REPLACE VIEW 는 컬럼 "끝에 추가"만 허용(순서 변경·중간 삽입 금지) → 기존 뷰의
--    2번째 컬럼 guid 자리에 show 를 넣으면 "rename column" 으로 거부된다(ERROR 42P16).
--    그래서 DROP 후 CREATE 한다. 단, DROP 하면 grant 도 사라지므로 끝에서 다시 부여한다.
drop view if exists episodes_list;
create view episodes_list with (security_invoker = true) as
select
  e.id, e.show, e.guid, e.season, e.episode_no, e.title, e.pub_date, e.duration_sec, e.description,
  (e.audio_url is not null) as has_audio,
  e.transcribed_at, e.vocab_extracted_at, e.audio_url,
  (select count(*) from vocab_cards v where v.episode_id = e.id) as vocab_count
from episodes e;
grant select on episodes_list to authenticated;

-- 검증(실행 후 확인용):
--   select show, count(*) from episodes group by show;          -- aep=264, (allears 인제스트 후 증가)
--   select show, count(*) from vocab_cards group by show;       -- aep=1905
--   select show, count(*) from srs_cards  group by show;        -- aep=1905
