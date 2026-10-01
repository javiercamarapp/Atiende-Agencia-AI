-- Minimal Supabase-platform mock — reproduces ONLY the pieces of infrastructure
-- that the real Supabase platform provides outside of this repo's own migrations
-- (never committed as a real migration: `auth.uid()` ships with Supabase's `auth`
-- extension, and `grant usage on schema ... to authenticated` is applied by the
-- Supabase dashboard/CLI on link, not by a migration file — see the comment in
-- `.env.example` about `SUPABASE_SERVICE_ROLE_KEY` for the same kind of gap). A
-- vanilla local Postgres has neither. Runs BEFORE the real migrations (extensions/
-- roles/`auth.uid()` don't depend on any vertical schema existing yet) — the
-- schema-USAGE grant is a separate step (`post-migrations.sql`) because the
-- vertical schemas (`citas`/`hoteles`/…) don't exist until the migrations create
-- them.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant anon to current_user;
grant authenticated to current_user;
grant service_role to current_user;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to public;
grant execute on function auth.uid() to public;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
