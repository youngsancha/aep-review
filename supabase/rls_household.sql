-- Household access: the library is readable by an explicit list of Google accounts.
--
-- Why: rls_owner_only.sql limits every table to one owner email. RLS does not fail a read it forbids,
-- it returns zero rows, so a second account signs in fine and sees "0 episodes · all ready"
-- (reported 2026-11-08). This replaces the owner-only policy with a short allowlist.
--
-- The live tables are in schema `aep` on the shared project roy-hub (since v1.81.2).
-- Run in roy-hub's Supabase Dashboard -> SQL Editor. Check first:
--   select schemaname, tablename, policyname, roles, qual from pg_policies
--   where schemaname = 'aep' and tablename in ('episodes', 'vocab_cards', 'srs_cards');
--
-- Note: srs_cards has no user column, so every allowed account shares one review progress.
-- Separate progress needs option A in proposed_multiuser_rls.sql.
-- service_role (ingest) bypasses RLS and is unaffected.
do $$
declare
  t text;
begin
  foreach t in array array['episodes', 'vocab_cards', 'srs_cards'] loop
    if to_regclass('aep.' || t) is null then continue; end if;
    execute format('drop policy if exists "owner only" on aep.%I', t);
    execute format('drop policy if exists "authenticated all" on aep.%I', t);
    execute format('drop policy if exists "household" on aep.%I', t);
    execute format($f$create policy "household" on aep.%I
      for all to authenticated
      using (lower(auth.jwt() ->> 'email') in ('yscha.roy@gmail.com', 'yjcjswo@gmail.com'))
      with check (lower(auth.jwt() ->> 'email') in ('yscha.roy@gmail.com', 'yjcjswo@gmail.com'))$f$, t);
  end loop;
end $$;
