-- Fixtures + assertions contra Postgres REAL (RLS + GRANT por columna + triggers + funciones definer + auth.uid()
-- reales) para packages/domain-licitaciones/migrations/035_licitaciones_garantias_hitos_convenios.sql
-- (L-27: garantias, hitos, convenios modificatorios, plazos y bitacora de post-adjudicacion).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   c1 = owner Org A   c3 = writer Org A   c4 = viewer Org A   c5 = analyst Org A
--   c2 = owner Org B (otro tenant de licitaciones)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = el escenario DEBE
-- terminar en ERROR; los demas deben completar sin error (los negativos con SQLSTATE exacto afirman con
-- DO ... raise exception); `deberia_ser_N` = el valor del alias debe ser N. Cada escenario corre en su propio
-- `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (post-adjudicacion)', 'org-a-postadj'),
  ('00000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (post-adjudicacion, ajena)', 'org-b-postadj')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-postadj@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-postadj@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'writer-a-postadj@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-postadj@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'analyst-a-postadj@example.com', 'Analyst A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000d1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title, submission_deadline) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'Convocatoria A', now() + interval '20 days'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2', 'Convocatoria B (ajena)', now() + interval '20 days')
on conflict do nothing;

-- Un contrato por organizacion (como superusuario: la fila nace por otra pieza, `contract`).
insert into licitaciones.contract (id, organization_id, tender_id, status, end_date, created_by) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'en_ejecucion', current_date + 200, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e2', 'en_ejecucion', current_date + 200, '00000000-0000-0000-0000-0000000000c2');

-- Garantias e hitos ya registrados (como superusuario) para los escenarios de lectura y de alertas.
--   G1 (A) pendiente con limite vencido  -> alerta garantia_no_entregada
--   G2 (A) entregada, vigencia en 10 dias -> alerta garantia_por_vencer
--   G3 (A) entregada, vigencia en 90 dias -> sin alerta
--   G4 (B) entregada, vigencia en 5 dias  -> alerta SOLO de Org B
insert into licitaciones.contract_guarantee (id, organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, fecha_limite_entrega, entregada_en, estado) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'cumplimiento', 1500000, current_date, current_date + 365, current_date - 3, null, 'pendiente_entrega'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 2500000, current_date - 100, current_date + 10, null, current_date - 50, 'entregada'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'vicios_ocultos', 800000, current_date - 20, current_date + 90, null, current_date - 15, 'entregada'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', 'cumplimiento', 900000, current_date - 20, current_date + 5, null, current_date - 15, 'entregada');

insert into licitaciones.contract_milestone (id, organization_id, contract_id, titulo, responsable_id, fecha_compromiso, created_by) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Entrega de la primera etapa', '00000000-0000-0000-0000-0000000000c3', current_date - 2, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Entrega final', '00000000-0000-0000-0000-0000000000c3', current_date + 60, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', 'Hito de Org B', '00000000-0000-0000-0000-0000000000c2', current_date - 1, '00000000-0000-0000-0000-0000000000c2');

\echo ''
\echo '=== licitaciones: post-adjudicacion (035) ==='
\echo ''

\echo '--- 1. POSITIVO: cualquier miembro (viewer) ve SOLO las garantias, hitos y bitacora de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.contract_guarantee;
  if n <> 3 then raise exception 'el viewer de Org A debia ver 3 garantias, vio %', n; end if;
  select count(*) into n from licitaciones.contract_guarantee where organization_id = '00000000-0000-0000-0000-0000000000d2';
  if n <> 0 then raise exception 'el viewer de Org A veia garantias de Org B'; end if;
  select count(*) into n from licitaciones.contract_milestone;
  if n <> 2 then raise exception 'el viewer de Org A debia ver 2 hitos, vio %', n; end if;
  select count(*) into n from licitaciones.contract_post_award_log;
  if n < 5 then raise exception 'la bitacora de Org A debia tener al menos 5 entradas (3 garantias + 2 hitos), hay %', n; end if;
  select count(*) into n from licitaciones.contract_post_award_log where organization_id = '00000000-0000-0000-0000-0000000000d2';
  if n <> 0 then raise exception 'el viewer de Org A veia la bitacora de Org B'; end if;
end $$;
rollback;

\echo '--- 2. CROSS-TENANT: el owner de Org B no ve nada de Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.contract_guarantee;
  if n <> 1 then raise exception 'el owner de Org B debia ver 1 garantia, vio %', n; end if;
  select count(*) into n from licitaciones.contract_milestone where organization_id = '00000000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'Org B veia hitos de Org A'; end if;
  select count(*) into n from licitaciones.contract_post_award_log where organization_id = '00000000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'Org B veia la bitacora de Org A'; end if;
end $$;
rollback;

\echo '--- 3. CROSS-TENANT: Org B no puede crear garantias en el contrato de Org A (ni con organization_id mentido ni con el suyo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  -- organization_id de Org A: la RLS (can_write_org) lo niega.
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c2');
  raise exception 'Org B no debia crear una garantia a nombre de Org A';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  -- organization_id propio pero contrato ajeno: la llave foranea compuesta (contract_id, organization_id) lo niega.
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c2');
  raise exception 'Org B no debia colgar una garantia del contrato de Org A';
exception when sqlstate '23503' then null;
end $$;
rollback;

\echo '--- 4. POSITIVO: el writer crea una garantia (created_by = auth.uid()) y la bitacora lo registra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, porcentaje_bp, afianzadora, numero_poliza, vigencia_desde, vigencia_hasta, fecha_limite_entrega, notas, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'cumplimiento', 12500000, 1000, 'Afianzadora Demo SA', 'POL-001', current_date, current_date + 365, current_date + 10, 'Fianza de cumplimiento', '00000000-0000-0000-0000-0000000000c3');
do $$ declare n integer; begin
  select count(*) into n from licitaciones.contract_guarantee where tipo = 'cumplimiento' and numero_poliza = 'POL-001';
  if n <> 1 then raise exception 'la garantia nueva no aparece'; end if;
  select count(*) into n from licitaciones.contract_post_award_log l where l.entidad = 'garantia' and l.accion = 'crear' and l.actor_id = '00000000-0000-0000-0000-0000000000c3' and l.detalle->>'estado' = 'pendiente_entrega';
  if n <> 1 then raise exception 'la bitacora debia registrar la creacion con el actor, hay %', n; end if;
end $$;
rollback;

\echo '--- 5. NEGATIVO: el viewer no crea garantias, y created_by no se falsifica ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c4');
  raise exception 'el viewer no debia crear garantias';
exception when sqlstate '42501' then null;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c1');
  raise exception 'el writer no debia firmar una garantia a nombre del owner';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 6. MAQUINA DE ESTADOS: el writer marca entregada; solo un rol de decision libera; una garantia final ya no se edita ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
update licitaciones.contract_guarantee set estado = 'entregada', entregada_en = current_date where id = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  update licitaciones.contract_guarantee set estado = 'liberada' where id = '00000000-0000-0000-0000-0000000000b1';
  raise exception 'el writer no debia poder liberar una garantia';
exception when sqlstate '42501' then null;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
update licitaciones.contract_guarantee set estado = 'liberada' where id = '00000000-0000-0000-0000-0000000000b1';
do $$ declare n integer; begin
  select count(*) into n from licitaciones.contract_post_award_log l where l.entidad_id = '00000000-0000-0000-0000-0000000000b1' and l.accion = 'cambio_estado' and l.detalle->>'estado' = 'liberada' and l.detalle->>'estado_anterior' = 'entregada';
  if n <> 1 then raise exception 'la bitacora debia registrar entregada -> liberada, hay %', n; end if;
end $$;
do $$ begin
  update licitaciones.contract_guarantee set notas = 'editada tras liberar' where id = '00000000-0000-0000-0000-0000000000b1';
  raise exception 'una garantia liberada no debia editarse';
exception when sqlstate '22023' then null;
end $$;
rollback;

\echo '--- 7. MAQUINA DE ESTADOS: transiciones invalidas se rechazan (pendiente -> liberada, entregada -> pendiente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ begin
  update licitaciones.contract_guarantee set estado = 'liberada', entregada_en = current_date where id = '00000000-0000-0000-0000-0000000000b1';
  raise exception 'pendiente_entrega -> liberada no debia permitirse';
exception when sqlstate '22023' then null;
end $$;
do $$ begin
  update licitaciones.contract_guarantee set estado = 'pendiente_entrega', entregada_en = null where id = '00000000-0000-0000-0000-0000000000b2';
  raise exception 'entregada -> pendiente_entrega no debia permitirse';
exception when sqlstate '22023' then null;
end $$;
rollback;

\echo '--- 8. GRANT por columna: tipo, contrato, organizacion, id y created_by no se cambian; no hay DELETE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: tipo no tiene GRANT de UPDATE)
update licitaciones.contract_guarantee set tipo = 'anticipo' where id = '00000000-0000-0000-0000-0000000000b1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: contract_id no tiene GRANT de UPDATE)
update licitaciones.contract_guarantee set contract_id = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000000b1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: sin DELETE; el historial de garantias no se borra)
delete from licitaciones.contract_guarantee where id = '00000000-0000-0000-0000-0000000000b1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: id no es columna insertable)
insert into licitaciones.contract_guarantee (id, organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c1') returning 1 as should_fail;
rollback;

\echo '--- 9. CHECK: monto > 0, vigencia coherente y entregada con fecha ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 0, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'un monto cero no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date + 5, current_date, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'una vigencia invertida no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, estado, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, 'entregada', '00000000-0000-0000-0000-0000000000c3');
  raise exception 'una garantia entregada sin fecha de entrega no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, estado, entregada_en, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100, current_date, current_date + 1, 'liberada', current_date, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'una garantia no nace liberada';
exception when sqlstate '22023' then null;
end $$;
rollback;

\echo '--- 10. HITOS: el responsable debe ser staff de la MISMA organizacion; sin responsable no se crea ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.contract_milestone (organization_id, contract_id, titulo, responsable_id, fecha_compromiso, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Capacitacion al personal', '00000000-0000-0000-0000-0000000000c5', current_date + 30, '00000000-0000-0000-0000-0000000000c3');
do $$ begin
  insert into licitaciones.contract_milestone (organization_id, contract_id, titulo, responsable_id, fecha_compromiso, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Responsable ajeno', '00000000-0000-0000-0000-0000000000c2', current_date + 30, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'el responsable de otra organizacion no debia aceptarse';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_milestone (organization_id, contract_id, titulo, responsable_id, fecha_compromiso, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Sin responsable', null, current_date + 30, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'un hito sin responsable no debia aceptarse';
exception when sqlstate '42501' then null;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ begin
  insert into licitaciones.contract_milestone (organization_id, contract_id, titulo, responsable_id, fecha_compromiso, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'El viewer no crea', '00000000-0000-0000-0000-0000000000c3', current_date + 30, '00000000-0000-0000-0000-0000000000c4');
  raise exception 'el viewer no debia crear hitos';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 11. HITOS: cumplir lo sella con fecha; un hito cumplido o cancelado ya no se edita; reasignar a staff ajeno se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  update licitaciones.contract_milestone set responsable_id = '00000000-0000-0000-0000-0000000000c2' where id = '00000000-0000-0000-0000-0000000000f1';
  raise exception 'reasignar a staff de otra organizacion no debia aceptarse';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  update licitaciones.contract_milestone set estado = 'cumplido' where id = '00000000-0000-0000-0000-0000000000f1';
  raise exception 'cumplido sin cumplido_en no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
update licitaciones.contract_milestone set estado = 'cumplido', cumplido_en = current_date where id = '00000000-0000-0000-0000-0000000000f1';
do $$ begin
  update licitaciones.contract_milestone set titulo = 'Titulo editado tras cumplir' where id = '00000000-0000-0000-0000-0000000000f1';
  raise exception 'un hito cumplido no debia editarse';
exception when sqlstate '22023' then null;
end $$;
rollback;

\echo '--- 12. CONVENIOS: solo un rol de decision; numero consecutivo y fecha de fin anterior los fija la base; el contrato recibe la nueva fecha de fin ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', 100000, current_date, 'El writer no decide', '00000000-0000-0000-0000-0000000000c3');
  raise exception 'el writer no debia registrar un convenio';
exception when sqlstate '42501' then null;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, nueva_fecha_fin, fecha_firma, motivo, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'plazo', current_date + 300, current_date, 'Ampliacion de plazo por causas de la convocante', '00000000-0000-0000-0000-0000000000c5');
insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, nueva_fecha_fin, fecha_firma, motivo, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto_plazo', -250000, current_date + 320, current_date, 'Reduccion de monto y ajuste de plazo', '00000000-0000-0000-0000-0000000000c5');
do $$ declare n1 integer; n2 integer; ant date; fin date; begin
  select numero into n1 from licitaciones.contract_amendment where tipo = 'plazo';
  select numero into n2 from licitaciones.contract_amendment where tipo = 'monto_plazo';
  if n1 <> 1 or n2 <> 2 then raise exception 'el numero consecutivo debia ser 1 y 2, fue % y %', n1, n2; end if;
  select fecha_fin_anterior into ant from licitaciones.contract_amendment where numero = 2;
  if ant <> current_date + 300 then raise exception 'el segundo convenio debia guardar la fecha de fin del primero, guardo %', ant; end if;
  select end_date into fin from licitaciones.contract where id = '00000000-0000-0000-0000-0000000000a1';
  if fin <> current_date + 320 then raise exception 'el contrato debia quedar con la ultima fecha de fin, quedo %', fin; end if;
end $$;
rollback;

\echo '--- 13. CONVENIOS: historial inmutable (sin UPDATE ni DELETE), numero no insertable, formas validas por tipo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', 500000, current_date, 'Incremento del monto autorizado', '00000000-0000-0000-0000-0000000000c1');
-- as should_fail (permission denied for table: sin UPDATE; el convenio no se reescribe)
update licitaciones.contract_amendment set motivo = 'Motivo reescrito' where tipo = 'monto' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', 500000, current_date, 'Incremento del monto autorizado', '00000000-0000-0000-0000-0000000000c1');
-- as should_fail (permission denied for table: sin DELETE)
delete from licitaciones.contract_amendment where tipo = 'monto' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: numero lo asigna la base)
insert into licitaciones.contract_amendment (organization_id, contract_id, numero, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 99, 'monto', 500000, current_date, 'Numero propio', '00000000-0000-0000-0000-0000000000c1') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, fecha_firma, motivo, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', current_date, 'Convenio de monto sin monto', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'un convenio de monto sin monto no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', 0, current_date, 'Ajuste en cero', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'un ajuste de cero no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
rollback;

\echo '--- 14. CROSS-TENANT: Org B no registra convenios ni plazos sobre el contrato de Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, fecha_firma, motivo, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'monto', 100000, current_date, 'Convenio ajeno', '00000000-0000-0000-0000-0000000000c2');
  raise exception 'Org B no debia registrar un convenio en Org A';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  insert into licitaciones.contract_plazos (contract_id, organization_id, plazo_firma_dias)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2', 10);
  raise exception 'Org B no debia colgar plazos del contrato de Org A';
exception when sqlstate '23503' then null;
end $$;
rollback;

\echo '--- 15. PLAZOS: el writer los declara y los cambia; el viewer no; la bitacora registra el cambio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.contract_plazos (contract_id, organization_id, fallo_notificado_en, plazo_firma_dias, plazo_garantia_dias)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', current_date - 5, 15, 10);
update licitaciones.contract_plazos set firmado_en = current_date where contract_id = '00000000-0000-0000-0000-0000000000a1';
do $$ declare n integer; ub uuid; begin
  select updated_by into ub from licitaciones.contract_plazos where contract_id = '00000000-0000-0000-0000-0000000000a1';
  if ub is distinct from '00000000-0000-0000-0000-0000000000c3'::uuid then raise exception 'updated_by debia ser el writer (lo fija el trigger), fue %', ub; end if;
  select count(*) into n from licitaciones.contract_post_award_log where entidad = 'plazos' and entidad_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 2 then raise exception 'la bitacora debia tener crear + editar de los plazos, hay %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ begin
  update licitaciones.contract_plazos set plazo_firma_dias = 30 where contract_id = '00000000-0000-0000-0000-0000000000a1';
  -- RLS filtra en silencio: 0 filas; se verifica que nada cambio.
  if exists (select 1 from licitaciones.contract_plazos where plazo_firma_dias = 30) then raise exception 'el viewer cambio los plazos'; end if;
end $$;
do $$ begin
  insert into licitaciones.contract_plazos (contract_id, organization_id, plazo_firma_dias) values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000d1', 10);
  raise exception 'el viewer no debia crear plazos';
exception when sqlstate '42501' or sqlstate '23503' then null;
end $$;
rollback;

\echo '--- 16. BITACORA: append-only e inforjable (sin INSERT/UPDATE/DELETE para authenticated) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: la bitacora solo la escribe el trigger)
insert into licitaciones.contract_post_award_log (organization_id, contract_id, entidad, entidad_id, accion) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'hito', gen_random_uuid(), 'crear') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: sin UPDATE)
update licitaciones.contract_post_award_log set accion = 'editar' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: sin DELETE)
delete from licitaciones.contract_post_award_log returning 1 as should_fail;
rollback;

\echo '--- 17. ANON: sin ningun privilegio sobre las 5 tablas ni EXECUTE de las funciones ---'
begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.contract_guarantee;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.contract_milestone;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.contract_amendment;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.contract_post_award_log;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
insert into licitaciones.contract_plazos (contract_id, organization_id, plazo_firma_dias) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 10) returning 1 as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 30) as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.post_award_list_responsables('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 18. SISTEMA: el barrido (auth.uid() nulo) ve solo los candidatos de la organizacion pedida; una sesion de staff NO puede usarla ---'
begin;
do $$ declare n integer; t text; begin
  select count(*) into n from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 30);
  if n <> 3 then raise exception 'Org A debia tener 3 candidatos (no entregada, por vencer, hito vencido), hay %', n; end if;
  select count(*) into n from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 30) where out_tender_id <> '00000000-0000-0000-0000-0000000000e1';
  if n <> 0 then raise exception 'los candidatos de Org A debian traer la convocatoria de Org A'; end if;
  select string_agg(out_tipo, ',' order by out_tipo) into t from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 30);
  if t <> 'garantia_no_entregada,garantia_por_vencer,hito_vencido' then raise exception 'tipos inesperados: %', t; end if;
  select count(*) into n from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d2', current_date, 30);
  if n <> 2 then raise exception 'Org B debia tener 2 candidatos (garantia por vencer, hito vencido), hay %', n; end if;
  select count(*) into n from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d2', current_date, 30) where out_entidad_id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1');
  if n <> 0 then raise exception 'los candidatos de Org B traian filas de Org A'; end if;
  begin
    perform 1 from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 0);
    raise exception 'una ventana de 0 dias no debia aceptarse';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (42501: solo para la sesion de sistema; ni el owner puede leer los candidatos)
select * from licitaciones.system_post_award_alert_candidates('00000000-0000-0000-0000-0000000000d1', current_date, 30) as should_fail;
rollback;

\echo '--- 19. RESPONSABLES: un miembro lista el staff de SU organizacion (sin correo); un ajeno no ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.post_award_list_responsables('00000000-0000-0000-0000-0000000000d1');
  if n <> 4 then raise exception 'Org A debia listar 4 miembros, listo %', n; end if;
  if licitaciones.post_award_is_member('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c2') then raise exception 'c2 no es miembro de Org A'; end if;
  if not licitaciones.post_award_is_member('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3') then raise exception 'c3 si es miembro de Org A'; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  perform 1 from licitaciones.post_award_list_responsables('00000000-0000-0000-0000-0000000000d1');
  raise exception 'Org B no debia listar el staff de Org A';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  -- Un ajeno tampoco puede usar el helper para enumerar quien es miembro de otra organizacion.
  if licitaciones.post_award_is_member('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3') then raise exception 'el helper revelo la membresia de Org A a Org B'; end if;
end $$;
rollback;

\echo '--- 20. TOPE: una garantia por encima del maximo de centavos se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.contract_guarantee (organization_id, contract_id, tipo, monto_cents, vigencia_desde, vigencia_hasta, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'anticipo', 100000000000001, current_date, current_date + 1, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'un monto sobre el tope no debia aceptarse';
exception when sqlstate '23514' then null;
end $$;
rollback;

\echo ''
\echo 'Listo: los escenarios marcados "as should_fail" deben terminar en ERROR; el resto debe completar sin error.'
