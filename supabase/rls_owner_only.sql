-- 소유자 전용 RLS 하드닝 (선택·강력) — 회원가입 끄기(대시보드)와 별개의 방어층.
--
-- 현재 정책: episodes/vocab_cards/srs_cards = "for all to authenticated using(true)".
-- 문제: anon 키+URL 은 클라이언트에 이미 공개돼 있어, 회원가입이 열려 있으면 누구나 계정을 만들어
--       authenticated 가 되면 전체 데이터를 읽고 쓸 수 있다(단일 사용자 앱인데).
--
-- 이 스크립트: 정책을 '소유자 이메일'에게만 허용하도록 조인다. 그러면 회원가입이 켜져 있어도
-- 다른 계정은 authenticated 여도 이 테이블에 접근 불가(0 행). 소유자(당신)는 그대로 전체 접근.
--
-- 실행: Supabase Dashboard → SQL Editor 에 붙여넣고 아래 OWNER_EMAIL 을 실제 로그인 이메일로 바꿔 Run.
-- (권장: 회원가입 끄기[Authentication → Sign In / Providers → Allow new users to sign up OFF] + 이 RLS 둘 다.)

-- ⚠️ 실제 로그인 Google 이메일로 교체:
--    (JWT 의 email 클레임과 비교. 대소문자 정확히.)
do $$
declare owner_email text := 'REPLACE_WITH_YOUR_LOGIN_EMAIL@example.com';
begin
  -- episodes
  execute 'drop policy if exists "authenticated all" on episodes';
  execute 'drop policy if exists "owner only" on episodes';
  execute format($f$create policy "owner only" on episodes
    for all to authenticated
    using (auth.jwt() ->> 'email' = %L) with check (auth.jwt() ->> 'email' = %L)$f$, owner_email, owner_email);

  -- vocab_cards
  execute 'drop policy if exists "authenticated all" on vocab_cards';
  execute 'drop policy if exists "owner only" on vocab_cards';
  execute format($f$create policy "owner only" on vocab_cards
    for all to authenticated
    using (auth.jwt() ->> 'email' = %L) with check (auth.jwt() ->> 'email' = %L)$f$, owner_email, owner_email);

  -- srs_cards
  execute 'drop policy if exists "authenticated all" on srs_cards';
  execute 'drop policy if exists "owner only" on srs_cards';
  execute format($f$create policy "owner only" on srs_cards
    for all to authenticated
    using (auth.jwt() ->> 'email' = %L) with check (auth.jwt() ->> 'email' = %L)$f$, owner_email, owner_email);
end $$;

-- 되돌리기(원래 authenticated-전체 허용으로): supabase/schema.sql 의 "authenticated all" 정책 블록 재실행.
-- 참고: service_role(인제스트 CI)은 RLS 를 우회하므로 이 변경과 무관하게 계속 쓰기 가능.
