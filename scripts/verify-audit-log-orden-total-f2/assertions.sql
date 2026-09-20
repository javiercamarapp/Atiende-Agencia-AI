-- f2-orden-total-bitacoras -- verifica, contra Postgres REAL, que el desempate por
-- `seq` (columna agregada en las migraciones 011/despachos, 028/hoteles y
-- 026/licitaciones) da un orden TOTAL determinista para las 3 bitácoras de esta
-- fase, exactamente igual que ya demuestra scripts/verify-rentas-bitacora-
-- auditoria/assertions.sql (escenarios 17/18) para rentas.audit_log (PR #173).
--
-- Premisa que este archivo confirma primero (ver también el comentario de cabecera
-- de cada migración 011/026/028): `now()` (created_at) es CONSTANTE dentro de una
-- transacción de Postgres -- varias filas de bitácora insertadas en la MISMA
-- transacción comparten `created_at`, y sin el desempate por `seq` el orden entre
-- esas filas (y la estabilidad de la paginación por offset sobre ese empate)
-- depende del orden físico en el heap, no del orden real de escritura.
--
-- Este archivo NO repite la cobertura de RLS/GRANT de escritura de cada tabla (eso
-- ya lo cubre, para despachos/hoteles, el hecho de que sus funciones `record_*`
-- exigen `security definer` + `auth.uid() is null` desde las migraciones de
-- caller-binding fase 3, sin cambios en esta fase) -- las fixtures de abajo se
-- insertan directo como el superusuario que corre este script (mismo criterio que
-- scripts/verify-rentas-bitacora-auditoria/assertions.sql para su fixture inicial),
-- salvo donde se ejercita explícitamente la función `security definer` real
-- (despachos/hoteles).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- salvo las fixtures de organización/property/tender de abajo.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f1', 'despachos', 'Org F2 (despachos)', 'org-f2-despachos-orden-total'),
  ('00000000-0000-0000-0000-0000000000f2', 'hoteles', 'Org F2 (hoteles)', 'org-f2-hoteles-orden-total'),
  ('00000000-0000-0000-0000-0000000000f3', 'licitaciones', 'Org F2 (licitaciones)', 'org-f2-licitaciones-orden-total')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000f2', 'Property F2 (hoteles)')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000021', 'staff-f2@example.com', 'Staff F2', 'seed')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title) values
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f3', 'Convocatoria F2 orden total')
on conflict do nothing;

\echo ''
\echo '=== despachos.audit_log — orden total (migración 011) ==='
\echo ''

\echo '--- 1. 5 filas de la MISMA transaccion via despachos.record_audit_log() (sesion de sistema, auth.uid() null) -- mismo created_at, orden exacto por seq desc ---'
begin;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'test.orden.1', '{}'::jsonb) as id_1;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'test.orden.2', '{}'::jsonb) as id_2;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'test.orden.3', '{}'::jsonb) as id_3;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'test.orden.4', '{}'::jsonb) as id_4;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'test.orden.5', '{}'::jsonb) as id_5;
select (count(distinct created_at) = 1)::int as despachos_un_solo_created_at_deberia_ser_1
from despachos.audit_log where organization_id = '00000000-0000-0000-0000-0000000000f1' and action like 'test.orden.%';
select (array_agg(action order by created_at desc, seq desc) = array['test.orden.5','test.orden.4','test.orden.3','test.orden.2','test.orden.1'])::int as despachos_orden_total_exacto_deberia_ser_1
from despachos.audit_log where organization_id = '00000000-0000-0000-0000-0000000000f1' and action like 'test.orden.%';
rollback;

\echo '--- 2. paginacion por offset ESTABLE sobre el mismo empate: 6 filas de la MISMA transaccion, 2 paginas de 3 -- la union es EXACTA, sin repetir ni perder ninguna fila ---'
begin;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.1', '{}'::jsonb) as id_1;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.2', '{}'::jsonb) as id_2;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.3', '{}'::jsonb) as id_3;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.4', '{}'::jsonb) as id_4;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.5', '{}'::jsonb) as id_5;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000021', 'pag.6', '{}'::jsonb) as id_6;
with pagina_1 as (
  select action from despachos.audit_log where organization_id = '00000000-0000-0000-0000-0000000000f1' and action like 'pag.%' order by created_at desc, seq desc limit 3 offset 0
), pagina_2 as (
  select action from despachos.audit_log where organization_id = '00000000-0000-0000-0000-0000000000f1' and action like 'pag.%' order by created_at desc, seq desc limit 3 offset 3
)
select ((select array_agg(action) from pagina_1) || (select array_agg(action) from pagina_2) = array['pag.6','pag.5','pag.4','pag.3','pag.2','pag.1'])::int as despachos_paginacion_sin_repetir_ni_perder_deberia_ser_1;
rollback;

\echo ''
\echo '=== hoteles.fraude_audit_log — orden total (migración 028) ==='
\echo ''

