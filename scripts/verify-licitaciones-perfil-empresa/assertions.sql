-- Fixtures + assertions contra Postgres REAL (RLS + triggers + GRANT por columna + SECURITY DEFINER + auth.uid() reales) para
-- packages/domain-licitaciones/migrations/040_licitaciones_perfil_empresa_completo.sql
-- (L-P3-03/04: perfil de empresa completo, firmantes con vigencia, procedencia por campo REQ-142).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   a1 = owner Org A   a2 = analyst Org A   a3 = writer Org A (NO decide)   a4 = admin Org A   a5 = viewer Org A (solo lee)
--   b1 = owner Org B (otro tenant)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): los negativos afirman el SQLSTATE exacto con DO ... raise
-- exception, asi un error distinto al esperado tambien falla el escenario; los chequeos de valor usan el alias `..._deberia_ser_N`.
-- Cada escenario corre en su propio begin/rollback.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('40000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (perfil empresa)', 'org-a-perfil-empresa'),
  ('40000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (perfil empresa, ajena)', 'org-b-perfil-empresa')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('40000000-0000-0000-0000-0000000000a1', 'owner-a-perfil@example.com', 'Owner A', 'seed'),
  ('40000000-0000-0000-0000-0000000000a2', 'analyst-a-perfil@example.com', 'Analyst A', 'seed'),
  ('40000000-0000-0000-0000-0000000000a3', 'writer-a-perfil@example.com', 'Writer A', 'seed'),
  ('40000000-0000-0000-0000-0000000000a4', 'admin-a-perfil@example.com', 'Admin A', 'seed'),
  ('40000000-0000-0000-0000-0000000000a5', 'viewer-a-perfil@example.com', 'Viewer A', 'seed'),
  ('40000000-0000-0000-0000-0000000000b1', 'owner-b-perfil@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('40000000-0000-0000-0000-0000000000a4', '40000000-0000-0000-0000-0000000000d1', null, 'admin', 'admin'),
  ('40000000-0000-0000-0000-0000000000a5', '40000000-0000-0000-0000-0000000000d1', null, 'viewer', 'viewer'),
  ('40000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

-- Datos sembrados por el administrador de la base (como lo haria el mantenimiento o un script SQL): NO pasan por la API, asi que no
-- tienen procedencia. Un firmante anterior a la migracion (sin vigencia) y un documento de Org A y otro de Org B.
insert into licitaciones.company_signer (id, organization_id, name, role, authorized, approval_status) values
  ('40000000-0000-0000-0000-000000000051', '40000000-0000-0000-0000-0000000000d1', 'Firmante previo', 'representante_legal', true, 'aprobado');
insert into licitaciones.company_document (id, organization_id, document_type, label, approval_status) values
  ('40000000-0000-0000-0000-0000000000e1', '40000000-0000-0000-0000-0000000000d1', 'poder_notarial', 'Poder notarial', 'aprobado'),
  ('40000000-0000-0000-0000-0000000000e2', '40000000-0000-0000-0000-0000000000d2', 'poder_notarial', 'Poder de la otra organizacion', 'aprobado');
insert into licitaciones.company_location (id, organization_id, kind, name, state, approval_status) values
  ('40000000-0000-0000-0000-000000000061', '40000000-0000-0000-0000-0000000000d1', 'matriz', 'Matriz sembrada por SQL', 'Yucatan', 'aprobado');

\echo ''
\echo '=== licitaciones: perfil de empresa completo y procedencia (040) ==='
\echo ''

\echo '--- 1. POSITIVO: un writer crea el perfil general; nace pendiente y el trigger fija proposed_by; el RFC y las cifras se validan (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_profile (organization_id, legal_name, tax_id, sector, employee_count, annual_sales_cents)
values ('40000000-0000-0000-0000-0000000000d1', 'Acme SA de CV', 'ACM010101AB1', 'servicios', 12, 500000000);
do $$ declare r record; begin
  select approval_status, proposed_by, approved_by, approved_at into r from licitaciones.company_profile where organization_id = '40000000-0000-0000-0000-0000000000d1';
  if r.approval_status <> 'pendiente_aprobacion' then raise exception 'debia nacer pendiente: %', r.approval_status; end if;
  if r.proposed_by <> '40000000-0000-0000-0000-0000000000a3' then raise exception 'proposed_by incorrecto: %', r.proposed_by; end if;
  if r.approved_by is not null or r.approved_at is not null then raise exception 'no debia traer aprobacion'; end if;
end $$;
do $$ begin
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id) values ('40000000-0000-0000-0000-0000000000d1', 'Otra', 'ACM010101AB1');
    raise exception 'un segundo perfil de la misma organizacion';
  exception when sqlstate '23505' then null;
  end;
end $$;
rollback;

\echo '--- 2. NEGATIVO: RFC mal formado, ventas o trabajadores negativos y sector fuera de catalogo se rechazan (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'rfc-invalido');
    raise exception 'RFC invalido aceptado';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id, employee_count) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'ACM010101AB1', -1);
    raise exception 'trabajadores negativos aceptados';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id, annual_sales_cents) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'ACM010101AB1', -5);
    raise exception 'ventas negativas aceptadas';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id, sector) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'ACM010101AB1', 'agro');
    raise exception 'sector fuera de catalogo aceptado';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;

