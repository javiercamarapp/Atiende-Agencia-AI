-- Fixtures + assertions que verifican, contra Postgres REAL (NOT NULL/FK/RLS reales --
-- no el repositorio en memoria de domain-rentas, que nunca los aplica), que
-- packages/domain-rentas/src/sync/postgres-repository.ts::upsertEventoImportado hace
-- lo que dice hacer -- hallazgo de auditoría a3 (ALTA): el INSERT original omitía
-- organization_id/property_id (columnas NOT NULL sin default de
-- rentas.evento_canal_importado, supabase/migrations/20240101000057_
-- 008_ical_sync_schema.sql:56-75), así que TODO upsert con sobrescribirVersion=true
-- (el camino real de "aplicar"/"eco") disparaba 23502 contra Postgres real -- el
-- import iCal de rentas nunca funcionó contra la base real, solo contra el
-- repositorio en memoria de los tests (scripts/verify-rentas-cron-rls/assertions.sql
-- también lo enmascaraba insertando organization_id/property_id A MANO en su
-- escenario 12, en vez de derivarlos con el JOIN real -- ver el fix aparte en ese
-- archivo).
--
-- Cada escenario reproduce, LITERALMENTE (mismas columnas, mismo JOIN, mismo
-- ON CONFLICT), el SQL real de `upsertEventoImportado` -- nunca un INSERT
-- simplificado que ya traiga organization_id/property_id como si el caller los
-- conociera de antemano (esa era exactamente la simplificación que enmascaraba el
-- bug).
--
-- Qué demuestra:
--   1. (documental) La tabla real SÍ rechaza el INSERT viejo (sin organization_id/
--      property_id) con 23502 -- por eso hacía falta el fix, no una elección de
--      estilo.
--   2. Evento nuevo: el INSERT real (con el JOIN a rentas.unidad) SÍ persiste, con el
--      tenant derivado correctamente de la unidad.
--   3. Eco del mismo evento (mismo UID, dos upserts con sobrescribirVersion=true):
--      es idempotente -- sigue siendo UNA fila, con los valores del intento más
--      reciente.
--   4/5. Un evento "venenoso" (ocupacion_id que viola el FK real) en medio del feed
--      NUNCA persiste, y el evento sano que sigue en el MISMO feed SÍ se aplica --
--      reproduce, con una subtransacción PL/pgSQL (equivalente, a nivel de
--      recuperación de transacción, al SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE
--      SAVEPOINT real de motor.ts::procesarEventoDelCicloAislado), el aislamiento
--      por evento que el fix de motor.ts agrega.
--   6/7. Cross-tenant: un evento de la unidad de la Org A JAMÁS puede terminar con el
--      organization_id/property_id de la Org B, incluso si alguien pasara por error
--      el canal_id/uid de un feed ajeno -- el tenant sale SIEMPRE de la unidad, nunca
--      de un parámetro que un caller pudiera confundir.
--
-- Run vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI, ver
-- .github/workflows/postgres-real-gate.yml) o a mano con el mismo patrón que
-- scripts/verify-rentas-cron-rls/run.sh (initdb/pg_ctl efímero + este bootstrap/
-- post-migrations/assertions).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (ical-import)', 'org-a-ical-import'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (ical-import, ajena)', 'org-b-ical-import')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Property B1 (ajena)')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Unidad A1-1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Unidad B1-1 (ajena)', 1)
on conflict do nothing;

\echo ''
\echo '=== 1. (documental) el INSERT viejo -- sin organization_id/property_id -- SIGUE rechazado por la tabla real (por eso hacía falta derivarlos, no una preferencia de estilo) ==='
\echo ''

\echo '--- 1. INSERT sin organization_id/property_id (forma del bug original) debe fallar con 23502 (NOT NULL) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-forma-vieja@airbnb.com', 1, now(), 'hash-vieja', null, 'aplicar'
  from rentas.canal c where c.codigo = 'airbnb'
  returning id as should_fail;
rollback;

\echo ''
\echo '=== upsertEventoImportado -- SQL real del repositorio (con el JOIN a rentas.unidad) ==='
\echo ''

\echo '--- 2. evento nuevo: SI se importa y persiste con el tenant derivado de rentas.unidad (columna por columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-evento-nuevo@airbnb.com', 3, '2026-06-01T00:00:00Z'::timestamptz, 'hash-evento-1', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb'
  on conflict (unidad_id, canal_id, uid_evento) do update set
    sequence = excluded.sequence, dtstamp = excluded.dtstamp, hash_contenido = excluded.hash_contenido,
    ocupacion_id = excluded.ocupacion_id, ultima_accion = excluded.ultima_accion, updated_at = now();
