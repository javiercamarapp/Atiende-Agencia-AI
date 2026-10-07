-- Fixtures + assertions contra Postgres REAL (RLS + GRANT + definer + auth.uid() reales) para
-- packages/domain-licitaciones/migrations/039_licitaciones_autopiloto.sql (paridad3 L-P3-08/09/11).
--
-- Actores (todos "authenticated"): f1 = owner Org A, f4 = viewer Org A, f5 = analyst Org A, f2 = owner Org B (otro tenant).
-- Sesion de sistema = rol authenticated con sub vacio (auth.uid() null), como la sesion de la app.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = el escenario
-- DEBE terminar en ERROR; cualquier otro escenario debe completar sin error (los positivos y los
-- negativos con SQLSTATE exacto afirman con DO ... raise exception).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000000a1', 'licitaciones', 'Org A (autopiloto)', 'org-a-autop', 'active'),
  ('00000000-0000-0000-0000-0000000000a2', 'licitaciones', 'Org B (autopiloto, ajena)', 'org-b-autop', 'active'),
  ('00000000-0000-0000-0000-0000000000a3', 'despachos', 'Despacho (otra vertical)', 'despacho-autop', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner-a-autop@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner-b-autop@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000b4', 'viewer-a-autop@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000b5', 'analyst-a-autop@example.com', 'Analyst A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'analyst'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Convocatoria A1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Convocatoria A2'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a2', 'Convocatoria B1');

insert into licitaciones.proposal (id, organization_id, tender_id, title) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Propuesta A1');

\echo ''
\echo '=== licitaciones: autopiloto (039) ==='
\echo ''

\echo '--- 1. POSITIVO: primera version silenciosa (linea base): crea la version, NO notifica ni cascada; sin version previa la lectura devuelve 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table lectura0 as select * from licitaciones.system_latest_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1');
create temp table base1 as select * from licitaciones.system_record_ingested_tender_version(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64),
  '{"fields":{"title":"X"},"requirements":[]}'::jsonb, '{}'::jsonb, false, 'convocatoria_nueva', '{}', '{}', '{}', '[]'::jsonb);
create temp table lectura1 as select * from licitaciones.system_latest_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1');
reset role;
do $$ declare r record; n integer; begin
  select count(*) into n from lectura0;
  if n <> 0 then raise exception 'sin versiones debia devolver 0 filas, obtuve %', n; end if;
  select * into r from base1;
  if r.out_version <> 1 or not r.out_created or r.out_notification_id is not null then raise exception 'linea base mal: %', r; end if;
  select count(*) into n from licitaciones.tender_change_notification where tender_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 0 then raise exception 'la linea base no debia dejar notificacion'; end if;
  select count(*) into n from licitaciones.approval_change where proposal_id = '00000000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'la linea base no debia dejar cascada'; end if;
  select * into r from lectura1;
  if r.out_version <> 1 or r.out_hash <> repeat('a', 64) then raise exception 'lectura de la ultima version mal: %', r; end if;
end $$;
rollback;

