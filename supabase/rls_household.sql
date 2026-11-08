-- Household access: the library is readable by a short list of Google accounts (applied 2026-11-08).
--
-- Why: on roy-hub every aep.* table has one policy, "owner_all ... using ((select aep.is_owner()))",
-- and is_owner() compared the JWT email to the owner's address only. RLS does not fail a read it
-- forbids, it returns zero rows, so a second household account signed in fine and saw
-- "0 episodes · all ready" (reported 2026-11-08). Widening the one function fixes episodes,
-- vocab_cards and srs_cards together; the policies themselves stay as they are.
--
-- ⛔ This repo is PUBLIC: the real addresses are never committed. Replace both placeholders at run
-- time (roy-hub admin URL: ~/.config/roy-hub-admin/env). The live function carries a comment saying
-- when it was changed; read it with:  select pg_get_functiondef('aep.is_owner()'::regprocedure);
--
-- Note: srs_cards has no user column, so every allowed account shares one review progress.
-- Separate progress needs option A in proposed_multiuser_rls.sql.
-- service_role (ingest) bypasses RLS and is unaffected. cnpod.* has its own is_owner(), untouched.
create or replace function aep.is_owner()
  returns boolean language sql stable set search_path to ''
as $function$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in ('<OWNER_EMAIL>', '<PARTNER_EMAIL>')
$function$;

-- Check (expect the full count for both accounts, 0 for anyone else and for anon):
--   begin; set local role authenticated;
--   set local request.jwt.claims = '{"email":"<PARTNER_EMAIL>","role":"authenticated"}';
--   select count(*) from aep.episodes_list; rollback;
