-- Fixtures + assertions contra Postgres REAL (RLS + triggers + GRANT por columna + SECURITY DEFINER + auth.uid() reales) para
-- packages/domain-licitaciones/migrations/036_licitaciones_aprobacion_datos_empresa.sql
-- (L-P3-01/02: aprobacion real de tarifas, documentos, capacidades, experiencia y firmantes).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   a1 = owner Org A   a2 = analyst Org A   a3 = writer Org A (NO decide)   a4 = admin Org A   a5 = reviewer Org A
--   b1 = owner Org B (otro tenant)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): los negativos afirman el SQLSTATE exacto con DO ... raise
-- exception, asi un error distinto al esperado (p. ej. otro permiso) tambien falla el escenario; los chequeos de valor usan el alias
-- `..._deberia_ser_N`. Cada escenario corre en su propio begin/rollback. La carrera de dos conexiones vive en concurrencia.sh.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('36000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (aprobacion datos empresa)', 'org-a-datos-empresa'),
  ('36000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (aprobacion datos empresa, ajena)', 'org-b-datos-empresa')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('36000000-0000-0000-0000-0000000000a1', 'owner-a-datos@example.com', 'Owner A', 'seed'),
  ('36000000-0000-0000-0000-0000000000a2', 'analyst-a-datos@example.com', 'Analyst A', 'seed'),
  ('36000000-0000-0000-0000-0000000000a3', 'writer-a-datos@example.com', 'Writer A', 'seed'),
  ('36000000-0000-0000-0000-0000000000a4', 'admin-a-datos@example.com', 'Admin A', 'seed'),
  ('36000000-0000-0000-0000-0000000000a5', 'reviewer-a-datos@example.com', 'Reviewer A', 'seed'),
  ('36000000-0000-0000-0000-0000000000b1', 'owner-b-datos@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('36000000-0000-0000-0000-0000000000a2', '36000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('36000000-0000-0000-0000-0000000000a3', '36000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', null, 'admin', 'admin'),
  ('36000000-0000-0000-0000-0000000000a5', '36000000-0000-0000-0000-0000000000d1', null, 'member', 'reviewer'),
  ('36000000-0000-0000-0000-0000000000b1', '36000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

-- Una tarifa y un documento de Org A sembrados por el administrador de la base (como lo haria el mantenimiento): ya aprobados, con
-- proposed_by NULL (datos previos a la migracion). Los escenarios crean el resto por el camino real (rol authenticated).
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, approval_status) values
  ('36000000-0000-0000-0000-0000000000c1', '36000000-0000-0000-0000-0000000000d1', 'tarifa_previa', 100.00, 'aprobado'),
  ('36000000-0000-0000-0000-0000000000c2', '36000000-0000-0000-0000-0000000000d2', 'tarifa_org_b', 200.00, 'pendiente_aprobacion');
insert into licitaciones.company_document (id, organization_id, document_type, label, approval_status) values
  ('36000000-0000-0000-0000-0000000000e1', '36000000-0000-0000-0000-0000000000d1', 'acta', 'Acta previa', 'aprobado');

\echo ''
\echo '=== licitaciones: aprobacion real de datos de empresa (036) ==='
\echo ''

\echo '--- 1. POSITIVO: un writer crea una tarifa; nace pendiente y el trigger fija proposed_by = quien la creo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.approved_rate (organization_id, concept, unit_price, valid_from)
values ('36000000-0000-0000-0000-0000000000d1', 'consultoria_hora', 500.00, '2026-01-01');
do $$ declare r record; begin
  select approval_status, proposed_by, approved_by, approved_at into r from licitaciones.approved_rate where concept = 'consultoria_hora';
  if r.approval_status <> 'pendiente_aprobacion' then raise exception 'debia nacer pendiente: %', r.approval_status; end if;
  if r.proposed_by <> '36000000-0000-0000-0000-0000000000a3' then raise exception 'proposed_by incorrecto: %', r.proposed_by; end if;
  if r.approved_by is not null or r.approved_at is not null then raise exception 'no debia traer aprobacion'; end if;
end $$;
rollback;

\echo '--- 2. NEGATIVO: el writer no puede insertar una tarifa YA aprobada (GRANT por columna, 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.approved_rate (organization_id, concept, unit_price, approval_status)
    values ('36000000-0000-0000-0000-0000000000d1', 'auto_aprobada', 1.00, 'aprobado');
    raise exception 'el writer inserto una tarifa aprobada';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 3. NEGATIVO: ni aprobarla por UPDATE directo (42501), ni falsear proposed_by o approved_by al insertar o actualizar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.approved_rate (organization_id, concept, unit_price, valid_from) values ('36000000-0000-0000-0000-0000000000d1', 'tarifa_w', 5.00, '2026-01-01');
do $$ begin
  begin
    update licitaciones.approved_rate set approval_status = 'aprobado' where concept = 'tarifa_w';
    raise exception 'el writer aprobo su tarifa por UPDATE';
  exception when sqlstate '42501' then null;
  end;
  begin
    update licitaciones.approved_rate set approved_by = '36000000-0000-0000-0000-0000000000a3' where concept = 'tarifa_w';
    raise exception 'el writer fijo approved_by';
  exception when sqlstate '42501' then null;
  end;
  begin
    update licitaciones.approved_rate set proposed_by = '36000000-0000-0000-0000-0000000000a1' where concept = 'tarifa_w';
    raise exception 'el writer cambio proposed_by';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.approved_rate (organization_id, concept, unit_price, proposed_by)
    values ('36000000-0000-0000-0000-0000000000d1', 'falsa_autoria', 1.00, '36000000-0000-0000-0000-0000000000a1');
    raise exception 'el writer inserto con proposed_by ajeno';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 4. NEGATIVO: lo mismo para documentos, capacidades, experiencia y firmantes ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_document (organization_id, document_type, label, approval_status) values ('36000000-0000-0000-0000-0000000000d1', 't', 'l', 'aprobado');
    raise exception 'documento aprobado por el writer';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_capability (organization_id, name, description, approval_status) values ('36000000-0000-0000-0000-0000000000d1', 'n', 'd', 'aprobado');
    raise exception 'capacidad aprobada por el writer';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_experience (organization_id, description, evidence_doc_id, approval_status)
    values ('36000000-0000-0000-0000-0000000000d1', 'e', '36000000-0000-0000-0000-0000000000e1', 'aprobado');
    raise exception 'experiencia aprobada por el writer';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_signer (organization_id, name, role, authorized, approval_status) values ('36000000-0000-0000-0000-0000000000d1', 'x', 'r', true, 'aprobado');
    raise exception 'firmante aprobado por el writer';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 5. POSITIVO: el owner (otra persona) aprueba la tarifa del writer; quedan approved_by/approved_at y un renglon de bitacora ---'
begin;
-- el dato lo propone el writer (el trigger fija proposed_by = auth.uid()); se siembra con id fijo antes de cambiar de rol
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, valid_from) values ('36000000-0000-0000-0000-0000000000c9', '36000000-0000-0000-0000-0000000000d1', 'tarifa_x', 7.00, '2026-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
do $$ declare r text; s record; n integer; begin
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c9', 'aprobado');
  if r <> 'ok' then raise exception 'esperado ok, obtuve %', r; end if;
  select approval_status, approved_by, approved_at into s from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c9';
  if s.approval_status <> 'aprobado' or s.approved_by <> '36000000-0000-0000-0000-0000000000a1' or s.approved_at is null then raise exception 'aprobacion mal registrada'; end if;
  select count(*) into n from licitaciones.company_data_audit where item_id = '36000000-0000-0000-0000-0000000000c9' and decision = 'aprobado' and actor_id = '36000000-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'bitacora esperada 1, obtuve %', n; end if;
end $$;
rollback;

\echo '--- 6. NEGATIVO: el AUTOR no decide su propia tarifa (resultado autor); tampoco la rechaza ---'
begin;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, valid_from) values ('36000000-0000-0000-0000-0000000000c8', '36000000-0000-0000-0000-0000000000d1', 'tarifa_propia', 7.00, '2026-01-01');
set local role authenticated;
do $$ declare r text; s text; begin
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c8', 'aprobado');
  if r <> 'autor' then raise exception 'esperado autor, obtuve %', r; end if;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c8', 'rechazado');
  if r <> 'autor' then raise exception 'esperado autor al rechazar, obtuve %', r; end if;
  select approval_status into s from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c8';
  if s <> 'pendiente_aprobacion' then raise exception 'la tarifa cambio de estado: %', s; end if;