\echo '--- 3. 5 filas de la MISMA transaccion via hoteles.record_fraude_audit_log() (sesion de sistema) -- mismo created_at, orden exacto por seq desc ---'
begin;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'test.orden.1', '{}'::jsonb) as id_1;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'test.orden.2', '{}'::jsonb) as id_2;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'test.orden.3', '{}'::jsonb) as id_3;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'test.orden.4', '{}'::jsonb) as id_4;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'test.orden.5', '{}'::jsonb) as id_5;
select (count(distinct created_at) = 1)::int as hoteles_un_solo_created_at_deberia_ser_1
from hoteles.fraude_audit_log where property_id = '00000000-0000-0000-0000-0000000000f4' and action like 'test.orden.%';
select (array_agg(action order by created_at desc, seq desc) = array['test.orden.5','test.orden.4','test.orden.3','test.orden.2','test.orden.1'])::int as hoteles_orden_total_exacto_deberia_ser_1
from hoteles.fraude_audit_log where property_id = '00000000-0000-0000-0000-0000000000f4' and action like 'test.orden.%';
rollback;

\echo '--- 4. paginacion por offset ESTABLE sobre el mismo empate: 6 filas de la MISMA transaccion, 2 paginas de 3 ---'
begin;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.1', '{}'::jsonb) as id_1;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.2', '{}'::jsonb) as id_2;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.3', '{}'::jsonb) as id_3;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.4', '{}'::jsonb) as id_4;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.5', '{}'::jsonb) as id_5;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-000000000021', 'pag.6', '{}'::jsonb) as id_6;
with pagina_1 as (
  select action from hoteles.fraude_audit_log where property_id = '00000000-0000-0000-0000-0000000000f4' and action like 'pag.%' order by created_at desc, seq desc limit 3 offset 0
), pagina_2 as (
  select action from hoteles.fraude_audit_log where property_id = '00000000-0000-0000-0000-0000000000f4' and action like 'pag.%' order by created_at desc, seq desc limit 3 offset 3
)
select ((select array_agg(action) from pagina_1) || (select array_agg(action) from pagina_2) = array['pag.6','pag.5','pag.4','pag.3','pag.2','pag.1'])::int as hoteles_paginacion_sin_repetir_ni_perder_deberia_ser_1;
rollback;

\echo ''
\echo '=== licitaciones.tender_audit_log — orden total (migración 026) ==='
\echo ''

\echo '--- 5. 5 filas de la MISMA transaccion via INSERT directo (mismo patron que upsertTenderManual/recordTenderVersion reales) -- mismo created_at, orden exacto por seq desc ---'
begin;
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000e1');
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000e2');
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000e3');
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000e4');
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.created', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000e5');
select (count(distinct created_at) = 1)::int as licitaciones_un_solo_created_at_deberia_ser_1
from licitaciones.tender_audit_log where tender_id = '00000000-0000-0000-0000-0000000000f5' and id in ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000e5');
select (array_agg(id order by created_at desc, seq desc) = array['00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e1']::uuid[])::int as licitaciones_orden_total_exacto_deberia_ser_1
from licitaciones.tender_audit_log where tender_id = '00000000-0000-0000-0000-0000000000f5' and id in ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000e5');
rollback;

\echo '--- 6. paginacion por offset ESTABLE sobre el mismo empate: 6 filas de la MISMA transaccion, 2 paginas de 3 ---'
begin;
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id, id) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c5'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 'tender.manual_upsert.updated', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000c6');
with pagina_1 as (
  select id from licitaciones.tender_audit_log where tender_id = '00000000-0000-0000-0000-0000000000f5' and id in ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000000c6') order by created_at desc, seq desc limit 3 offset 0
), pagina_2 as (
  select id from licitaciones.tender_audit_log where tender_id = '00000000-0000-0000-0000-0000000000f5' and id in ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000000c6') order by created_at desc, seq desc limit 3 offset 3
)
select ((select array_agg(id) from pagina_1) || (select array_agg(id) from pagina_2) = array['00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c1']::uuid[])::int as licitaciones_paginacion_sin_repetir_ni_perder_deberia_ser_1;
rollback;

-- NOTA -- esquema intermedio ("008/017/007 aplicada, 011/028/026 no", `seq` no
-- existe todavía): este runner (`run-gate.mjs`) SIEMPRE aplica TODAS las
-- migraciones de `supabase/migrations/` en orden, sin forma de saltarse una a
-- propósito (mismo comentario que ya documentan las migraciones de rentas/
-- despachos/hoteles/licitaciones de esta serie) -- ese caso no puede reproducirse
-- AQUÍ contra Postgres real. Esa cobertura vive en los `AbortAwareFakeSession` de
-- packages/domain-despachos/tests/audit-log-orden-total.spec.ts,
-- packages/domain-hoteles/tests/fraude-audit-log-orden-total.spec.ts y
-- packages/domain-licitaciones/tests/tender-audit-log-orden-total.spec.ts.