\echo '--- 3. NEGATIVO: el writer no puede insertar ya aprobado ni fijar proposed_by/approved_by (42501 por columna) en ninguna tabla nueva ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_profile (organization_id, legal_name, tax_id, approval_status) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'ACM010101AB1', 'aprobado');
    raise exception 'perfil aprobado por el writer';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_product_service (organization_id, kind, name, approval_status) values ('40000000-0000-0000-0000-0000000000d1', 'servicio', 'x', 'aprobado');
    raise exception 'producto aprobado por el writer';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_location (organization_id, kind, name, state, proposed_by) values ('40000000-0000-0000-0000-0000000000d1', 'sucursal', 'x', 'Yucatan', '40000000-0000-0000-0000-0000000000a1');
    raise exception 'ubicacion con proposed_by ajeno';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_restriction (organization_id, kind, description, valid_from, approved_by) values ('40000000-0000-0000-0000-0000000000d1', 'sancion', 'x', '2026-01-01', '40000000-0000-0000-0000-0000000000a3');
    raise exception 'restriccion con approved_by';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into licitaciones.company_stakeholder (organization_id, kind, full_name, approval_status) values ('40000000-0000-0000-0000-0000000000d1', 'socio', 'x', 'aprobado');
    raise exception 'socio aprobado por el writer';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 4. NEGATIVO: ni aprobar por UPDATE directo ni cambiar proposed_by (42501) ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_stakeholder (id, organization_id, kind, full_name, participation_pct) values ('40000000-0000-0000-0000-000000000071', '40000000-0000-0000-0000-0000000000d1', 'socio', 'Ana Perez', 50.00);
set local role authenticated;
do $$ begin
  begin
    update licitaciones.company_stakeholder set approval_status = 'aprobado' where id = '40000000-0000-0000-0000-000000000071';
    raise exception 'el writer aprobo por UPDATE';
  exception when sqlstate '42501' then null;
  end;
  begin
    update licitaciones.company_stakeholder set proposed_by = '40000000-0000-0000-0000-0000000000a1' where id = '40000000-0000-0000-0000-000000000071';
    raise exception 'el writer cambio proposed_by';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 5. POSITIVO: el analyst (otra persona) aprueba un socio, una restriccion y el perfil; quedan approved_by y bitacora con el tipo nuevo ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_stakeholder (id, organization_id, kind, full_name, participation_pct) values ('40000000-0000-0000-0000-000000000071', '40000000-0000-0000-0000-0000000000d1', 'socio', 'Ana Perez', 50.00);