end $$;
rollback;

\echo '--- 7. NEGATIVO: roles sin decision (writer, reviewer) -> 42501; analyst decide documentos pero NO tarifas ---'
begin;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, valid_from) values ('36000000-0000-0000-0000-0000000000c7', '36000000-0000-0000-0000-0000000000d1', 'tarifa_roles', 7.00, '2026-01-01');
insert into licitaciones.company_document (id, organization_id, document_type, label) values ('36000000-0000-0000-0000-0000000000e2', '36000000-0000-0000-0000-0000000000d1', 'rfc', 'Constancia');
set local role authenticated;
do $$ declare r text; begin
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true) into r;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a3', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c7', 'aprobado');
    raise exception 'el writer decidio';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a5', true) into r;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a5', '36000000-0000-0000-0000-0000000000d1', 'document', '36000000-0000-0000-0000-0000000000e2', 'aprobado');
    raise exception 'el reviewer decidio';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a2', true) into r;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a2', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c7', 'aprobado');
    raise exception 'el analyst aprobo una tarifa';
  exception when sqlstate '42501' then null;
  end;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a2', '36000000-0000-0000-0000-0000000000d1', 'document', '36000000-0000-0000-0000-0000000000e2', 'aprobado');
  if r <> 'ok' then raise exception 'el analyst debia poder decidir un documento: %', r; end if;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a4', true) into r;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c7', 'aprobado');
  if r <> 'ok' then raise exception 'el admin debia poder aprobar la tarifa: %', r; end if;
