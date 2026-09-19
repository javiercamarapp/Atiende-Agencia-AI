-- Fixtures + assertions que verifican, contra Postgres REAL, los recorridos de
-- STAFF AUTENTICADO (sesión con `auth.uid()` real + membership real) de
-- rentas (statement de propietario + payout/conciliación) + despachos (cierre
-- mensual + cartera de cobranza) + licitaciones (decisión go/no-go + aprobación
-- de documento de empresa) — las 3 verticales que
-- scripts/verify-flujos-staff/ (Parte 1, PR #151) dejó pendientes, en el mismo
-- orden de prioridad que su propio README documentó (rentas = dinero real de
-- terceros primero) — más el endurecimiento pendiente de #151 sobre
-- `hoteles.availability` (GRANT UPDATE de tabla completa -> columna).
--
-- Mismo patrón EXACTO que scripts/verify-flujos-staff/assertions.sql — léase
-- ese archivo primero (methodology note sobre CTEs de escritura encadenadas
-- incluida). Cada escenario vive en su propio `begin; ... rollback;`, nada de
-- esta sección persiste salvo los fixtures (corren fuera de una transacción,
-- como superusuario, bypass RLS). `-- as should_fail` dentro de un bloque
-- marca escenarios cuya sentencia objetivo (típicamente un INSERT sin
-- RETURNING) no admite alias de columna.
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
\set ON_ERROR_STOP off
\pset pager off

-- =============================================================================
-- Fixtures (persisten — corren como postgres, bypass RLS).
-- =============================================================================

-- ---- RENTAS: organización A (ejercitada de punta a punta) + B (cross-tenant) ----
insert into core.organization (id, vertical, name, slug, status) values
  ('90000000-0000-0000-0000-000000000001', 'rentas', 'Rentas Flujos Staff2 A', 'flujos-staff2-rentas-a', 'active'),
  ('90000000-0000-0000-0000-000000000002', 'rentas', 'Rentas Flujos Staff2 B', 'flujos-staff2-rentas-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('90000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-000000000001', 'rentas', 'Property A1', 'active'),
  ('90000000-0000-0000-0000-0000000000b1', '90000000-0000-0000-0000-000000000002', 'rentas', 'Property B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('90000000-0000-0000-0000-0000000f0a01', 'admin-gestora-a@flujos-staff2-rentas.example.test', 'Admin Gestora A', 'seed'),
  ('90000000-0000-0000-0000-0000000f0b01', 'admin-gestora-b@flujos-staff2-rentas.example.test', 'Admin Gestora B', 'seed'),
  ('90000000-0000-0000-0000-0000000f0a02', 'contador-a@flujos-staff2-rentas.example.test', 'Contador A', 'seed'),
  ('90000000-0000-0000-0000-0000000f0c01', 'sin-acceso-a@flujos-staff2-rentas.example.test', 'Sin Acceso A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('90000000-0000-0000-0000-0000000f0a01', '90000000-0000-0000-0000-000000000001', null, 'owner', 'admin_gestora'),
  ('90000000-0000-0000-0000-0000000f0b01', '90000000-0000-0000-0000-000000000002', null, 'owner', 'admin_gestora'),
  ('90000000-0000-0000-0000-0000000f0a02', '90000000-0000-0000-0000-000000000001', null, 'viewer', 'contador'),
  -- property_ids apunta SOLO a una property que no existe en estos fixtures -- este
  -- staff SÍ es miembro real de la organización A (incluso con vertical_role
  -- admin_gestora), pero `rentas.can_write_finanzas`/`can_read_finanzas` (que exigen
  -- `core.has_property_access`-equivalente por property_ids) deben rechazarlo para
  -- la property A1 -- mismo patrón exacto que Parte 1.
  ('90000000-0000-0000-0000-0000000f0c01', '90000000-0000-0000-0000-000000000001',
   array['90000000-0000-0000-0000-0000000000c1']::uuid[], 'member', 'admin_gestora')
on conflict do nothing;

-- Propietario real (rentas.owner, NUNCA staff -- ver packages/domain-rentas/migrations/001)
-- con una unidad en property A1.
insert into rentas.owner (id, name, email) values
  ('90000000-0000-0000-0000-0000000d0a01', 'Propietario Flujos Staff2 A', 'propietario-a@flujos-staff2-rentas.example.test')
on conflict do nothing;
insert into rentas.owner_organization (owner_id, organization_id) values
  ('90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-000000000001')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, owner_id, name) values
  ('90000000-0000-0000-0000-0000000c0a01', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000d0a01', 'Unidad Flujos Staff2 A1')
on conflict do nothing;

-- Una reserva real (capa='reserva') con su movimiento financiero (Flujo 3, Fase 1)
-- ya registrado -- es lo que `findMovimientosPeriodoParaOwner`/
-- `findCandidatasConciliacion` leen para armar el statement/conciliar el payout.
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, canal_origen_id, external_id, estado) values
  ('90000000-0000-0000-0000-0000000e0a01', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000c0a01',
   daterange('2026-11-01', '2026-11-05', '[)'), 'reserva', 'RESERVA_CANAL', (select id from rentas.canal where codigo = 'airbnb'), 'EXT-FLUJOS-STAFF2-1', 'confirmado')
on conflict do nothing;
insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, monto_recibido_centavos) values
  ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000e0a01', 'MXN', 500000, 50000, 40000, 0, 0, 410000, 500000)
on conflict do nothing;

-- Un owner_statement YA persistido (periodo octubre, para no chocar con el periodo
-- noviembre que ejercitan los escenarios de escritura de abajo) -- para los
-- escenarios de LECTURA (contador, cross-tenant, anon) que necesitan una fila real
-- ya confirmada, sin depender de que un escenario anterior haya insertado algo (cada
-- bloque es autocontenido, mismo criterio que Parte 1).
insert into rentas.owner_statement (id, organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, generado_por) values
  ('90000000-0000-0000-0000-000000090001', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000000a1', '2026-10-01', '2026-10-31', 1, 'MXN', 480000, 48000, 38000, 0, 0, 394000, 'hash-fixture-flujos-staff2-1', '90000000-0000-0000-0000-0000000f0a01')
on conflict do nothing;

-- Un payout YA persistido (mismo criterio -- fixture de lectura).
insert into rentas.payout_canal (id, organization_id, property_id, canal_id, referencia_externa, moneda, monto_total_centavos, fecha_payout, creado_por) values
  ('90000000-0000-0000-0000-000000090002', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', (select id from rentas.canal where codigo = 'airbnb'), 'REF-FIXTURE-FLUJOS-STAFF2', 'MXN', 450000, '2026-10-15', '90000000-0000-0000-0000-0000000f0a01')
on conflict do nothing;
insert into rentas.payout_linea (payout_id, ocupacion_id, referencia_externa_reserva, monto_centavos, monto_esperado_centavos, estado_conciliacion) values
  ('90000000-0000-0000-0000-000000090002', '90000000-0000-0000-0000-0000000e0a01', 'EXT-FIXTURE-1', 450000, 500000, 'discrepancia')
on conflict do nothing;

-- ---- DESPACHOS: organización A (ejercitada de punta a punta) + B (cross-tenant) ----
insert into core.organization (id, vertical, name, slug, status) values
  ('92000000-0000-0000-0000-000000000001', 'despachos', 'Despacho Flujos Staff2 A', 'flujos-staff2-desp-a', 'active'),
  ('92000000-0000-0000-0000-000000000002', 'despachos', 'Despacho Flujos Staff2 B', 'flujos-staff2-desp-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-000000000001', 'despachos', 'Property A1', 'active'),
  ('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-000000000002', 'despachos', 'Property B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('92000000-0000-0000-0000-0000000f0a01', 'admin-a@flujos-staff2-despachos.example.test', 'Admin A', 'seed'),
  ('92000000-0000-0000-0000-0000000f0b01', 'admin-b@flujos-staff2-despachos.example.test', 'Admin B', 'seed'),
  ('92000000-0000-0000-0000-0000000f0c01', 'sin-acceso-a@flujos-staff2-despachos.example.test', 'Sin Acceso A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('92000000-0000-0000-0000-0000000f0a01', '92000000-0000-0000-0000-000000000001', null, 'owner', 'admin'),
  ('92000000-0000-0000-0000-0000000f0b01', '92000000-0000-0000-0000-000000000002', null, 'owner', 'admin'),
  -- Mismo patrón que rentas/hoteles arriba: membership real de la organización A,
  -- property_ids acotado a una property que no existe -- `core.has_property_access`
  -- (la única condición real de las policies de despachos.periodo_cierre*/receivable)
  -- debe rechazarlo para la property A1.
  ('92000000-0000-0000-0000-0000000f0c01', '92000000-0000-0000-0000-000000000001',
   array['92000000-0000-0000-0000-0000000000c1']::uuid[], 'member', 'admin')
on conflict do nothing;

-- Un CFDI real ya ingestado (flujo 1, Fase 1) -- es la FK que
-- `despachos.receivable` requiere para "arrancar el reloj de cobranza" sobre él
-- (ver comentario de cabecera de migrations/004_cobranza_schema.sql).
-- Dos invoices: la primera (...i0a01) ya tiene fixture de receivable (abajo, para
-- los escenarios de LECTURA de cartera); la segunda (...i0a02) queda SIN receivable
-- todavía, para los escenarios de ESCRITURA (22/24) -- `despachos.receivable` tiene
-- `unique (invoice_id)`, así que un segundo intento de "arrancar el reloj de
-- cobranza" sobre el MISMO invoice de la fixture de lectura chocaría con esa unique
-- (y produciría 0 filas via `on conflict do nothing`, no el "1" que el escenario
-- espera) -- mismo criterio que Parte 1 usa ids literales distintos por escenario
-- para no chocar entre bloques que de otro modo compartirían fixtures.
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido) values
  ('92000000-0000-0000-0000-0000000f9a01', '92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-0000000ff0a1', 'I', 'AAA010101AA1', 'BBB020202BB2', 1000.00, 1160.00, 160.00, true),
  ('92000000-0000-0000-0000-0000000f9a02', '92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-0000000ff0a2', 'I', 'AAA010101AA1', 'BBB020202BB2', 2000.00, 2320.00, 320.00, true)
on conflict do nothing;

-- Un período de cierre YA abierto (mes distinto al que ejercitan los escenarios de
-- escritura de abajo, para no chocar con el `unique (property_id, anio, mes)`) --
-- fixture de lectura/actualización (completar tarea, cerrar, cross-tenant).
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes, status) values
  ('92000000-0000-0000-0000-000000090001', '92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', 2026, 9, 'open')
on conflict do nothing;
insert into despachos.periodo_cierre_tarea (id, periodo_cierre_id, template_key, title, description, category, status, required) values
  ('92000000-0000-0000-0000-000000090002', '92000000-0000-0000-0000-000000090001', 'cfdi_completo', 'CFDI completo', 'Verificar CFDI del período', 'cfdi', 'pending', true)
on conflict do nothing;

-- Una cuenta por cobrar (receivable) YA registrada y pendiente -- fixture de
-- lectura de cartera.
insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento) values
  ('92000000-0000-0000-0000-000000090003', '92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-0000000f9a01', '2026-11-30')
on conflict do nothing;

-- ---- LICITACIONES: organización A (ejercitada de punta a punta) + B (cross-tenant) ----
-- NUNCA usa core.property para particionar datos de negocio (ver comentario de
-- cabecera de packages/domain-licitaciones/migrations/001_licitaciones_schema.sql:
-- "una organización de licitaciones opera como una sola Property implícita") -- las
-- policies RLS de este vertical filtran SOLO por organization_id
-- (`can_access_org`/`can_write_org`/`can_decide_org`/`can_go_no_go_org`), así que
-- estos fixtures no necesitan ninguna fila de core.property.
insert into core.organization (id, vertical, name, slug, status) values
  ('94000000-0000-0000-0000-000000000001', 'licitaciones', 'Licitaciones Flujos Staff2 A', 'flujos-staff2-lic-a', 'active'),
  ('94000000-0000-0000-0000-000000000002', 'licitaciones', 'Licitaciones Flujos Staff2 B', 'flujos-staff2-lic-b', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('94000000-0000-0000-0000-0000000f0a01', 'owner-a@flujos-staff2-lic.example.test', 'Owner A', 'seed'),
  ('94000000-0000-0000-0000-0000000f0a02', 'writer-a@flujos-staff2-lic.example.test', 'Writer A', 'seed'),
  ('94000000-0000-0000-0000-0000000f0a03', 'viewer-a@flujos-staff2-lic.example.test', 'Viewer A', 'seed'),
  ('94000000-0000-0000-0000-0000000f0b01', 'owner-b@flujos-staff2-lic.example.test', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('94000000-0000-0000-0000-0000000f0a01', '94000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('94000000-0000-0000-0000-0000000f0a02', '94000000-0000-0000-0000-000000000001', null, 'member', 'writer'),
  ('94000000-0000-0000-0000-0000000f0a03', '94000000-0000-0000-0000-000000000001', null, 'viewer', 'viewer'),
  ('94000000-0000-0000-0000-0000000f0b01', '94000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title, submission_deadline) values
  ('94000000-0000-0000-0000-0000000e0a01', '94000000-0000-0000-0000-000000000001', 'Licitación Flujos Staff2 A', '2027-01-15T12:00:00-06')
on conflict do nothing;

-- Una decisión go/no-go YA registrada -- fixture de lectura (cross-tenant, anon).
insert into licitaciones.go_no_go_decision (id, organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by) values
  ('94000000-0000-0000-0000-000000090001', '94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-0000000e0a01', 'go', array['fixture de lectura flujos staff2'], 0.75, 'cumple', 'hash-fixture-godecision', '94000000-0000-0000-0000-0000000f0a01')
on conflict do nothing;

-- Un documento de empresa YA registrado -- fixture de lectura.
insert into licitaciones.company_document (id, organization_id, document_type, label, approval_status) values
  ('94000000-0000-0000-0000-000000090002', '94000000-0000-0000-0000-000000000001', 'constancia_situacion_fiscal', 'Constancia fixture flujos staff2', 'pendiente_aprobacion')
on conflict do nothing;

-- =============================================================================
-- RENTAS — statement de propietario + payout/conciliación (prioridad #1: dinero
-- real de terceros).
-- =============================================================================

\echo '=== 1. admin_gestora genera el owner statement de octubre->noviembre (insert owner_statement + owner_statement_linea) -- ejercita exactamente la sentencia que repo.insertOwnerStatement emite ==='
-- NOTA (mismo gotcha documentado en scripts/verify-flujos-staff/README.md, sección
-- "Nota de metodología"): `repo.insertOwnerStatement` hace DOS awaits SEPARADOS
-- (insert owner_statement, LUEGO un insert owner_statement_linea por línea) --
-- nunca un `with nuevo as (insert ...) insert ... select ... from nuevo` combinado.
-- Combinarlos aquí produce un falso "ERROR: new row violates row-level security
-- policy for table owner_statement_linea": el WITH CHECK de la policy de INSERT de
-- owner_statement_linea hace su PROPIO `exists (select 1 from rentas.owner_statement
-- os where os.id = ...)` -- un re-escaneo de la tabla base que el CTE hermana acaba
-- de insertar DENTRO DE LA MISMA sentencia, que Postgres no garantiza ver (el mismo
-- patrón que el README de Parte 1 ya documentó para UPDATE/SELECT, aquí aplica
-- también a un WITH CHECK de RLS). Se usa un id literal + 2 sentencias TOP-LEVEL
-- separadas, igual que el código real.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a01', true);
insert into rentas.owner_statement (id, organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, generado_por)
values ('90000000-0000-0000-0000-000000010001', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000000a1', '2026-11-01', '2026-11-30', 1, 'MXN', 500000, 50000, 40000, 0, 0, 410000, 'hash-flujos-staff2-escenario1', '90000000-0000-0000-0000-0000000f0a01');
insert into rentas.owner_statement_linea (statement_id, ocupacion_id, tipo, descripcion, monto_centavos, moneda)
values ('90000000-0000-0000-0000-000000010001', '90000000-0000-0000-0000-0000000e0a01', 'ingreso', 'Ingreso reserva flujos staff2', 500000, 'MXN')
returning (statement_id is not null)::int as staff_genera_owner_statement_deberia_ser_1;
rollback;

\echo '=== 2. contador (FINANZAS_LECTURA_ROLES) lee los statements ya persistidos de su property ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a02', true);
select count(*)::int as contador_lee_statements_deberia_ser_1
  from rentas.owner_statement where property_id = '90000000-0000-0000-0000-0000000000a1' and owner_id = '90000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '=== 3. (rol sin permiso) contador NO puede generar una versión nueva de statement -- rentas.can_write_finanzas exige vertical_role=admin_gestora, contador queda fuera ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a02', true);
insert into rentas.owner_statement (organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, generado_por)
values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000000a1', '2026-11-01', '2026-11-30', 2, 'MXN', 0, 0, 0, 0, 0, 0, 'hash-contador-intento', '90000000-0000-0000-0000-0000000f0a02');
rollback;

\echo '=== 4. (rol sin permiso, property) staff admin_gestora SIN acceso a property A1 (membership real, property_ids no la cubre) NO puede generar un statement ahí ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0c01', true);
insert into rentas.owner_statement (organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, generado_por)
values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000000a1', '2026-12-01', '2026-12-31', 1, 'MXN', 0, 0, 0, 0, 0, 0, 'hash-sin-acceso-intento', '90000000-0000-0000-0000-0000000f0c01');
rollback;

\echo '=== 5. (cross-tenant) staff real de la organización B NO ve los statements de la property A1 de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_statement_deberia_ser_0
  from rentas.owner_statement where property_id = '90000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 6. (cross-tenant) staff real de la organización B NO puede insertar un statement sobre la property A1 (ajena) ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0b01', true);
insert into rentas.owner_statement (organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, generado_por)
values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000000a1', '2026-12-01', '2026-12-31', 1, 'MXN', 0, 0, 0, 0, 0, 0, 'hash-cross-tenant-intento', '90000000-0000-0000-0000-0000000f0b01');
rollback;

\echo '=== 7. anon NO puede leer statements (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from rentas.owner_statement limit 1;
rollback;

\echo '=== 8. admin_gestora importa un payout de canal + concilia sus líneas (insert payout_canal + payout_linea, repo.insertPayout) ==='
-- Mismo gotcha que el escenario 1 (`repo.insertPayout` también hace 2 awaits
-- separados: insert payout_canal, LUEGO un insert payout_linea por línea) -- id
-- literal + 2 sentencias TOP-LEVEL, nunca un WITH combinado (ver comentario del
-- escenario 1 para el porqué completo).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a01', true);
insert into rentas.payout_canal (id, organization_id, property_id, canal_id, referencia_externa, moneda, monto_total_centavos, fecha_payout, creado_por)
values ('90000000-0000-0000-0000-000000010002', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', (select id from rentas.canal where codigo = 'airbnb'), 'REF-FLUJOS-STAFF2-ESCENARIO8', 'MXN', 450000, '2026-11-10', '90000000-0000-0000-0000-0000000f0a01');
insert into rentas.payout_linea (payout_id, ocupacion_id, referencia_externa_reserva, monto_centavos, monto_esperado_centavos, estado_conciliacion)
values ('90000000-0000-0000-0000-000000010002', '90000000-0000-0000-0000-0000000e0a01', 'EXT-REF-ESCENARIO8', 450000, 500000, 'discrepancia')
returning (payout_id is not null)::int as staff_importa_payout_deberia_ser_1;
rollback;

\echo '=== 9. staff lee el detalle del payout ya persistido (findPayoutDetalle: join payout_canal+canal, y sus líneas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a01', true);
select (pc.id is not null)::int as staff_lee_detalle_payout_deberia_ser_1
  from rentas.payout_canal pc join rentas.canal c on c.id = pc.canal_id
  where pc.id = '90000000-0000-0000-0000-000000090002' and pc.property_id = '90000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 10. (rol sin permiso) contador NO puede importar un payout -- FINANZAS_ESCRITURA_ROLES es solo admin_gestora ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a02', true);
insert into rentas.payout_canal (organization_id, property_id, canal_id, moneda, monto_total_centavos, fecha_payout, creado_por)
values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', (select id from rentas.canal where codigo = 'airbnb'), 'MXN', 1, '2026-11-11', '90000000-0000-0000-0000-0000000f0a02');
rollback;

\echo '=== 11. (cross-tenant) staff real de la organización B NO ve el payout de la property A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_payout_deberia_ser_0
  from rentas.payout_canal where property_id = '90000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 12. anon NO puede leer payouts (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from rentas.payout_canal limit 1;
rollback;

\echo '=== 13. admin_gestora lee los movimientos financieros del período para el owner (findMovimientosPeriodoParaOwner -- join reserva_financiero+ocupacion+unidad) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_lee_movimientos_periodo_deberia_ser_1
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  where o.property_id = '90000000-0000-0000-0000-0000000000a1' and u.owner_id = '90000000-0000-0000-0000-0000000d0a01' and o.estado <> 'cancelado'
    and upper(o.rango) >= '2026-11-01'::date and upper(o.rango) < '2026-11-30'::date;
rollback;

\echo '=== 14. admin_gestora encuentra al propietario con unidades en su property (findOwnerConUnidadesEnProperty) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-0000000f0a01', true);
select (o.id is not null)::int as staff_encuentra_owner_en_property_deberia_ser_1
  from rentas.owner o
  where o.id = '90000000-0000-0000-0000-0000000d0a01' and exists (select 1 from rentas.unidad u where u.property_id = '90000000-0000-0000-0000-0000000000a1' and u.owner_id = o.id)
  limit 1;
rollback;

-- =============================================================================
-- DESPACHOS — cierre mensual + cartera de cobranza (prioridad #2).
-- =============================================================================

\echo '=== 15. admin abre un período de cierre nuevo con su checklist (repo.insertPeriodoCierre: insert periodo_cierre + periodo_cierre_tarea) ==='
-- Mismo gotcha que el escenario 1 de rentas (`repo.insertPeriodoCierre` hace un
-- await del INSERT de periodo_cierre, LUEGO un await por cada tarea de la plantilla
-- -- nunca un WITH combinado). Id literal + 2 sentencias TOP-LEVEL: el WITH CHECK de
-- la policy de INSERT de periodo_cierre_tarea (`exists (select 1 from
-- despachos.periodo_cierre p where p.id = ...)`) re-escanearía la tabla que el CTE
-- hermana acaba de insertar dentro de la MISMA sentencia -- ver comentario del
-- escenario 1 de rentas para el porqué completo.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0a01', true);
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes)
values ('92000000-0000-0000-0000-000000010001', '92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', 2026, 11);
insert into despachos.periodo_cierre_tarea (periodo_cierre_id, template_key, title, description, category, status, required)
values ('92000000-0000-0000-0000-000000010001', 'cfdi_completo', 'CFDI completo', 'Verificar CFDI del período', 'cfdi', 'pending', true)
returning (periodo_cierre_id is not null)::int as staff_abre_periodo_cierre_deberia_ser_1;
rollback;

\echo '=== 16. staff completa una tarea del checklist ya persistido (repo.replaceTareasCierre) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0a01', true);
update despachos.periodo_cierre_tarea set status = 'done', completed_at = now(), completed_by = '92000000-0000-0000-0000-0000000f0a01'
where id = '92000000-0000-0000-0000-000000090002' and periodo_cierre_id = '92000000-0000-0000-0000-000000090001'
returning (status = 'done')::int as staff_completa_tarea_cierre_deberia_ser_1;
rollback;

\echo '=== 17. admin cierra el período (repo.updatePeriodoCierre, status=closed) -- CERRAR_PERIODO_ROLES=["admin"] ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0a01', true);
update despachos.periodo_cierre set status = 'closed', closed_at = now(), closed_by = '92000000-0000-0000-0000-0000000f0a01'
where id = '92000000-0000-0000-0000-000000090001'
returning (status = 'closed')::int as staff_cierra_periodo_deberia_ser_1;
rollback;

\echo '=== 18. (rol sin permiso) staff de la organización A SIN acceso a la property A1 NO puede abrir un período ahí (core.has_property_access lo rechaza) ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0c01', true);
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes) values ('92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', 2027, 1);
rollback;

