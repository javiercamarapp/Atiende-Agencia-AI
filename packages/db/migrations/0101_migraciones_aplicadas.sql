-- 0101_migraciones_aplicadas.sql — Ola 4 (G4): ¿la base va por detrás del repo?
--
-- La base Supabase real va POR DETRÁS del código: mergear a main despliega el código, pero nadie aplica migraciones al
-- fusionar (docs/DEPLOY.md). Hasta hoy nada avisaba cuánto. Esta función devuelve las versiones registradas por la CLI
-- de Supabase (`supabase_migrations.schema_migrations.version`, una fila por migración aplicada con `db push`). El
-- detalle de GET /health (solo con el secreto interno) las expone y el smoke post-deploy las compara contra
-- `supabase/migrations/` del checkout para AVISAR cuáles faltan (scripts/smoke-post-deploy/smoke.ts).
--
-- Base sin el registro de la CLI (CI, Postgres local, una base aplicada a mano con psql): cero filas, sin error; el API lo
-- reporta como "sin_registro" (no como "al día").
--
-- Justificación de seguridad:
--   * security definer: `authenticated` no tiene (ni debe tener) USAGE sobre `supabase_migrations`; la función es la única
--     puerta y solo devuelve el número de versión (ni nombre ni sentencias).
--   * search_path fijo (`core, pg_temp`) y la tabla calificada con su esquema.
--   * Solo de SISTEMA: con `auth.uid()` no nulo (cualquier usuario real, aun superadmin) devuelve cero filas. En un repo
--     público, saber qué migraciones faltan en producción diría qué arreglos no están aplicados; por eso tampoco sale en
--     el /health público.
--   * REVOKE ALL a public y anon; GRANT EXECUTE solo a authenticated (las sesiones de sistema del API corren con ese rol y
--     `auth.uid()` nulo, igual que 0030).
-- Rollback: `drop function if exists core.migraciones_aplicadas();` (el API cae a "sin_medir").

create or replace function core.migraciones_aplicadas()
returns setof text
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    return;
  end if;
  if to_regclass('supabase_migrations.schema_migrations') is null then
    return;
  end if;
  return query execute 'select version::text from supabase_migrations.schema_migrations order by version';
end;
$$;

revoke all on function core.migraciones_aplicadas() from public;
revoke all on function core.migraciones_aplicadas() from anon;
grant execute on function core.migraciones_aplicadas() to authenticated;

comment on function core.migraciones_aplicadas() is
  'Versiones de migración aplicadas (registro de la CLI de Supabase). Solo sesión de sistema (auth.uid() nulo); cero filas para cualquier usuario o si no hay registro. Usada por el detalle de /health y el smoke post-deploy.';