end $$;
rollback;

\echo '--- 8. NEGATIVO: el llamador declarado debe ser la sesion (auth.uid() = p_caller_id), 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c1', 'aprobado');
    raise exception 'una sesion se hizo pasar por otra persona';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 9. DB-03 POSITIVO: editar el precio de una tarifa aprobada la regresa a pendiente EN LA MISMA sentencia y limpia la aprobacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
update licitaciones.approved_rate set unit_price = 999.00 where id = '36000000-0000-0000-0000-0000000000c1';
do $$ declare r record; begin
  select approval_status, approved_by, approved_at, proposed_by into r from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c1';
  if r.approval_status <> 'pendiente_aprobacion' then raise exception 'debia volver a pendiente: %', r.approval_status; end if;
  if r.approved_by is not null or r.approved_at is not null then raise exception 'la aprobacion debia limpiarse'; end if;
  if r.proposed_by <> '36000000-0000-0000-0000-0000000000a3' then raise exception 'proposed_by debia ser quien edito: %', r.proposed_by; end if;
end $$;
rollback;

\echo '--- 10. DB-03: cambiar la vigencia tambien invalida; un UPDATE sin cambio real conserva la aprobacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
update licitaciones.approved_rate set unit_price = unit_price where id = '36000000-0000-0000-0000-0000000000c1';
do $$ declare s text; begin
  select approval_status into s from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c1';
  if s <> 'aprobado' then raise exception 'un UPDATE sin cambio no debia invalidar: %', s; end if;