\echo '=== 19. (cross-tenant) staff real de la organización B NO ve el período de cierre de la property A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_periodo_deberia_ser_0
  from despachos.periodo_cierre where property_id = '92000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 20. (cross-tenant) staff real de la organización B NO puede cerrar el período de la property A1 -- 0 filas, sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0b01', true);
update despachos.periodo_cierre set status = 'closed' where id = '92000000-0000-0000-0000-000000090001' and status = 'open';
-- `reset role` (bypass RLS) SOLO para verificar el estado resultante -- staff B no
-- tiene policy de SELECT que le deje ver este período de la organización A, así que
-- sin esto la cuenta daría 0 por invisibilidad, no por confirmar que el UPDATE de
-- arriba en verdad no tocó nada. Mismo patrón que Parte 1.
reset role;
select count(*)::int as periodo_ajeno_sigue_open_deberia_ser_1
  from despachos.periodo_cierre where id = '92000000-0000-0000-0000-000000090001' and status = 'open';
rollback;

\echo '=== 21. anon NO puede leer períodos de cierre (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from despachos.periodo_cierre limit 1;
rollback;

\echo '=== 22. admin registra una cuenta por cobrar real sobre un CFDI ya ingestado (repo.registerReceivable) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0a01', true);
insert into despachos.receivable (organization_id, property_id, invoice_id, fecha_vencimiento, cliente_nombre, cliente_email)
values ('92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-0000000f9a02', '2026-12-15', 'Cliente Flujos Staff2', 'cliente@flujos-staff2-despachos.example.test')
returning (id is not null)::int as staff_registra_receivable_deberia_ser_1;
rollback;

