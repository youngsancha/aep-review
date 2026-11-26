-- 2026-11-26: version key for the Korean pre-translation file ({id}_ko.json).
-- The app cached _ko.json under ?v=<transcribed_at> only, so a translation filled in later
-- (same transcript) never reached a phone that had already saved the episode offline.
-- translate_transcripts.save_existing stamps ko_at after every upload; the app appends it to ?v=.
-- NULL = never stamped: the URL stays exactly as before, so nothing is re-downloaded.
-- Rollback: create the view without ko_at, then `alter table aep.episodes drop column ko_at;`
alter table aep.episodes add column if not exists ko_at timestamptz;

create or replace view aep.episodes_list with (security_invoker = true) as
select
  e.id, e.show, e.guid, e.season, e.episode_no, e.title, e.pub_date, e.duration_sec, e.description,
  (e.audio_url is not null) as has_audio,
  e.transcribed_at, e.vocab_extracted_at, e.audio_url,
  (select count(*) from aep.vocab_cards v where v.episode_id = e.id) as vocab_count,
  e.ko_at
from aep.episodes e;