end $$;
update licitaciones.approved_rate set valid_until = '2027-12-31' where id = '36000000-0000-0000-0000-0000000000c1';
do $$ declare s text; begin
  select approval_status into s from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c1';
  if s <> 'pendiente_aprobacion' then raise exception 'cambiar la vigencia debia invalidar: %', s; end if;
end $$;
rollback;

\echo '--- 11. DB-03 en documentos: editar la etiqueta de un documento aprobado lo regresa a pendiente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
update licitaciones.company_document set label = 'Acta corregida' where id = '36000000-0000-0000-0000-0000000000e1';
do $$ declare s text; begin
  select approval_status into s from licitaciones.company_document where id = '36000000-0000-0000-0000-0000000000e1';
  if s <> 'pendiente_aprobacion' then raise exception 'debia volver a pendiente: %', s; end if;
end $$;
rollback;

\echo '--- 12. Una segunda decision sobre un dato ya decidido da conflict; un id inexistente da not_found; decision o tipo invalidos 22023 ---'
begin;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, valid_from) values ('36000000-0000-0000-0000-0000000000c6', '36000000-0000-0000-0000-0000000000d1', 'tarifa_doble', 7.00, '2026-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
do $$ declare r text; begin
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c6', 'aprobado');
  if r <> 'ok' then raise exception 'primera decision: %', r; end if;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a4', true) into r;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c6', 'rechazado');
  if r <> 'conflict' then raise exception 'esperado conflict, obtuve %', r; end if;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000ff', 'aprobado');
  if r <> 'not_found' then raise exception 'esperado not_found, obtuve %', r; end if;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c6', 'pendiente_aprobacion');
    raise exception 'decision invalida aceptada';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a4', '36000000-0000-0000-0000-0000000000d1', 'otro', '36000000-0000-0000-0000-0000000000c6', 'aprobado');
    raise exception 'tipo invalido aceptado';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

\echo '--- 13. Rechazar es una decision: queda rechazado con quien rechazo; solo editar lo regresa a pendiente ---'
begin;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_capability (id, organization_id, name, description) values ('36000000-0000-0000-0000-0000000000f5', '36000000-0000-0000-0000-0000000000d1', 'cap_x', 'desc');
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a2', true);
do $$ declare r text; s text; begin
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a2', '36000000-0000-0000-0000-0000000000d1', 'capability', '36000000-0000-0000-0000-0000000000f5', 'rechazado');
  if r <> 'ok' then raise exception 'rechazo: %', r; end if;
  select approval_status into s from licitaciones.company_capability where id = '36000000-0000-0000-0000-0000000000f5';
  if s <> 'rechazado' then raise exception 'esperado rechazado: %', s; end if;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true) into r;
  update licitaciones.company_capability set description = 'otra' where id = '36000000-0000-0000-0000-0000000000f5';
  select approval_status into s from licitaciones.company_capability where id = '36000000-0000-0000-0000-0000000000f5';
  if s <> 'pendiente_aprobacion' then raise exception 'editar debia reabrir: %', s; end if;
end $$;
rollback;

\echo '--- 14. Firmantes: nacen pendientes, el writer no los aprueba, el analyst si; editarlos reabre ---'
begin;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_signer (id, organization_id, name, role, authorized) values ('36000000-0000-0000-0000-0000000000f6', '36000000-0000-0000-0000-0000000000d1', 'Ana', 'representante_legal', true);
set local role authenticated;
do $$ declare r text; s text; begin
  select approval_status into s from licitaciones.company_signer where id = '36000000-0000-0000-0000-0000000000f6';
  if s <> 'pendiente_aprobacion' then raise exception 'debia nacer pendiente: %', s; end if;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a2', true) into r;
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a2', '36000000-0000-0000-0000-0000000000d1', 'signer', '36000000-0000-0000-0000-0000000000f6', 'aprobado');
  if r <> 'ok' then raise exception 'aprobar firmante: %', r; end if;
  select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true) into r;
  update licitaciones.company_signer set authorized = false where id = '36000000-0000-0000-0000-0000000000f6';
  select approval_status into s from licitaciones.company_signer where id = '36000000-0000-0000-0000-0000000000f6';
  if s <> 'pendiente_aprobacion' then raise exception 'editar el firmante debia reabrir: %', s; end if;