insert into licitaciones.company_restriction (id, organization_id, kind, description, valid_from) values ('40000000-0000-0000-0000-000000000072', '40000000-0000-0000-0000-0000000000d1', 'sancion', 'Sancion de prueba', '2026-01-01');
insert into licitaciones.company_profile (id, organization_id, legal_name, tax_id) values ('40000000-0000-0000-0000-000000000073', '40000000-0000-0000-0000-0000000000d1', 'Acme', 'ACM010101AB1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a2', true);
do $$ declare r text; n integer; s text; begin
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'stakeholder', '40000000-0000-0000-0000-000000000071', 'aprobado');
  if r <> 'ok' then raise exception 'socio: esperado ok, obtuve %', r; end if;
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'restriction', '40000000-0000-0000-0000-000000000072', 'rechazado');
  if r <> 'ok' then raise exception 'restriccion: esperado ok, obtuve %', r; end if;
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'profile', '40000000-0000-0000-0000-000000000073', 'aprobado');
  if r <> 'ok' then raise exception 'perfil: esperado ok, obtuve %', r; end if;
  select approval_status into s from licitaciones.company_restriction where id = '40000000-0000-0000-0000-000000000072';
  if s <> 'rechazado' then raise exception 'la restriccion debia quedar rechazada: %', s; end if;
  select count(*) into n from licitaciones.company_data_audit where actor_id = '40000000-0000-0000-0000-0000000000a2' and kind in ('stakeholder', 'restriction', 'profile');
  if n <> 3 then raise exception 'bitacora esperada 3, obtuve %', n; end if;
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'stakeholder', '40000000-0000-0000-0000-000000000071', 'rechazado');
  if r <> 'conflict' then raise exception 'segunda decision debia ser conflict: %', r; end if;
end $$;
rollback;

\echo '--- 6. NEGATIVO: el AUTOR no decide su propio dato nuevo; writer y viewer no deciden (42501); tipo invalido 22023 ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.company_location (id, organization_id, kind, name, state) values ('40000000-0000-0000-0000-000000000062', '40000000-0000-0000-0000-0000000000d1', 'sucursal', 'Merida', 'Yucatan');
set local role authenticated;
do $$ declare r text; x text; begin
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000062', 'aprobado');
  if r <> 'autor' then raise exception 'esperado autor, obtuve %', r; end if;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true) into x;
  begin
    perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000062', 'aprobado');
    raise exception 'el writer decidio';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a5', true) into x;
  begin
    perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a5', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000062', 'aprobado');
    raise exception 'el viewer decidio';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a1', true) into x;
  begin
    perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000d1', 'inventado', '40000000-0000-0000-0000-000000000062', 'aprobado');
    raise exception 'tipo invalido aceptado';
  exception when sqlstate '22023' then null;
  end;
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000062', 'aprobado');
  if r <> 'ok' then raise exception 'el owner debia poder decidir: %', r; end if;
end $$;
rollback;

\echo '--- 7. DB-03: editar el perfil aprobado lo regresa a pendiente en la misma sentencia; un UPDATE sin cambio real no ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_profile (id, organization_id, legal_name, tax_id, employee_count) values ('40000000-0000-0000-0000-000000000073', '40000000-0000-0000-0000-0000000000d1', 'Acme', 'ACM010101AB1', 10);
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a2', true);
select licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'profile', '40000000-0000-0000-0000-000000000073', 'aprobado');
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
update licitaciones.company_profile set employee_count = 10 where id = '40000000-0000-0000-0000-000000000073';
do $$ declare s text; begin
  select approval_status into s from licitaciones.company_profile where id = '40000000-0000-0000-0000-000000000073';
  if s <> 'aprobado' then raise exception 'un UPDATE sin cambio no debia invalidar la aprobacion: %', s; end if;