\echo '=== 23. admin lista la cartera pendiente (pagado_en is null) de su property (repo.listReceivables) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_lista_cartera_pendiente_deberia_ser_1
  from despachos.receivable where property_id = '92000000-0000-0000-0000-0000000000a1' and pagado_en is null;
rollback;

\echo '=== 24. (rol sin permiso) staff de la organización A SIN acceso a la property A1 NO puede registrar una cuenta por cobrar ahí ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0c01', true);
insert into despachos.receivable (organization_id, property_id, invoice_id, fecha_vencimiento)
values ('92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000a1', '92000000-0000-0000-0000-0000000f9a02', '2026-12-20');
rollback;

\echo '=== 25. (cross-tenant) staff real de la organización B NO ve la cartera de la property A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_cartera_deberia_ser_0
  from despachos.receivable where property_id = '92000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 26. anon NO puede leer la cartera de cobranza (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from despachos.receivable limit 1;
rollback;

-- =============================================================================
-- LICITACIONES — decisión go/no-go + aprobación de documento de empresa
-- (prioridad #3: menor riesgo de dinero directo).
-- =============================================================================

\echo '=== 27. owner (GO_NO_GO_ROLES) registra una decisión "go" y la MISMA operación actualiza tender.status (repo.createGoNoGoDecision) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a01', true);
insert into licitaciones.go_no_go_decision (organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by)
values ('94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-0000000e0a01', 'go', array['cumple requisitos flujos staff2'], 0.82, 'cumple', 'hash-go-flujos-staff2-escenario27', '94000000-0000-0000-0000-0000000f0a01');
update licitaciones.tender set status = 'go', updated_at = now()
where id = '94000000-0000-0000-0000-0000000e0a01' and organization_id = '94000000-0000-0000-0000-000000000001'
returning (status = 'go')::int as staff_decide_go_actualiza_tender_deberia_ser_1;
rollback;