\echo '--- 2. POSITIVO: un cambio real crea la version 2, invalida las aprobaciones vigentes del alcance, registra approval_change y la notificacion; devuelve a quien aprobo ---'
begin;
insert into licitaciones.tender_version (organization_id, tender_id, version, hash, snapshot, diff)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 1, repeat('a', 64), '{}'::jsonb, '{}'::jsonb);
insert into licitaciones.approval (id, organization_id, proposal_id, scope, scope_ref, status, approver_id, approver_role, inputs_hash) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'expediente', 'expediente', 'vigente', '00000000-0000-0000-0000-0000000000b1', 'owner', repeat('h', 64)),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'seccion', 'seccion:technical:legal', 'vigente', '00000000-0000-0000-0000-0000000000b5', 'analyst', repeat('h', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table cambio2 as select * from licitaciones.system_record_ingested_tender_version(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('b', 64),
  '{"fields":{"title":"Y"},"requirements":[]}'::jsonb, '{"hasChanges":true}'::jsonb, true, 'convocatoria_actualizada:v2',
  array['submissionDeadline'], array[]::text[], array['owner','analyst'],
  '[{"scope":"expediente","scopeRef":"expediente","reason":"tender_version_changed:v2:submissionDeadline"}]'::jsonb);
reset role;
do $$ declare r record; n integer; est text; begin
  select * into r from cambio2;
  if r.out_version <> 2 or not r.out_created or r.out_notification_id is null then raise exception 'cambio mal: %', r; end if;
  if cardinality(r.out_invalidated_approval_ids) <> 1 or r.out_invalidated_approver_ids <> array['00000000-0000-0000-0000-0000000000b1']::uuid[] then raise exception 'invalidacion del expediente mal: %', r; end if;
  select count(*) into n from licitaciones.approval_change where proposal_id = '00000000-0000-0000-0000-0000000000d1' and reason like 'tender_version_changed:v2%';
  if n <> 1 then raise exception 'debia haber 1 approval_change, hay %', n; end if;
  select count(*) into n from licitaciones.tender_change_notification where tender_id = '00000000-0000-0000-0000-0000000000c1' and tender_version = 2 and reason = 'convocatoria_actualizada:v2';
  if n <> 1 then raise exception 'debia haber 1 notificacion de cambio, hay %', n; end if;
  select status into est from licitaciones.approval where id = '00000000-0000-0000-0000-0000000000e1';
  if est <> 'invalidada' then raise exception 'la aprobacion del expediente debia invalidarse, esta %', est; end if;
  select status into est from licitaciones.approval where id = '00000000-0000-0000-0000-0000000000e2';
  if est <> 'vigente' then raise exception 'un cambio de alcance expediente no invalida la aprobacion de una seccion, esta %', est; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table cambio3 as select * from licitaciones.system_record_ingested_tender_version(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('c', 64),
  '{"fields":{"title":"Z"},"requirements":[]}'::jsonb, '{}'::jsonb, true, 'convocatoria_actualizada:v3',
  array['title'], array['legal'], array['owner'],
  '[{"scope":"seccion","scopeRef":"seccion:technical:legal","reason":"tender_version_changed:v3:requisitos_de_seccion:legal"}]'::jsonb);
reset role;
do $$ declare r record; est text; begin
  select * into r from cambio3;
  select status into est from licitaciones.approval where id = '00000000-0000-0000-0000-0000000000e2';
  if est <> 'invalidada' or r.out_invalidated_approver_ids <> array['00000000-0000-0000-0000-0000000000b5']::uuid[] then raise exception 'la cascada de seccion mal: % / %', est, r; end if;
end $$;
rollback;

\echo '--- 3. POSITIVO: idempotente: repetir el mismo hash no crea version, ni notificacion, ni cascada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table primera3 as select * from licitaciones.system_record_ingested_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, false, 'x', '{}', '{}', '{}', '[]'::jsonb);
create temp table repetida3 as select * from licitaciones.system_record_ingested_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, true, 'x', '{}', '{}', '{}', '[]'::jsonb);
reset role;
do $$ declare r record; n integer; begin
  select * into r from repetida3;
  if r.out_created or r.out_version <> 1 or r.out_notification_id is not null then raise exception 'reprocesar no debia crear nada: %', r; end if;
  select count(*) into n from licitaciones.tender_version where tender_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 1 then raise exception 'debia haber 1 sola version, hay %', n; end if;
  select count(*) into n from licitaciones.tender_change_notification where tender_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 0 then raise exception 'no debia haber notificaciones, hay %', n; end if;
end $$;
rollback;

\echo '--- 4. CROSS-TENANT: no se puede versionar ni leer una convocatoria de otra organizacion (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform licitaciones.system_record_ingested_tender_version('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, true, 'x', '{}', '{}', '{}', '[]'::jsonb);
  raise exception 'la convocatoria de A no debia versionarse como de B';
exception when sqlstate '42501' then null;
end $$;
do $$ declare n integer; begin
  select count(*) into n from licitaciones.system_latest_tender_version('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1');
  if n <> 0 then raise exception 'la lectura cruzada debia devolver 0 filas'; end if;
end $$;
rollback;