end $$;
update licitaciones.company_profile set employee_count = 11 where id = '40000000-0000-0000-0000-000000000073';
do $$ declare s text; begin
  select approval_status into s from licitaciones.company_profile where id = '40000000-0000-0000-0000-000000000073';
  if s <> 'pendiente_aprobacion' then raise exception 'editar un dato aprobado debia regresarlo a pendiente: %', s; end if;
end $$;
rollback;

\echo '--- 8. POSITIVO: el viejo unico por cargo ya no existe y se pueden crear dos firmantes del mismo cargo con vigencia ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_signer (organization_id, name, role, authorized, valid_from, valid_until, action_limits)
values ('40000000-0000-0000-0000-0000000000d1', 'Ana Lopez', 'representante_legal', true, '2026-01-01', '2026-12-31', 'hasta 5 mdp');
insert into licitaciones.company_signer (organization_id, name, role, authorized, valid_from)
values ('40000000-0000-0000-0000-0000000000d1', 'Beto Ruiz', 'representante_legal', true, '2027-01-01');
select count(*) as signers_mismo_cargo_deberia_ser_3 from licitaciones.company_signer where organization_id = '40000000-0000-0000-0000-0000000000d1' and role = 'representante_legal';
rollback;

\echo '--- 9. El unico (organization_id, role) ya no existe en la base ---'
begin;
select count(*) as unicos_viejos_deberia_ser_0 from pg_constraint where conrelid = 'licitaciones.company_signer'::regclass and contype = 'u';
rollback;

\echo '--- 10. NEGATIVO: vigencia invertida (23514), documento de identidad de OTRA organizacion (23503) o inexistente (23503); el propio se acepta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_signer (organization_id, name, role, valid_from, valid_until) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'rep', '2026-12-31', '2026-01-01');
    raise exception 'vigencia invertida aceptada';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into licitaciones.company_signer (organization_id, name, role, identity_doc_id) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'rep', '40000000-0000-0000-0000-0000000000e2');
    raise exception 'documento de otra organizacion aceptado';
  exception when sqlstate '23503' then null;
  end;
  begin
    insert into licitaciones.company_signer (organization_id, name, role, identity_doc_id) values ('40000000-0000-0000-0000-0000000000d1', 'X', 'rep', '40000000-0000-0000-0000-0000000000ff');
    raise exception 'documento inexistente aceptado';
  exception when sqlstate '23503' then null;
  end;
  insert into licitaciones.company_signer (organization_id, name, role, identity_doc_id) values ('40000000-0000-0000-0000-0000000000d1', 'Con poder', 'rep', '40000000-0000-0000-0000-0000000000e1');
end $$;
rollback;

\echo '--- 11. NEGATIVO: socio con porcentaje fuera de 0-100 (23514), representante con porcentaje (23514), RFC invalido (23514); dos decimales exactos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_stakeholder (organization_id, kind, full_name, participation_pct) values ('40000000-0000-0000-0000-0000000000d1', 'socio', 'x', 100.01);
    raise exception 'porcentaje mayor a 100 aceptado';
  exception when sqlstate '23514' or sqlstate '22003' then null;
  end;
  begin
    insert into licitaciones.company_stakeholder (organization_id, kind, full_name, participation_pct) values ('40000000-0000-0000-0000-0000000000d1', 'representante', 'x', 10.00);
    raise exception 'un representante con participacion';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into licitaciones.company_stakeholder (organization_id, kind, full_name, rfc) values ('40000000-0000-0000-0000-0000000000d1', 'socio', 'x', 'no-es-rfc');
    raise exception 'RFC invalido aceptado';
  exception when sqlstate '23514' then null;
  end;
end $$;
insert into licitaciones.company_stakeholder (organization_id, kind, full_name, rfc, participation_pct) values ('40000000-0000-0000-0000-0000000000d1', 'socio', 'Ana Dos Decimales', 'XAXX010101000', 33.33);
select (participation_pct = 33.33)::int as dos_decimales_deberia_ser_1 from licitaciones.company_stakeholder where full_name = 'Ana Dos Decimales';
rollback;

