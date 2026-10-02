-- Fixtures + assertions contra Postgres REAL (RLS + trigger + indice unico + auth.uid() reales) para
-- packages/domain-licitaciones/migrations/033_expediente_doble_aprobacion.sql
-- (L-26 / REQ-044: doble aprobacion del expediente, tecnico-legal 1/2 y economica 2/2, por DOS personas).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   a1 = owner Org A   a2 = analyst Org A   a3 = writer Org A (NO es rol de decision)   a4 = admin Org A
--   b1 = owner Org B (otro tenant)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): el alias de columna que marca
-- "este escenario debe terminar en ERROR" NO se usa aqui; los negativos afirman el SQLSTATE exacto con
-- DO ... raise exception, asi un error distinto al esperado (p. ej. permiso denegado en vez del trigger)
-- tambien falla el escenario. Cada escenario corre en su propio begin/rollback.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('33000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (doble aprobacion)', 'org-a-doble'),
  ('33000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (doble aprobacion, ajena)', 'org-b-doble')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('33000000-0000-0000-0000-0000000000a1', 'owner-a-doble@example.com', 'Owner A', 'seed'),
  ('33000000-0000-0000-0000-0000000000a2', 'analyst-a-doble@example.com', 'Analyst A', 'seed'),
  ('33000000-0000-0000-0000-0000000000a3', 'writer-a-doble@example.com', 'Writer A', 'seed'),
  ('33000000-0000-0000-0000-0000000000a4', 'admin-a-doble@example.com', 'Admin A', 'seed'),
  ('33000000-0000-0000-0000-0000000000b1', 'owner-b-doble@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('33000000-0000-0000-0000-0000000000a1', '33000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('33000000-0000-0000-0000-0000000000a2', '33000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('33000000-0000-0000-0000-0000000000a3', '33000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('33000000-0000-0000-0000-0000000000a4', '33000000-0000-0000-0000-0000000000d1', null, 'admin', 'admin'),
  ('33000000-0000-0000-0000-0000000000b1', '33000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title) values
  ('33000000-0000-0000-0000-0000000000e1', '33000000-0000-0000-0000-0000000000d1', 'Convocatoria A'),
  ('33000000-0000-0000-0000-0000000000e2', '33000000-0000-0000-0000-0000000000d2', 'Convocatoria B')
on conflict do nothing;

insert into licitaciones.proposal (id, organization_id, tender_id, title) values
  ('33000000-0000-0000-0000-0000000000f1', '33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000e1', 'Propuesta A'),
  ('33000000-0000-0000-0000-0000000000f2', '33000000-0000-0000-0000-0000000000d2', '33000000-0000-0000-0000-0000000000e2', 'Propuesta B')
on conflict do nothing;

-- Una aprobacion unica "de la era anterior" ya vigente en la base ANTES de aplicar el comportamiento nuevo:
-- como la migracion ya corrio, se inserta como superusuario con stage NULL (simula una fila legada tal como
-- quedaria si alguien con el codigo viejo hubiera aprobado despues de migrar).
insert into licitaciones.approval (id, organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash)
values ('33000000-0000-0000-0000-0000000000c1', '33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente',
        '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('0', 64));

\echo ''
\echo '=== licitaciones: doble aprobacion del expediente (033) ==='
\echo ''

\echo '--- 1. POSITIVO: owner da la tecnico-legal y el analyst (otra persona) la economica, mismo hash ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'economica');
do $$ declare n integer; begin
  select count(*) into n from licitaciones.approval where proposal_id = '33000000-0000-0000-0000-0000000000f1' and status = 'vigente' and stage is not null;
  if n <> 2 then raise exception 'esperadas 2 etapas vigentes, obtuve %', n; end if;
end $$;
rollback;

\echo '--- 2. NEGATIVO: la MISMA persona no puede dar la economica tras la tecnico-legal (23514 doble_aprobacion_mismo_actor) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'economica');
    raise exception 'la misma persona logro las dos etapas';
  exception when sqlstate '23514' then
    if sqlerrm not like 'doble_aprobacion_mismo_actor%' then raise exception 'SQLSTATE correcto pero motivo inesperado: %', sqlerrm; end if;
  end;
end $$;
rollback;

\echo '--- 3. NEGATIVO: tampoco en el orden inverso (la tecnico-legal ya no puede darla quien dio la economica tras re-aprobar) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'economica');
-- la tecnico-legal vigente se invalida (re-aprobacion) y la vuelve a dar quien dio la economica
update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = 'superseded_by_new_approval'
 where proposal_id = '33000000-0000-0000-0000-0000000000f1' and stage = 'tecnica_legal' and status = 'vigente';
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'tecnica_legal');
    raise exception 'quien dio la economica logro tambien la tecnico-legal';
  exception when sqlstate '23514' then
    if sqlerrm not like 'doble_aprobacion_mismo_actor%' then raise exception 'SQLSTATE correcto pero motivo inesperado: %', sqlerrm; end if;
  end;
end $$;
rollback;

\echo '--- 4. NEGATIVO: la economica exige la tecnico-legal vigente (23514 tecnica_legal_requerida_para_economica) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'economica');
    raise exception 'la economica se registro sin tecnico-legal';
  exception when sqlstate '23514' then
    if sqlerrm not like 'tecnica_legal_requerida_para_economica%' then raise exception 'SQLSTATE correcto pero motivo inesperado: %', sqlerrm; end if;
  end;
end $$;
rollback;

\echo '--- 5. NEGATIVO: la economica con OTRO hash de insumos que la tecnico-legal vigente tampoco pasa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('2', 64), 'economica');
    raise exception 'la economica se registro con otro hash de insumos';
  exception when sqlstate '23514' then
    null;
  end;
end $$;
rollback;

\echo '--- 6. NEGATIVO: no se puede registrar la etapa a nombre de otra persona (RLS: approver_id = auth.uid(), 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'tecnica_legal');
    raise exception 'se registro una etapa a nombre de otra persona';
  exception when sqlstate '42501' then
    null;
  end;
end $$;
rollback;

\echo '--- 7. NEGATIVO: un writer (no es rol de decision) no puede aprobar ninguna etapa (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a3', 'writer', repeat('1', 64), 'tecnica_legal');
    raise exception 'un writer aprobo una etapa';
  exception when sqlstate '42501' then
    null;
  end;
end $$;
rollback;

\echo '--- 8. NEGATIVO cross-tenant: el owner de Org B no puede aprobar el expediente de Org A (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000b1', 'owner', repeat('1', 64), 'tecnica_legal');
    raise exception 'un usuario de otra organizacion aprobo';
  exception when sqlstate '42501' then
    null;
  end;
end $$;
rollback;

\echo '--- 9. cross-tenant LECTURA: el owner de Org B no ve ninguna aprobacion de Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000b1', true);
select count(*) as aprobaciones_ajenas_deberia_ser_0 from licitaciones.approval where organization_id = '33000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 10. NEGATIVO anon: sin sesion (rol anon) no hay ningun acceso a la tabla (42501) ---'
begin;
set local role anon;
do $$ begin
  begin
    perform count(*) from licitaciones.approval;
    raise exception 'anon pudo leer licitaciones.approval';
  exception when sqlstate '42501' then
    null;
  end;