\echo '--- 5. NEGATIVO: un usuario real (sub) no puede ejecutar ninguna funcion de sistema (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
do $$ begin perform licitaciones.system_latest_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1'); raise exception 'latest sin guard';
exception when sqlstate '42501' then null; end $$;
do $$ begin perform licitaciones.system_record_ingested_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, true, 'x', '{}', '{}', '{}', '[]'::jsonb); raise exception 'record sin guard';
exception when sqlstate '42501' then null; end $$;
do $$ begin perform licitaciones.system_get_new_match_context('00000000-0000-0000-0000-0000000000a1'); raise exception 'context sin guard';
exception when sqlstate '42501' then null; end $$;
do $$ begin perform licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 80, true); raise exception 'new_match sin guard';
exception when sqlstate '42501' then null; end $$;
do $$ begin perform licitaciones.system_list_new_matches('00000000-0000-0000-0000-0000000000a1', now() - interval '7 days', 10); raise exception 'list sin guard';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '--- 6. ANON: ni las funciones de sistema ni las tablas nuevas ---'
begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.system_record_ingested_tender_version('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, true, 'x', '{}', '{}', '{}', '[]'::jsonb) as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.system_get_new_match_context('00000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.new_match_notice;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.expediente_auditoria;
rollback;

\echo '--- 7. POSITIVO: nuevo match: primera vez true, repetir false (dedupe), puntuacion acotada, lista ordenada por puntuacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare a boolean; b boolean; n integer; first_id uuid; sc integer; ttl text; begin
  a := licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 72, true);
  b := licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 99, true);
  if not a or b then raise exception 'dedupe mal: % %', a, b; end if;
  perform licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 150, false);
  select out_tender_id, out_score, out_title into first_id, sc, ttl from licitaciones.system_list_new_matches('00000000-0000-0000-0000-0000000000a1', now() - interval '1 day', 10) limit 1;
  if first_id <> '00000000-0000-0000-0000-0000000000c2' or sc <> 100 then raise exception 'orden o tope de puntuacion mal: % %', first_id, sc; end if;
  if ttl <> 'Convocatoria A2' then raise exception 'la lista debia traer el titulo de la convocatoria, trajo %', ttl; end if;
  select count(*) into n from licitaciones.system_list_new_matches('00000000-0000-0000-0000-0000000000a1', now() - interval '1 day', 10);
  if n <> 2 then raise exception 'debia listar 2, listo %', n; end if;
  select count(*) into n from licitaciones.system_list_new_matches('00000000-0000-0000-0000-0000000000a1', now() + interval '1 day', 10);
  if n <> 0 then raise exception 'con since futuro debia listar 0'; end if;
end $$;
rollback;

\echo '--- 8. CROSS-TENANT nuevo match: la convocatoria de otra organizacion se rechaza (42501); la lista de B no ve la de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare n integer; begin
  perform licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 80, true);
  begin
    perform licitaciones.system_record_new_match('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 80, true);
    raise exception 'sembrar un aviso en otro tenant debia rechazarse';
  exception when sqlstate '42501' then null;
  end;
  select count(*) into n from licitaciones.system_list_new_matches('00000000-0000-0000-0000-0000000000a2', now() - interval '1 day', 10);
  if n <> 0 then raise exception 'B no debia ver el aviso de A'; end if;
end $$;
rollback;

\echo '--- 9. POSITIVO: el contexto de matching trae umbral y perfil; sin perfil o en organizacion de otra vertical se comporta ---'
begin;
insert into licitaciones.tenant_config (organization_id, new_match_min_score) values ('00000000-0000-0000-0000-0000000000a1', 65);
insert into licitaciones.matching_profile (organization_id, keywords, states, budget_min) values ('00000000-0000-0000-0000-0000000000a1', array['software'], array['Jalisco'], 1000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare r record; n integer; begin
  select * into r from licitaciones.system_get_new_match_context('00000000-0000-0000-0000-0000000000a1');
  if r.out_min_score <> 65 or not r.out_has_profile or r.out_keywords <> array['software'] or r.out_states <> array['Jalisco'] or r.out_budget_min <> '1000' then raise exception 'contexto A mal: %', r; end if;
  select * into r from licitaciones.system_get_new_match_context('00000000-0000-0000-0000-0000000000a2');
  if r.out_min_score is not null or r.out_has_profile then raise exception 'contexto B debia ser vacio: %', r; end if;
  select count(*) into n from licitaciones.system_get_new_match_context('00000000-0000-0000-0000-0000000000a3');
  if n <> 0 then raise exception 'una organizacion de otra vertical no debia devolver contexto'; end if;
end $$;
rollback;

\echo '--- 10. RLS: cada organizacion lee solo sus avisos de nuevo match; la escritura directa esta denegada ---'
begin;
insert into licitaciones.new_match_notice (organization_id, tender_id, score, eligible) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 80, true),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c3', 70, false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.new_match_notice;
  if n <> 1 then raise exception 'viewer A debia ver solo 1 aviso, vio %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
do $$ declare n integer; m integer; begin
  select count(*) into n from licitaciones.new_match_notice;
  select count(*) into m from licitaciones.new_match_notice where organization_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 1 or m <> 0 then raise exception 'owner B debia ver solo el suyo, vio % (% de A)', n, m; end if;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
-- as should_fail (permission denied for table new_match_notice)
insert into licitaciones.new_match_notice (organization_id, tender_id, score, eligible) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 80, true) returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
-- as should_fail (permission denied for table new_match_notice)
delete from licitaciones.new_match_notice returning 1 as should_fail;
rollback;

