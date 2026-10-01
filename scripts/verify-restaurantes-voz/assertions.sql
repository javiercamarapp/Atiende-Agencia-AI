-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna + funciones de
-- solo-sistema reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/025_voz_config_conversaciones.sql:
--
--   A. restaurantes.branch_voice_config: positivo (owner/admin), rol insuficiente (staff),
--      cross-tenant (otra organizacion / organizacion declarada ajena), GRANT por columna,
--      lectura (owner, sistema, staff sin acceso, otra organizacion), anon, CHECKs.
--   B. restaurantes.voice_preview_sessions: positivo, created_by ajeno, vigencia > 15 min,
--      rol insuficiente, cross-tenant, sin UPDATE directo, anon.
--   C. voice_conversation/voice_turn y funciones de solo-sistema: positivo, idempotencia,
--      staff autenticado rechazado (42501), anon rechazado, cross-tenant, costo/duracion
--      calculados por la base, escritura directa rechazada, lectura solo owner/admin.
--   D. voz_consumir_preview: consume una vez, expirada, cross-tenant, staff rechazado.
--   E. Base SIN migrar: el SQL real que emite el repositorio falla con 42P01/42883 y el
--      SAVEPOINT/ROLLBACK TO SAVEPOINT recupera la transaccion.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`:
-- un escenario "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0001', 'restaurantes', 'Voz Org A', 'voz-org-a'),
  ('00000000-0000-0000-0000-0000000d0002', 'restaurantes', 'Voz Org B (ajena)', 'voz-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'a1'),
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', 'a2'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0011', 'owner-a@voz.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0012', 'admin-a@voz.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0013', 'staff-a@voz.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0014', 'owner-b@voz.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000d0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0012', '00000000-0000-0000-0000-0000000d0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000d0013', '00000000-0000-0000-0000-0000000d0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0014', '00000000-0000-0000-0000-0000000d0002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items) values
  ('00000000-0000-0000-0000-0000000d00e1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'Cliente A', '9999000001', 100, '[]'::jsonb),
  ('00000000-0000-0000-0000-0000000d00e2', '00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00b1', 'Cliente B', '9999000002', 100, '[]'::jsonb)
on conflict do nothing;

-- Datos previos (insertados como superusuario): config de A2, dos conversaciones de A1
-- (una abierta con 2 turnos, otra ya cerrada) y dos sesiones de preview de A1.
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id, comportamiento, mensaje_inicial) values
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', true, 'gemini-3.8-live', 'Kore', 'Habla de usted.', 'Hola, le atiende el asistente virtual.')
on conflict do nothing;

insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at) values
  ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-a-1', 'llamada', 'gemini-3.8-live', 'Kore', now() - interval '5 minutes')
on conflict do nothing;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, resultado) values
  ('00000000-0000-0000-0000-0000000d00c2', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-a-2', 'llamada', 'gemini-3.8-live', 'Kore', now() - interval '10 minutes', now() - interval '8 minutes', 120, 'abandonado')
on conflict do nothing;
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto, latencia_ms, costo_estimado_micro_usd) values
  ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', 0, 'cliente', 'Quiero unos tacos', 400, 100),
  ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', 1, 'agente', 'Claro, con gusto', 900, 200)
on conflict do nothing;

insert into restaurantes.voice_preview_sessions (id, organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values
  ('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Kore', now(), now() + interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000d00f2', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Kore', now() - interval '2 hours', now() - interval '110 minutes')
on conflict do nothing;

\echo '=== A1. POSITIVO: owner de A crea la config de voz de su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', true, 'gemini-3.8-live', 'Puck') returning property_id, voice_id;
rollback;

\echo '=== A2. POSITIVO: admin de A actualiza (UPDATE por columna concedida) la config de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0012', true);
update restaurantes.branch_voice_config set voice_id = 'Charon', updated_at = now() where property_id = '00000000-0000-0000-0000-0000000d00a2' returning property_id, voice_id;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): staff de A (rol staff) no crea config de voz ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', true, 'gemini-3.8-live', 'Puck');
rollback;

\echo '=== A4. RECHAZADO (debe fallar): owner de B escribe para una property de A declarando SU organizacion ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0002', true, 'gemini-3.8-live', 'Puck');
rollback;

\echo '=== A5. RECHAZADO (debe fallar): owner de B declara la organizacion A (no es miembro de A) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', true, 'gemini-3.8-live', 'Puck');
rollback;

\echo '=== A6. CROSS-TENANT: owner de B no actualiza la config de A2 (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with actualizado as (
  update restaurantes.branch_voice_config set voice_id = 'Zephyr' where property_id = '00000000-0000-0000-0000-0000000d00a2' returning property_id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== A7. RECHAZADO (debe fallar): GRANT por columna -- ni el owner puede mover organization_id ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.branch_voice_config set organization_id = '00000000-0000-0000-0000-0000000d0002' where property_id = '00000000-0000-0000-0000-0000000d00a2' returning 1 as should_fail;
rollback;

\echo '=== A8. LECTURA: staff (rol staff) NO ve la config de voz (comportamiento/prompt es de owner/admin) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
select count(*)::int as filas_visibles_staff_sin_acceso_deberia_ser_0 from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
rollback;

\echo '=== A9. LECTURA: owner de A ve la config de su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select count(*)::int as filas_visibles_owner_deberia_ser_1 from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
rollback;

\echo '=== A10. LECTURA: sesion de SISTEMA (authenticated sin usuario, el servicio de voz) lee la config ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as filas_visibles_sistema_deberia_ser_1 from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
rollback;

\echo '=== A11. CROSS-TENANT LECTURA: owner de B ve 0 filas de la config de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select count(*)::int as filas_visibles_cross_tenant_deberia_ser_0 from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
rollback;

\echo '=== A12. RECHAZADO (debe fallar): anon no lee branch_voice_config ==='
begin;
set local role anon;
select * from restaurantes.branch_voice_config as should_fail;
rollback;

\echo '=== A13. RECHAZADO (debe fallar): anon no escribe branch_voice_config ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', true, 'gemini-3.8-live', 'Puck');
rollback;

\echo '=== A14. RECHAZADO (debe fallar): CHECK de proveedor fuera del catalogo ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, proveedor, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'otro-motor', 'Puck');
rollback;

\echo '=== A15. RECHAZADO (debe fallar): CHECK de voice_id vacio ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, voice_id) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', '');
rollback;

\echo '=== A16. RECHAZADO (debe fallar): CHECK de comportamiento > 8000 caracteres ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_voice_config (property_id, organization_id, voice_id, comportamiento) values ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'Puck', repeat('x', 8001));
rollback;

\echo '=== B1. POSITIVO: owner de A emite una sesion de preview (10 min) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Puck', now(), now() + interval '10 minutes') returning id, expires_at;
rollback;

\echo '=== B2. RECHAZADO (debe fallar): created_by de otro usuario ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0012', 'gemini-3.8-live', 'Puck', now(), now() + interval '10 minutes');
rollback;

\echo '=== B3. RECHAZADO (debe fallar): vigencia mayor a 15 minutos (CHECK) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Puck', now(), now() + interval '2 hours');
rollback;

\echo '=== B4. RECHAZADO (debe fallar): staff (rol staff) no emite previews ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0013', 'gemini-3.8-live', 'Puck', now(), now() + interval '10 minutes');
rollback;

\echo '=== B5. RECHAZADO (debe fallar): owner de B emite preview para una property de A declarando su organizacion ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0014', 'gemini-3.8-live', 'Puck', now(), now() + interval '10 minutes');
rollback;

\echo '=== B6. RECHAZADO (debe fallar): UPDATE directo de consumed_at (sin GRANT; solo voz_consumir_preview) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.voice_preview_sessions set consumed_at = now() where id = '00000000-0000-0000-0000-0000000d00f1' returning 1 as should_fail;
rollback;

\echo '=== B7. RECHAZADO (debe fallar): anon no emite previews ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Puck', now(), now() + interval '10 minutes');
rollback;

\echo '=== B8. CROSS-TENANT LECTURA: owner de B ve 0 sesiones de preview de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select count(*)::int as previews_visibles_cross_tenant_deberia_ser_0 from restaurantes.voice_preview_sessions;
rollback;

\echo '=== C1. POSITIVO + IDEMPOTENCIA: el sistema inicia una conversacion y el reintento con el mismo external_id devuelve la MISMA fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-nueva', 'llamada', 'gemini-3.8-live', 'Kore', repeat('a', 64), now());
select restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-nueva', 'llamada', 'gemini-3.8-live', 'Kore', repeat('a', 64), now());
-- el sistema no lee las tablas (solo owner/admin): se vuelve a superusuario para verificar el efecto
reset role;
select count(*)::int as conversaciones_tras_reintento_deberia_ser_1 from restaurantes.voice_conversation where external_id = 'sala-nueva';
rollback;

\echo '=== C2. RECHAZADO (debe fallar): un staff AUTENTICADO no puede iniciar conversaciones (funcion de solo-sistema, 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-staff', 'llamada', 'gemini-3.8-live', 'Kore', repeat('a', 64), now()) as should_fail;
rollback;

\echo '=== C3. RECHAZADO (debe fallar): anon no ejecuta la funcion ==='
begin;
set local role anon;
select restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'sala-anon', 'llamada', 'gemini-3.8-live', 'Kore', repeat('a', 64), now()) as should_fail;
rollback;

\echo '=== C4. CROSS-TENANT (debe fallar): el sistema no inicia una conversacion con una property de otra organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00a1', 'sala-cruzada', 'llamada', 'gemini-3.8-live', 'Kore', repeat('a', 64), now()) as should_fail;
rollback;

\echo '=== C5. POSITIVO + IDEMPOTENCIA: el sistema registra un turno; repetir el mismo seq no duplica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- Desde la migracion 030 (PM PR-9) la transcripcion solo se persiste con consentimiento de grabacion
-- 'otorgado' (por defecto se exige): el servicio de voz lo registra antes del primer turno.
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 2, 'cliente', 'hola', 1200, 300, 50);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 2, 'cliente', 'hola', 1200, 300, 50);
-- el sistema no lee las tablas (solo owner/admin): se vuelve a superusuario para verificar el efecto
reset role;
select count(*)::int as turnos_con_seq_2_deberia_ser_1 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000d00c1' and seq = 2;
rollback;

\echo '=== C6. CROSS-TENANT (debe fallar): el sistema no registra un turno declarando otra organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00c1', 3, 'cliente', 'hola', 1200, 300, 50) as should_fail;
rollback;

\echo '=== C7. RECHAZADO (debe fallar): no se registran turnos en una conversacion ya cerrada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c2', 0, 'cliente', 'hola', 1200, 300, 50) as should_fail;
rollback;

\echo '=== C8. RECHAZADO (debe fallar): un staff autenticado no registra turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 9, 'cliente', 'hola', 1200, 300, 50) as should_fail;
rollback;

\echo '=== C9. CALCULO EN LA BASE: al cerrar, el costo total es la SUMA de los turnos (100 + 200 = 300 micro-USD) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'pedido_creado', now(), '00000000-0000-0000-0000-0000000d00e1');
-- el sistema no lee las tablas (solo owner/admin): se vuelve a superusuario para verificar el efecto
reset role;
select costo_estimado_micro_usd::int as costo_suma_turnos_deberia_ser_300 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000d00c1';
rollback;

\echo '=== C10. CALCULO EN LA BASE: p95 de latencia de los turnos (400 y 900 ms -> 900) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'escalado', now(), null);
-- el sistema no lee las tablas (solo owner/admin): se vuelve a superusuario para verificar el efecto
reset role;
select latencia_p95_ms as latencia_p95_deberia_ser_900 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000d00c1';
rollback;

\echo '=== C11. IDEMPOTENCIA: cerrar dos veces la misma conversacion no la vuelve a actualizar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'escalado', now(), null);
select count(*)::int as segundo_cierre_actualiza_deberia_ser_0 from (select 1 where restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'abandonado', now(), null)) x;
rollback;

\echo '=== C12. CROSS-TENANT (debe fallar): no se asocia un pedido de otra organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'pedido_creado', now(), '00000000-0000-0000-0000-0000000d00e2') as should_fail;
rollback;

\echo '=== C13. CROSS-TENANT: cerrar declarando otra organizacion no toca la conversacion (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as cierre_cross_tenant_actualiza_deberia_ser_0 from (select 1 where restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00c1', 'abandonado', now(), null)) x;
rollback;

\echo '=== C14. RECHAZADO (debe fallar): resultado fuera del catalogo (CHECK) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'otro', now(), null) as should_fail;
rollback;

\echo '=== C15. RECHAZADO (debe fallar): un staff autenticado no cierra conversaciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00c1', 'abandonado', now(), null) as should_fail;
rollback;

\echo '=== C16. RECHAZADO (debe fallar): INSERT directo en voice_conversation (deny-by-default, sin GRANT) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'directa', 'llamada', 'gemini-3.8-live');
rollback;

\echo '=== C17. RECHAZADO (debe fallar): INSERT directo en voice_turn (nadie siembra transcripciones con SQL directo) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', 50, 'cliente', 'falso');
rollback;

\echo '=== C18. RECHAZADO (debe fallar): UPDATE directo de una conversacion (alterar el costo declarado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.voice_conversation set costo_estimado_micro_usd = 0 where id = '00000000-0000-0000-0000-0000000d00c1' returning 1 as should_fail;
rollback;

\echo '=== C19. RECHAZADO (debe fallar): DELETE directo de un turno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
delete from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000d00c1' returning 1 as should_fail;
rollback;

\echo '=== C20. LECTURA: owner de A ve las conversaciones de su organizacion (2 del fixture) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select count(*)::int as conversaciones_visibles_owner_deberia_ser_2 from restaurantes.voice_conversation where property_id = '00000000-0000-0000-0000-0000000d00a1' and external_id like 'sala-a-%';
rollback;

\echo '=== C21. LECTURA: staff (rol staff) NO ve conversaciones (transcripciones = PII) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
select count(*)::int as conversaciones_visibles_staff_deberia_ser_0 from restaurantes.voice_conversation;
rollback;

\echo '=== C22. LECTURA: staff (rol staff) NO ve turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
select count(*)::int as turnos_visibles_staff_deberia_ser_0 from restaurantes.voice_turn;
rollback;

\echo '=== C23. CROSS-TENANT LECTURA: owner de B ve 0 conversaciones y 0 turnos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select ((select count(*) from restaurantes.voice_conversation) + (select count(*) from restaurantes.voice_turn))::int as filas_visibles_cross_tenant_deberia_ser_0;
rollback;

\echo '=== C24. LECTURA: owner de A ve los turnos de su conversacion (2 del fixture) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select count(*)::int as turnos_visibles_owner_deberia_ser_2 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000d00c1';
rollback;

\echo '=== C25. RECHAZADO (debe fallar): anon no lee conversaciones ==='
begin;
set local role anon;
select * from restaurantes.voice_conversation as should_fail;
rollback;

\echo '=== C26. RECHAZADO (debe fallar): anon no lee turnos ==='
begin;
set local role anon;
select * from restaurantes.voice_turn as should_fail;
rollback;

\echo '=== D1. POSITIVO: el sistema consume una sesion de preview vigente UNA sola vez ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1');
select count(*)::int as segundo_consumo_deberia_ser_0 from (select 1 where restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1')) x;
rollback;

\echo '=== D2. EXPIRADA: una sesion vencida no se consume ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as consumo_sesion_expirada_deberia_ser_0 from (select 1 where restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f2', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1')) x;
rollback;

\echo '=== D3. CROSS-TENANT: declarar otra organizacion no consume la sesion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as consumo_cross_tenant_deberia_ser_0 from (select 1 where restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00a1')) x;
rollback;

\echo '=== D4. CROSS-PROPERTY: declarar otra sucursal de la misma organizacion no consume la sesion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as consumo_otra_sucursal_deberia_ser_0 from (select 1 where restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a2')) x;
rollback;

\echo '=== D5. RECHAZADO (debe fallar): un staff autenticado no consume sesiones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
select restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1') as should_fail;
rollback;

\echo '=== D6. RECHAZADO (debe fallar): anon no consume sesiones ==='
begin;
set local role anon;
select restaurantes.voz_consumir_preview('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1') as should_fail;
rollback;

\echo '=== E1. BASE SIN MIGRAR: con branch_voice_config eliminada, la lectura del repositorio falla con 42P01 y SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.branch_voice_config;
savepoint sp_verify_voz_config_read;
do $$
declare
  v_state text;
begin
  begin
    perform habilitado, proveedor, voice_id, comportamiento, mensaje_inicial from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_voz_config_read;
release savepoint sp_verify_voz_config_read;
select 1 as transaccion_recuperada_tras_42p01_deberia_ser_1;
rollback;

\echo '=== E2. BASE SIN MIGRAR: con voice_conversation eliminada, el listado del repositorio falla con 42P01 y el camino anterior sigue leyendo pedidos ==='
begin;
-- voice_event (035) tiene FK a voice_conversation, igual que voice_turn: se elimina primero.
drop table restaurantes.voice_event; drop table restaurantes.voice_turn; drop table restaurantes.voice_conversation;
savepoint sp_verify_voz_conversaciones_read;
do $$
declare
  v_state text;
begin
  begin
    perform id, external_id, resultado from restaurantes.voice_conversation where organization_id = '00000000-0000-0000-0000-0000000d0001' and property_id = '00000000-0000-0000-0000-0000000d00a1';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_voz_conversaciones_read;
release savepoint sp_verify_voz_conversaciones_read;
select count(*)::int as pedidos_siguen_leyendo_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000d00e1';
rollback;

\echo '=== E3. BASE SIN MIGRAR: con las funciones eliminadas, el registrador falla con 42883 y SAVEPOINT recupera la transaccion ==='
begin;
drop function restaurantes.voz_iniciar_conversacion(uuid, uuid, text, text, text, text, text, timestamptz);
savepoint sp_verify_voz_iniciar;
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'x', 'llamada', 'gemini-3.8-live', 'Kore', null, now());
    raise exception 'se esperaba SQLSTATE 42883, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_voz_iniciar;
release savepoint sp_verify_voz_iniciar;
select 1 as transaccion_recuperada_tras_42883_deberia_ser_1;
rollback;

\echo '=== E4. BASE SIN MIGRAR: con voice_preview_sessions eliminada, emitir un preview falla con 42P01 y SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.voice_preview_sessions;
savepoint sp_verify_voz_preview;
do $$
declare
  v_state text;
begin
  begin
    insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0011', 'gemini-3.8-live', 'Kore', now(), now() + interval '5 minutes');
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_voz_preview;
release savepoint sp_verify_voz_preview;
select 1 as transaccion_recuperada_tras_42p01_preview_deberia_ser_1;
rollback;