select count(*) as tenant_correcto_deberia_ser_1 from rentas.evento_canal_importado
  where unidad_id = '00000000-0000-0000-0000-0000000000c1' and uid_evento = 'uid-evento-nuevo@airbnb.com'
    and organization_id = '00000000-0000-0000-0000-0000000000a1' and property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 3. eco del mismo evento (mismo UID, dos upserts con sobrescribirVersion=true): es idempotente -- sigue siendo UNA fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-eco@airbnb.com', 1, '2026-06-01T00:00:00Z'::timestamptz, 'hash-inicial', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb'
  on conflict (unidad_id, canal_id, uid_evento) do update set
    sequence = excluded.sequence, dtstamp = excluded.dtstamp, hash_contenido = excluded.hash_contenido,
    ocupacion_id = excluded.ocupacion_id, ultima_accion = excluded.ultima_accion, updated_at = now();
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-eco@airbnb.com', 5, '2026-06-02T00:00:00Z'::timestamptz, 'hash-recibido-de-nuevo', null, 'eco'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb'
  on conflict (unidad_id, canal_id, uid_evento) do update set
    sequence = excluded.sequence, dtstamp = excluded.dtstamp, hash_contenido = excluded.hash_contenido,
    ocupacion_id = excluded.ocupacion_id, ultima_accion = excluded.ultima_accion, updated_at = now();
select count(*) as una_sola_fila_con_el_ultimo_valor_deberia_ser_1 from rentas.evento_canal_importado
  where unidad_id = '00000000-0000-0000-0000-0000000000c1' and uid_evento = 'uid-eco@airbnb.com'
    and sequence = 5 and hash_contenido = 'hash-recibido-de-nuevo' and ultima_accion = 'eco';
rollback;

\echo ''
\echo '=== aislamiento por evento (equivalente al SAVEPOINT de motor.ts::procesarEventoDelCicloAislado) ==='
\echo ''

\echo '--- 4. un evento venenoso (ocupacion_id que viola el FK real) en medio del feed: el evento sano que sigue SI se aplica ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- Bloque PL/pgSQL con EXCEPTION -- abre su propia subtransacción implícita, mismo
-- efecto de recuperación de transacción que SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE
-- SAVEPOINT (motor.ts::procesarEventoDelCicloAislado, ver su comentario de cabecera).
do $do$
begin
  insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
    select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-venenoso@airbnb.com', 1, now(), 'hash-x', '00000000-0000-0000-0000-00000000dead', 'aplicar'
    from rentas.unidad u, rentas.canal c
    where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb';
exception when others then
  raise notice 'evento venenoso descartado (aislado), reproduce eventosDescartadosPorError: %', sqlerrm;
end $do$;
-- Evento sano en el MISMO feed/transacción -- debe aplicarse con normalidad.
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-sano@airbnb.com', 1, now(), 'hash-y', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb';
select count(*) as evento_sano_si_se_aplico_deberia_ser_1 from rentas.evento_canal_importado where uid_evento = 'uid-sano@airbnb.com';
rollback;

\echo '--- 5. el mismo escenario que 4: el evento venenoso JAMAS quedo persistido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $do$
begin
  insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
    select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-venenoso-2@airbnb.com', 1, now(), 'hash-x', '00000000-0000-0000-0000-00000000dead', 'aplicar'
    from rentas.unidad u, rentas.canal c
    where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb';
exception when others then
  raise notice 'evento venenoso descartado (aislado): %', sqlerrm;
end $do$;
select count(*) as venenoso_nunca_persistio_deberia_ser_0 from rentas.evento_canal_importado where uid_evento = 'uid-venenoso-2@airbnb.com';
rollback;

\echo ''
\echo '=== cross-tenant: un feed de la Org A jamas escribe filas con el tenant de la Org B ==='
\echo ''

\echo '--- 6. el evento de la unidad de la Org A queda con organization_id/property_id de la Org A, nunca de la Org B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-cross-tenant@airbnb.com', 1, now(), 'hash-z', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb';
select count(*) as filas_con_tenant_de_la_org_b_deberia_ser_0 from rentas.evento_canal_importado
  where uid_evento = 'uid-cross-tenant@airbnb.com'
    and (organization_id = '00000000-0000-0000-0000-0000000000a2' or property_id = '00000000-0000-0000-0000-0000000000b2');
rollback;

\echo '--- 7. la unidad de la Org B, en el mismo feed/canal/UID que la de la Org A, produce una fila INDEPENDIENTE con SU PROPIO tenant (nunca colisiona) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-mismo-namespace@airbnb.com', 1, now(), 'hash-org-a', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb';
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c2', c.id, 'uid-mismo-namespace@airbnb.com', 1, now(), 'hash-org-b', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c2' and c.codigo = 'airbnb';
select count(*) as dos_filas_independientes_con_su_propio_tenant_deberia_ser_1 from rentas.evento_canal_importado
  where uid_evento = 'uid-mismo-namespace@airbnb.com'
    and unidad_id = '00000000-0000-0000-0000-0000000000c2'
    and organization_id = '00000000-0000-0000-0000-0000000000a2' and property_id = '00000000-0000-0000-0000-0000000000b2';
rollback;

\echo ''
\echo '==> listo -- revisa arriba: el escenario 1 debe terminar en ERROR (documenta el NOT NULL real); los "deberia_ser_N" deben devolver exactamente N.'