\echo '--- 12. NEGATIVO: restriccion con termino anterior al inicio (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.company_restriction (organization_id, kind, description, valid_from, valid_until) values ('40000000-0000-0000-0000-0000000000d1', 'inhabilitacion', 'x', '2026-06-01', '2026-01-01');
    raise exception 'termino anterior al inicio aceptado';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;

\echo '--- 13. NEGATIVO: authenticated NO puede escribir en field_provenance por SQL directo (42501 insert/update/delete): una fila por SQL no tiene procedencia ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.field_provenance (organization_id, entity, entity_id, field, owner_user_id, source) values ('40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', '*', '40000000-0000-0000-0000-0000000000a3', 'manual');
    raise exception 'insert directo de procedencia';
  exception when sqlstate '42501' then null;
  end;
  begin
    update licitaciones.field_provenance set source = 'asistente';
    raise exception 'update directo de procedencia';
  exception when sqlstate '42501' then null;
  end;
  begin
    delete from licitaciones.field_provenance;
    raise exception 'delete directo de procedencia';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 14. POSITIVO: record_field_provenance por el writer: queda el registro (*) y cada campo con dueño = quien llamo; repetir actualiza, no duplica ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_location (id, organization_id, kind, name, state) values ('40000000-0000-0000-0000-000000000063', '40000000-0000-0000-0000-0000000000d1', 'bodega', 'Bodega', 'Yucatan');
set local role authenticated;
select licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000063', array['name', 'state'], 'manual');
select licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000063', array['name'], 'manual');
do $$ declare n integer; o uuid; src text; begin
  select count(*) into n from licitaciones.field_provenance where entity = 'location' and entity_id = '40000000-0000-0000-0000-000000000063';
  if n <> 3 then raise exception 'esperadas 3 filas (*, name, state), obtuve %', n; end if;
  select owner_user_id, source into o, src from licitaciones.field_provenance where entity = 'location' and entity_id = '40000000-0000-0000-0000-000000000063' and field = '*';
  if o <> '40000000-0000-0000-0000-0000000000a3' or src <> 'manual' then raise exception 'dueño o fuente incorrectos'; end if;
end $$;
rollback;

\echo '--- 15. NEGATIVO: record_field_provenance exige que la sesion sea quien dice ser (42501), rol de escritura (viewer 42501), registro propio (P0002 si es de otra org o no existe), entidad y fuente validas (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ declare x text; begin
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', null, 'manual');
    raise exception 'suplanto a otro usuario';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a5', true) into x;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a5', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', null, 'manual');
    raise exception 'el viewer escribio procedencia';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true) into x;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-0000000000ff', null, 'manual');
    raise exception 'registro inexistente aceptado';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'document', '40000000-0000-0000-0000-0000000000e2', null, 'manual');
    raise exception 'procedencia de un documento de OTRA organizacion';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'inventada', '40000000-0000-0000-0000-000000000061', null, 'manual');
    raise exception 'entidad invalida aceptada';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', null, 'inventada');
    raise exception 'fuente invalida aceptada';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

\echo '--- 16. NEGATIVO: sin sesion (auth.uid() nulo) tampoco se escribe procedencia (42501) ---'
begin;
set local role authenticated;
do $$ begin
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', null, 'manual');
    raise exception 'escribio procedencia sin sesion';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 17. ATOMICIDAD: si la procedencia falla, el dato recien insertado NO queda (la misma transaccion lo revierte) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ declare v_id uuid; begin
  begin
    insert into licitaciones.company_location (organization_id, kind, name, state) values ('40000000-0000-0000-0000-0000000000d1', 'planta', 'Planta atomica', 'Yucatan') returning id into v_id;
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', v_id, null, 'fuente-invalida');
    raise exception 'la procedencia invalida no fallo';
  exception when sqlstate '22023' then null;
  end;
  if exists (select 1 from licitaciones.company_location where name = 'Planta atomica') then raise exception 'el dato quedo sin su procedencia'; end if;
  if exists (select 1 from licitaciones.field_provenance where entity_id = v_id) then raise exception 'quedo procedencia huerfana'; end if;