\echo '=== 28. (rol sin permiso) viewer NO puede registrar una decisión go/no-go -- licitaciones.can_go_no_go_org exige owner/admin/analyst/reviewer ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a03', true);
insert into licitaciones.go_no_go_decision (organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by)
values ('94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-0000000e0a01', 'go', array['viewer intenta decidir'], 0.5, 'cumple', 'hash-viewer-intento', '94000000-0000-0000-0000-0000000f0a03');
rollback;

\echo '=== 29. (rol sin permiso) writer TAMPOCO puede decidir -- writer SÍ está en WRITE_ROLES (puede redactar) pero NO en GO_NO_GO_ROLES (decidir es más estricto que escribir) ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a02', true);
insert into licitaciones.go_no_go_decision (organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by)
values ('94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-0000000e0a01', 'go', array['writer intenta decidir'], 0.5, 'cumple', 'hash-writer-intento', '94000000-0000-0000-0000-0000000f0a02');
rollback;

\echo '=== 30. (cross-tenant) staff real de la organización B NO ve las decisiones go/no-go de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_decision_deberia_ser_0
  from licitaciones.go_no_go_decision where organization_id = '94000000-0000-0000-0000-000000000001';
rollback;

\echo '=== 31. anon NO puede leer decisiones go/no-go (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from licitaciones.go_no_go_decision limit 1;
rollback;