end $$;
rollback;

\echo '--- 11. NEGATIVO: una segunda aprobacion vigente de la misma etapa choca con el indice unico (23505) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a4', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a4', 'admin', repeat('1', 64), 'tecnica_legal');
    raise exception 'coexisten dos tecnico-legal vigentes';
  exception when sqlstate '23505' then
    null;
  end;
end $$;
rollback;

\echo '--- 12. NEGATIVO: una etapa solo existe para el alcance expediente (CHECK 23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin
    insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
    values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'seccion', 'seccion:economic:carta', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'economica');
    raise exception 'una aprobacion de seccion registro una etapa';
  exception when sqlstate '23514' then
    null;
  end;
end $$;
rollback;

\echo '--- 13. POSITIVO: la aprobacion de seccion (sin etapa) y la aprobacion unica legada siguen pudiendo registrarse/leerse (compatibilidad) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'seccion', 'seccion:economic:carta', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64));
do $$ declare n integer; begin
  select count(*) into n from licitaciones.approval where proposal_id = '33000000-0000-0000-0000-0000000000f1' and stage is null and status = 'vigente';
  if n <> 2 then raise exception 'esperadas 2 vigentes sin etapa (legada + seccion), obtuve %', n; end if;
end $$;
rollback;

\echo '--- 14. POSITIVO: invalidar ambas etapas (cambio de insumos) deja 0 vigentes y permite repetir el 2/2 con otro hash ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('1', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('1', 64), 'economica');
update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = 'insumo_cambiado:test'
 where proposal_id = '33000000-0000-0000-0000-0000000000f1' and scope_ref = 'expediente' and status = 'vigente' and stage is not null;
-- ahora con otro hash, en el orden inverso de personas
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a2', 'analyst', repeat('3', 64), 'tecnica_legal');
select set_config('request.jwt.claim.sub', '33000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approval (organization_id, proposal_id, scope, scope_ref, approver_id, approver_role, inputs_hash, stage)
values ('33000000-0000-0000-0000-0000000000d1', '33000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '33000000-0000-0000-0000-0000000000a1', 'owner', repeat('3', 64), 'economica');
do $$ declare n integer; begin
  select count(*) into n from licitaciones.approval where proposal_id = '33000000-0000-0000-0000-0000000000f1' and status = 'vigente' and stage is not null;
  if n <> 2 then raise exception 'esperadas 2 etapas vigentes con el hash nuevo, obtuve %', n; end if;
end $$;
rollback;

\echo '--- 15. POSITIVO (datos previos): la migracion invalida las aprobaciones unicas vigentes y conserva el historial ---'
begin;
-- Reproduce el UPDATE de datos de la migracion sobre una fila legada vigente y comprueba el resultado.
update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = 'migrada_a_doble_aprobacion_033'
 where scope = 'expediente' and stage is null and status = 'vigente' and proposal_id = '33000000-0000-0000-0000-0000000000f1';
do $$ declare n integer; begin
  select count(*) into n from licitaciones.approval where id = '33000000-0000-0000-0000-0000000000c1' and status = 'invalidada' and invalidated_reason = 'migrada_a_doble_aprobacion_033';
  if n <> 1 then raise exception 'la aprobacion legada no quedo invalidada con su historial'; end if;
end $$;
rollback;

\echo ''
\echo '=== fin: todos los escenarios deben completar sin error; el unico conteo explicito (escenario 9) debe ser 0 ==='