end $$;
rollback;

\echo '--- 18. Un dato insertado por SQL (mantenimiento) NO tiene procedencia: la lectura lo distingue ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
select count(*) as sembrado_sin_procedencia_deberia_ser_0 from licitaciones.field_provenance where entity = 'location' and entity_id = '40000000-0000-0000-0000-000000000061';
rollback;

\echo '--- 19. CROSS-TENANT: el owner de otra organizacion no lee perfil, socios ni procedencia de Org A ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_profile (organization_id, legal_name, tax_id) values ('40000000-0000-0000-0000-0000000000d1', 'Acme', 'ACM010101AB1');
insert into licitaciones.company_stakeholder (id, organization_id, kind, full_name) values ('40000000-0000-0000-0000-000000000075', '40000000-0000-0000-0000-0000000000d1', 'socio', 'Ana');
select licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'stakeholder', '40000000-0000-0000-0000-000000000075', null, 'manual');
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000b1', true);
select (select count(*) from licitaciones.company_profile) + (select count(*) from licitaciones.company_stakeholder) + (select count(*) from licitaciones.field_provenance) + (select count(*) from licitaciones.company_location) as ajeno_lee_deberia_ser_0;
rollback;

\echo '--- 20. CROSS-TENANT: el owner de otra organizacion no inserta en Org A (42501 RLS), no decide (42501) ni borra (0 filas) ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_restriction (id, organization_id, kind, description, valid_from) values ('40000000-0000-0000-0000-000000000072', '40000000-0000-0000-0000-0000000000d1', 'sancion', 'x', '2026-01-01');
insert into licitaciones.company_product_service (id, organization_id, kind, name) values ('40000000-0000-0000-0000-000000000081', '40000000-0000-0000-0000-0000000000d1', 'servicio', 'Consultoria');
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000b1', true);
do $$ declare n integer; begin
  begin
    insert into licitaciones.company_product_service (organization_id, kind, name) values ('40000000-0000-0000-0000-0000000000d1', 'servicio', 'colado');
    raise exception 'inserto en otra organizacion';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-0000000000d1', 'restriction', '40000000-0000-0000-0000-000000000072', 'aprobado');
    raise exception 'decidio en otra organizacion';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-0000000000d1', 'product', '40000000-0000-0000-0000-000000000081', null, 'manual');
    raise exception 'escribio procedencia en otra organizacion';
  exception when sqlstate '42501' then null;
  end;
  delete from licitaciones.company_product_service where id = '40000000-0000-0000-0000-000000000081';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'borro un producto ajeno'; end if;
end $$;
rollback;

\echo '--- 21. BAJAS: el writer borra productos y ubicaciones pero NO restricciones ni socios (RLS: 0 filas); el analyst si ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.company_product_service (id, organization_id, kind, name) values ('40000000-0000-0000-0000-000000000081', '40000000-0000-0000-0000-0000000000d1', 'servicio', 'Consultoria');
insert into licitaciones.company_restriction (id, organization_id, kind, description, valid_from) values ('40000000-0000-0000-0000-000000000072', '40000000-0000-0000-0000-0000000000d1', 'sancion', 'x', '2026-01-01');
insert into licitaciones.company_stakeholder (id, organization_id, kind, full_name) values ('40000000-0000-0000-0000-000000000075', '40000000-0000-0000-0000-0000000000d1', 'socio', 'Ana');
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ declare n integer; x text; begin
  delete from licitaciones.company_product_service where id = '40000000-0000-0000-0000-000000000081';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'el writer debia borrar el producto'; end if;
  delete from licitaciones.company_restriction where id = '40000000-0000-0000-0000-000000000072';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'el writer borro una restriccion'; end if;
  delete from licitaciones.company_stakeholder where id = '40000000-0000-0000-0000-000000000075';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'el writer borro un socio'; end if;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a2', true) into x;
  delete from licitaciones.company_restriction where id = '40000000-0000-0000-0000-000000000072';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'el analyst debia borrar la restriccion'; end if;
  delete from licitaciones.company_stakeholder where id = '40000000-0000-0000-0000-000000000075';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'el analyst debia borrar el socio'; end if;