\echo '=== 32. writer (WRITE_ROLES) captura un documento de empresa nuevo (repo insertCompanyDocument, companyData.ts POST) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a02', true);
insert into licitaciones.company_document (organization_id, document_type, label, approval_status)
values ('94000000-0000-0000-0000-000000000001', 'opinion_cumplimiento', 'Opinión de cumplimiento flujos staff2', 'pendiente_aprobacion')
returning (id is not null)::int as staff_captura_documento_empresa_deberia_ser_1;
rollback;

\echo '=== 33. writer APRUEBA el documento de empresa ya persistido (PATCH .../company/documents/:id, approvalStatus="aprobado") ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a02', true);
update licitaciones.company_document set approval_status = 'aprobado'
where id = '94000000-0000-0000-0000-000000090002' and organization_id = '94000000-0000-0000-0000-000000000001'
returning (approval_status = 'aprobado')::int as staff_aprueba_documento_empresa_deberia_ser_1;
rollback;

\echo '=== 34. (rol sin permiso) viewer NO puede capturar un documento de empresa -- licitaciones.can_write_org excluye viewer ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0a03', true);
insert into licitaciones.company_document (organization_id, document_type, label, approval_status)
values ('94000000-0000-0000-0000-000000000001', 'opinion_cumplimiento', 'Intento de viewer', 'pendiente_aprobacion');
rollback;