end $$;
rollback;

\echo '--- 15. CROSS-TENANT: el owner de Org B no decide datos de Org A (42501) y no ve sus tarifas ni su bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000b1', true);
do $$ declare r text; begin
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000b1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c1', 'rechazado');
    raise exception 'el owner de otra organizacion decidio';
  exception when sqlstate '42501' then null;
  end;
  -- con su PROPIA organizacion pero el id de una tarifa ajena: no existe ahi
  r := licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000b1', '36000000-0000-0000-0000-0000000000d2', 'rate', '36000000-0000-0000-0000-0000000000c1', 'rechazado');
  if r <> 'not_found' then raise exception 'esperado not_found, obtuve %', r; end if;
end $$;
select count(*) as tarifas_ajenas_deberia_ser_0 from licitaciones.approved_rate where organization_id = '36000000-0000-0000-0000-0000000000d1';
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
select count(*) as bitacora_ajena_deberia_ser_0 from licitaciones.company_data_audit where organization_id = '36000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 16. CROSS-TENANT: el writer de Org A no puede insertar datos en Org B (RLS, 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.approved_rate (organization_id, concept, unit_price) values ('36000000-0000-0000-0000-0000000000d2', 'intrusa', 1.00);
    raise exception 'el writer inserto en otra organizacion';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 17. BITACORA append-only: nadie con rol authenticated puede insertar, editar ni borrar renglones (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin
    insert into licitaciones.company_data_audit (organization_id, kind, item_id, decision, actor_id)
    values ('36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c1', 'aprobado', '36000000-0000-0000-0000-0000000000a1');
    raise exception 'el owner escribio la bitacora a mano';
  exception when sqlstate '42501' then null;
  end;
  begin
    delete from licitaciones.company_data_audit;
    raise exception 'el owner borro la bitacora';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 18. ANON: sin lectura de datos de empresa ni de la bitacora, y sin ejecutar la funcion de decision (42501) ---'
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from licitaciones.approved_rate limit 1;
    raise exception 'anon leyo tarifas';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform 1 from licitaciones.company_data_audit limit 1;
    raise exception 'anon leyo la bitacora';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c1', 'aprobado');
    raise exception 'anon ejecuto la decision';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 19. Sin sesion (auth.uid() null): la funcion de decision falla cerrada (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  begin
    perform licitaciones.decide_company_item('36000000-0000-0000-0000-0000000000a1', '36000000-0000-0000-0000-0000000000d1', 'rate', '36000000-0000-0000-0000-0000000000c1', 'aprobado');
    raise exception 'una sesion de sistema decidio';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 20. service_role (mantenimiento) conserva el acceso: puede sembrar un dato ya aprobado ---'
begin;
set local role service_role;
insert into licitaciones.approved_rate (organization_id, concept, unit_price, approval_status) values ('36000000-0000-0000-0000-0000000000d1', 'sembrada_por_mantenimiento', 1.00, 'aprobado');
do $$ declare s text; begin
  select approval_status into s from licitaciones.approved_rate where concept = 'sembrada_por_mantenimiento';
  if s <> 'aprobado' then raise exception 'service_role debia poder sembrar aprobado: %', s; end if;
end $$;
rollback;

\echo '--- 21. Lectura intacta: cualquier miembro de la organizacion (incluido el viewer-like writer) sigue leyendo las tarifas de SU organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-0000-0000-0000000000a3', true);
select count(*) as lectura_propia_deberia_ser_1 from licitaciones.approved_rate where id = '36000000-0000-0000-0000-0000000000c1';
rollback;

\echo ''
\echo '=== fin de la verificacion de aprobacion de datos de empresa (036) ==='