end $$;
rollback;

\echo '--- 22. El viewer lee pero no escribe en las tablas nuevas (42501 RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a5', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.company_location;
  if n < 1 then raise exception 'el viewer debia poder leer'; end if;
  begin
    insert into licitaciones.company_location (organization_id, kind, name, state) values ('40000000-0000-0000-0000-0000000000d1', 'sucursal', 'x', 'Yucatan');
    raise exception 'el viewer escribio';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 23. ANON: sin acceso a ninguna tabla nueva ni a las funciones (42501) ---'
begin;
set local role anon;
do $$ begin
  begin perform 1 from licitaciones.company_profile; raise exception 'anon leyo el perfil'; exception when sqlstate '42501' then null; end;
  begin perform 1 from licitaciones.company_product_service; raise exception 'anon leyo productos'; exception when sqlstate '42501' then null; end;
  begin perform 1 from licitaciones.company_location; raise exception 'anon leyo ubicaciones'; exception when sqlstate '42501' then null; end;
  begin perform 1 from licitaciones.company_restriction; raise exception 'anon leyo restricciones'; exception when sqlstate '42501' then null; end;
  begin perform 1 from licitaciones.company_stakeholder; raise exception 'anon leyo socios'; exception when sqlstate '42501' then null; end;
  begin perform 1 from licitaciones.field_provenance; raise exception 'anon leyo procedencia'; exception when sqlstate '42501' then null; end;
  begin perform licitaciones.record_field_provenance('40000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000d1', 'location', '40000000-0000-0000-0000-000000000061', null, 'manual'); raise exception 'anon escribio procedencia'; exception when sqlstate '42501' then null; end;
  begin perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000d1', 'profile', '40000000-0000-0000-0000-000000000073', 'aprobado'); raise exception 'anon decidio'; exception when sqlstate '42501' then null; end;
  begin perform licitaciones.system_count_signer_powers_expiring('40000000-0000-0000-0000-0000000000d1', '2026-01-01', 30); raise exception 'anon conto poderes'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

\echo '--- 24. POSITIVO (sistema): el conteo de poderes por vencer cuenta solo aprobados, autorizados, con vigencia dentro de la ventana ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.company_signer (id, organization_id, name, role, authorized, valid_until) values
  ('40000000-0000-0000-0000-000000000091', '40000000-0000-0000-0000-0000000000d1', 'Vence pronto', 'rep', true, '2026-06-20'),
  ('40000000-0000-0000-0000-000000000092', '40000000-0000-0000-0000-0000000000d1', 'Vence lejos', 'rep', true, '2027-06-20'),
  ('40000000-0000-0000-0000-000000000093', '40000000-0000-0000-0000-0000000000d1', 'Ya vencio', 'rep', true, '2026-05-01'),
  ('40000000-0000-0000-0000-000000000094', '40000000-0000-0000-0000-0000000000d1', 'No autorizado', 'rep', false, '2026-06-20'),
  ('40000000-0000-0000-0000-000000000095', '40000000-0000-0000-0000-0000000000d1', 'Pendiente', 'rep', true, '2026-06-21');
update licitaciones.company_signer set approval_status = 'aprobado' where id in ('40000000-0000-0000-0000-000000000091', '40000000-0000-0000-0000-000000000092', '40000000-0000-0000-0000-000000000093', '40000000-0000-0000-0000-000000000094');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_count_signer_powers_expiring('40000000-0000-0000-0000-0000000000d1', '2026-06-01', 30) as poderes_por_vencer_deberia_ser_1;
rollback;