\echo '=== 35. (cross-tenant) staff real de la organización B NO ve los documentos de empresa de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '94000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_documento_empresa_deberia_ser_0
  from licitaciones.company_document where organization_id = '94000000-0000-0000-0000-000000000001';
rollback;

\echo '=== 36. anon NO puede leer documentos de empresa (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from licitaciones.company_document limit 1;
rollback;

-- =============================================================================
-- ENDURECIMIENTO PENDIENTE DE #151 — hoteles.availability, GRANT UPDATE de tabla
-- completa -> columna (packages/domain-hoteles/migrations/
-- 026_availability_column_level_update_grant.sql). Reutiliza los MISMOS fixtures
-- de hoteles que scripts/verify-flujos-staff/assertions.sql ya siembra en esta
-- misma base de datos (este script corre DESPUÉS, en la misma conexión de
-- fixtures) -- NO: cada verify-*/ corre en su PROPIA base de datos efímera (ver
-- run.sh/run-gate.mjs), así que este archivo siembra su PROPIO fixture mínimo de
-- hoteles, independiente del de Parte 1.
-- =============================================================================

insert into core.organization (id, vertical, name, slug, status) values
  ('96000000-0000-0000-0000-000000000001', 'hoteles', 'Hotel Flujos Staff2 A', 'flujos-staff2-hotel-a', 'active'),
  ('96000000-0000-0000-0000-000000000002', 'hoteles', 'Hotel Flujos Staff2 B', 'flujos-staff2-hotel-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('96000000-0000-0000-0000-0000000000a1', '96000000-0000-0000-0000-000000000001', 'hoteles', 'Property A1', 'active'),
  ('96000000-0000-0000-0000-0000000000b1', '96000000-0000-0000-0000-000000000002', 'hoteles', 'Property B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('96000000-0000-0000-0000-0000000f0a01', 'owner-a@flujos-staff2-hoteles.example.test', 'Owner A', 'seed'),
  ('96000000-0000-0000-0000-0000000f0b01', 'owner-b@flujos-staff2-hoteles.example.test', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('96000000-0000-0000-0000-0000000f0a01', '96000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('96000000-0000-0000-0000-0000000f0b01', '96000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('96000000-0000-0000-0000-0000000c0a01', '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-0000000000a1', 'Estándar')
on conflict do nothing;

insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms) values
  ('96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-0000000000a1', '96000000-0000-0000-0000-0000000c0a01', '2026-12-01', 10, 0)
on conflict do nothing;

\echo '=== 37. (regresión) staff con acceso a la property SIGUE pudiendo reservar disponibilidad vía book_availability() tras acotar el GRANT a columna ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-0000-0000-0000000f0a01', true);
select (booked_rooms = 1)::int as book_availability_sigue_funcionando_deberia_ser_1
  from hoteles.book_availability('96000000-0000-0000-0000-0000000000a1', '96000000-0000-0000-0000-0000000c0a01', '2026-12-01', 1);
rollback;

\echo '=== 38. (regresión) staff con acceso a la property SIGUE pudiendo liberar disponibilidad vía release_availability() tras acotar el GRANT a columna ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-0000-0000-0000000f0a01', true);
select * from hoteles.book_availability('96000000-0000-0000-0000-0000000000a1', '96000000-0000-0000-0000-0000000c0a01', '2026-12-01', 1);
select (booked_rooms = 0)::int as release_availability_sigue_funcionando_deberia_ser_1
  from hoteles.release_availability('96000000-0000-0000-0000-0000000000a1', '96000000-0000-0000-0000-0000000c0a01', '2026-12-01', 1);
rollback;

\echo '=== 39. (el hallazgo real que este PR cierra) staff con acceso a la property YA NO puede hacer un UPDATE directo de total_rooms por PostgREST -- "permission denied for column total_rooms" ==='
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-0000-0000-0000000f0a01', true);
update hoteles.availability set total_rooms = 999
where property_id = '96000000-0000-0000-0000-0000000000a1' and room_type_id = '96000000-0000-0000-0000-0000000c0a01' and date = '2026-12-01';
rollback;

\echo '=== 40. (sin cambio) staff SIGUE pudiendo LEER (SELECT) la disponibilidad de su property -- este PR nunca tocó la policy/GRANT de SELECT ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_lee_disponibilidad_deberia_ser_1
  from hoteles.availability where property_id = '96000000-0000-0000-0000-0000000000a1' and date = '2026-12-01';
rollback;

\echo '=== 41. (cross-tenant, sin cambio) staff real de la organización B SIGUE sin poder actualizar disponibilidad de la property A1 (ajena) -- 0 filas, sin error (RLS de property, sin cambio con este PR) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-0000-0000-0000000f0b01', true);
update hoteles.availability set booked_rooms = 5
where property_id = '96000000-0000-0000-0000-0000000000a1' and room_type_id = '96000000-0000-0000-0000-0000000c0a01' and date = '2026-12-01';
-- `reset role` (bypass RLS) SOLO para verificar el estado resultante -- staff B no
-- tiene policy de SELECT que le deje ver esta fila de la property A1, así que sin
-- esto la cuenta daría 0 por invisibilidad, no por confirmar que el UPDATE de arriba
-- en verdad no tocó nada. Mismo patrón que Parte 1 (escenario 14) y el escenario 20
-- de este mismo archivo.
reset role;
select (booked_rooms = 0)::int as disponibilidad_ajena_sigue_sin_tocar_deberia_ser_1
  from hoteles.availability where property_id = '96000000-0000-0000-0000-0000000000a1' and room_type_id = '96000000-0000-0000-0000-0000000c0a01' and date = '2026-12-01';
rollback;

\echo '=== 42. (sin cambio) anon SIGUE sin acceso a disponibilidad (sin GRANT a anon, sin cambio con este PR) ==='
begin;
set local role anon;
select id as should_fail from hoteles.availability limit 1;
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
