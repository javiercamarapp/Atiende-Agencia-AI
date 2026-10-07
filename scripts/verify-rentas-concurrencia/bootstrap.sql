-- Minimal Supabase-platform mock — mismo archivo, literal, que usan el resto de
-- scripts/verify-*/ (ver scripts/verify-correo-inline-sesion-staff/bootstrap.sql
-- para el comentario de cabecera completo de por qué existe). Reproduce SOLO lo
-- que Supabase da fuera de las migraciones de este repo: extensiones, roles y
-- `auth.uid()`.
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