\echo '--- 25. NEGATIVO: una sesion de usuario no puede usar la funcion de sistema (42501); parametros invalidos 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
do $$ declare x text; begin
  begin
    perform licitaciones.system_count_signer_powers_expiring('40000000-0000-0000-0000-0000000000d1', '2026-06-01', 30);
    raise exception 'un usuario conto poderes por la funcion de sistema';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '', true) into x;
  begin
    perform licitaciones.system_count_signer_powers_expiring('40000000-0000-0000-0000-0000000000d1', '2026-06-01', 0);
    raise exception 'ventana invalida aceptada';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

\echo '--- 26. service_role conserva el acceso de mantenimiento a las tablas nuevas ---'
begin;
set local role service_role;
insert into licitaciones.company_profile (organization_id, legal_name, tax_id) values ('40000000-0000-0000-0000-0000000000d1', 'Sembrado', 'ACM010101AB1');
insert into licitaciones.field_provenance (organization_id, entity, entity_id, field, owner_user_id, source)
select '40000000-0000-0000-0000-0000000000d1', 'profile', id, '*', '40000000-0000-0000-0000-0000000000a1', 'importado' from licitaciones.company_profile where organization_id = '40000000-0000-0000-0000-0000000000d1';
select count(*) as service_role_deberia_ser_1 from licitaciones.field_provenance where source = 'importado';
rollback;

\echo '--- 27. REGRESION: la aprobacion de los tipos anteriores sigue igual (tarifa: analyst no, admin si) y el firmante previo sigue legible sin vigencia ---'
begin;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.approved_rate (id, organization_id, concept, unit_price, valid_from) values ('40000000-0000-0000-0000-0000000000a9', '40000000-0000-0000-0000-0000000000d1', 'tarifa_regresion', 7.00, '2026-01-01');
set local role authenticated;
do $$ declare r text; x text; v date; begin
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a2', true) into x;
  begin
    perform licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000d1', 'rate', '40000000-0000-0000-0000-0000000000a9', 'aprobado');
    raise exception 'el analyst aprobo una tarifa';
  exception when sqlstate '42501' then null;
  end;
  select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a4', true) into x;
  r := licitaciones.decide_company_item('40000000-0000-0000-0000-0000000000a4', '40000000-0000-0000-0000-0000000000d1', 'rate', '40000000-0000-0000-0000-0000000000a9', 'aprobado');
  if r <> 'ok' then raise exception 'el admin debia aprobar la tarifa: %', r; end if;
  select valid_until into v from licitaciones.company_signer where id = '40000000-0000-0000-0000-000000000051';
  if v is not null then raise exception 'el firmante previo no debia tener vigencia'; end if;
end $$;
rollback;

\echo '--- 28. MAPEOS: el CHECK de requirement_fulfillment_mapping admite los tipos del perfil (owner) y sigue rechazando cualquier otro (23514); el writer no mapea (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template) values ('40000000-0000-0000-0000-0000000000d1', 'acta', 'stakeholders', 'socios', 'Socios: {value}');
  insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template) values ('40000000-0000-0000-0000-0000000000d1', 'perfil', 'profile', 'general', '{value}');
  insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template) values ('40000000-0000-0000-0000-0000000000d1', 'firma', 'signer', 'rep', '{value}');
  begin
    insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template) values ('40000000-0000-0000-0000-0000000000d1', 'otro', 'inventado', 'x', '{value}');
    raise exception 'tipo inventado aceptado';
  exception when sqlstate '23514' then null;
  end;
  perform set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-0000000000a3', true);
  begin
    insert into licitaciones.requirement_fulfillment_mapping (organization_id, topic_key, kind, ref_key, statement_template) values ('40000000-0000-0000-0000-0000000000d1', 'escritor', 'locations', 'x', '{value}');
    raise exception 'el writer mapeo un requisito';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo ''
\echo 'Fin: cada escenario debe terminar sin error (los negativos verifican su SQLSTATE con DO ... raise exception) o con el valor deberia_ser_N.'