\echo '--- 11. UMBRAL: owner escribe el umbral de su organizacion (0-100); viewer, otro tenant y valores fuera de rango no ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
do $$ declare v integer; begin
  insert into licitaciones.tenant_config (organization_id, new_match_min_score) values ('00000000-0000-0000-0000-0000000000a1', 70);
  update licitaciones.tenant_config set new_match_min_score = 55, updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000000a1';
  select new_match_min_score into v from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000a1';
  if v <> 55 then raise exception 'el umbral debia quedar en 55, quedo %', v; end if;
  begin
    update licitaciones.tenant_config set new_match_min_score = 101 where organization_id = '00000000-0000-0000-0000-0000000000a1';
    raise exception '101 debia violar el CHECK';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;

begin;
insert into licitaciones.tenant_config (organization_id, new_match_min_score) values ('00000000-0000-0000-0000-0000000000a1', 70);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b4', true);
-- el viewer no puede editar el umbral: la policy filtra la fila (0 filas actualizadas)
with u as (update licitaciones.tenant_config set new_match_min_score = 0 where organization_id = '00000000-0000-0000-0000-0000000000a1' returning 1)
select count(*) as umbral_viewer_deberia_ser_0 from u;
rollback;

begin;
insert into licitaciones.tenant_config (organization_id, new_match_min_score) values ('00000000-0000-0000-0000-0000000000a1', 70);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
with u as (update licitaciones.tenant_config set new_match_min_score = 0 where organization_id = '00000000-0000-0000-0000-0000000000a1' returning 1)
select count(*) as umbral_ajeno_deberia_ser_0 from u;
rollback;

begin;
insert into licitaciones.tenant_config (organization_id, new_match_min_score) values ('00000000-0000-0000-0000-0000000000a1', 70);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
-- as should_fail (permission denied: la columna organization_id no es actualizable)
update licitaciones.tenant_config set organization_id = '00000000-0000-0000-0000-0000000000a2' where organization_id = '00000000-0000-0000-0000-0000000000a1' returning 1 as should_fail;
rollback;

\echo '--- 12. AUDITORIA DEL EXPEDIENTE: el staff de escritura registra y actualiza; viewer y otro tenant no; el sistema no escribe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b5', true);
do $$ declare e text; n integer; begin
  insert into licitaciones.expediente_auditoria (proposal_id, organization_id, tender_id, estado, bloqueos, inputs_hash)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'con_bloqueos', 3, repeat('h', 64));
  update licitaciones.expediente_auditoria set estado = 'sin_bloqueos', bloqueos = 0, revisado_en = now() where proposal_id = '00000000-0000-0000-0000-0000000000d1';
  select estado into e from licitaciones.expediente_auditoria where proposal_id = '00000000-0000-0000-0000-0000000000d1';
  if e <> 'sin_bloqueos' then raise exception 'el analyst debia poder actualizar el estado, quedo %', e; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.expediente_auditoria;
  if n <> 0 then raise exception 'owner B no debia ver la auditoria de A, vio %', n; end if;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b4', true);
-- as should_fail (new row violates row-level security policy: el viewer no escribe)
insert into licitaciones.expediente_auditoria (proposal_id, organization_id, tender_id, estado, bloqueos, inputs_hash)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'sin_bloqueos', 0, repeat('h', 64)) returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
-- as should_fail (new row violates row-level security policy: otro tenant no escribe en A)
insert into licitaciones.expediente_auditoria (proposal_id, organization_id, tender_id, estado, bloqueos, inputs_hash)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'sin_bloqueos', 0, repeat('h', 64)) returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b5', true);
-- as should_fail (permission denied for table: no se puede borrar)
delete from licitaciones.expediente_auditoria returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b5', true);
-- as should_fail (check constraint: estado desconocido)
insert into licitaciones.expediente_auditoria (proposal_id, organization_id, tender_id, estado, bloqueos, inputs_hash)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'aprobado', 0, repeat('h', 64)) returning 1 as should_fail;
rollback;
