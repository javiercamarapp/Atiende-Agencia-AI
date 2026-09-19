-- Minimal Supabase-platform mock — MISMO contenido EXACTO que
-- scripts/verify-outbox-grants/bootstrap.sql (copiado, no reinventado): roles
-- anon/authenticated/service_role + auth.uid() -- ver ese archivo para el porqué
-- completo. Se agrega, al final, un schema `demo` propio de ESTE script (no toca
-- ningún schema de vertical real) con UNA tabla mínima que sirve solo para
-- demostrar el mecanismo de transacción de Postgres (COMMIT sobre una transacción
-- abortada devuelve ROLLBACK sin lanzar) que causó el hallazgo de auditoría a1b
-- #1/#2 -- ver assertions.sql para el "antes"/"después" real.
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

-- ---------------------------------------------------------------------------
-- Schema propio de este verify -- NUNCA una tabla real de negocio. Modela, a
-- nivel mínimo, "una unidad de un barrido (property/organización) que corrió
-- bien": una fila por unidad procesada, agrupada por `sesion` ('antes'/
-- 'despues') para poder comparar los 2 patrones en la MISMA base efímera.
create schema if not exists demo;

create table demo.unit_result (
  unit_id text not null,
  sesion text not null,
  creado_en timestamptz not null default now(),
  primary key (unit_id, sesion)
);
