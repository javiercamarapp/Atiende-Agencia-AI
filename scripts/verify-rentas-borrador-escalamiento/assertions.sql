-- Rn-P3-21 (migracion rentas 034) -- verificacion contra Postgres REAL: las columnas necesita_escalamiento y senales de
-- rentas.borrador_mensaje (CHECK de senales validas y coherencia con la bandera), RLS por property (cross-tenant), GRANT por
-- COLUMNA (el staff NO puede editar las senales despues de generadas) y anon sin acceso. Cada escenario corre en su propio
-- `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; `..._deberia_ser_N` = el ultimo valor entero esperado
-- (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios.
--
-- Fixtures: org A (propiedad A1, staff admin_gestora A, unidad, conversacion CA, un borrador rutinario BA1) y org B (propiedad
-- B1, staff admin_gestora B).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e3a00', 'rentas', 'Org A (escalamiento)', 'org-a-escalamiento'),
  ('00000000-0000-0000-0000-0000000e3b00', 'rentas', 'Org B (escalamiento, ajena)', 'org-b-escalamiento')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e3a10', '00000000-0000-0000-0000-0000000e3a00', 'rentas', 'Casa Mar'),
  ('00000000-0000-0000-0000-0000000e3b10', '00000000-0000-0000-0000-0000000e3b00', 'rentas', 'Casa Ajena')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e3a01', 'admin-a-esc@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3b01', 'admin-b-esc@example.com', 'Admin B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e3a01', '00000000-0000-0000-0000-0000000e3a00', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-0000000e3b01', '00000000-0000-0000-0000-0000000e3b00', null, 'admin', 'admin_gestora')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000e3a20', '00000000-0000-0000-0000-0000000e3a00', '00000000-0000-0000-0000-0000000e3a10', 'Depto 1', 1)
on conflict do nothing;
insert into rentas.conversacion (id, organization_id, property_id, unidad_id, canal_codigo, propiedad_nombre) values
  ('00000000-0000-0000-0000-0000000e3a30', '00000000-0000-0000-0000-0000000e3a00', '00000000-0000-0000-0000-0000000e3a10', '00000000-0000-0000-0000-0000000e3a20', 'airbnb', 'Casa Mar')
on conflict do nothing;
-- Borrador rutinario SIN las columnas nuevas: deben tomar sus defaults (false y {}).
insert into rentas.borrador_mensaje (id, conversacion_id, canal_codigo, texto, generado_por) values
  ('00000000-0000-0000-0000-0000000e3a40', '00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'Hola, con gusto.', 'motor_borrador')
on conflict do nothing;

\echo '=== DEFAULTS Y CHECK ==='
\echo '1. un borrador insertado sin las columnas nuevas queda con necesita_escalamiento=false y senales vacias'
begin;
select count(*)::int as rutinario_deberia_ser_1 from rentas.borrador_mensaje where id = '00000000-0000-0000-0000-0000000e3a40' and necesita_escalamiento = false and senales = '{}';
rollback;

\echo '2. una senal fuera del catalogo del dominio es rechazada por el CHECK'
begin;
insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'x', 'motor_borrador', true, array['inventada']) returning id as should_fail;
rollback;

\echo '3. una senal sin la bandera de escalamiento es rechazada (incoherente)'
begin;
insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'x', 'motor_borrador', false, array['emergencia']) returning id as should_fail;
rollback;

\echo '4. las cuatro senales validas juntas con la bandera son aceptadas'
begin;
insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'x', 'agente_llm', true, array['queja', 'emergencia', 'reembolso', 'vip']);
select count(*)::int as escalados_deberia_ser_1 from rentas.borrador_mensaje where necesita_escalamiento and cardinality(senales) = 4;
rollback;

\echo '=== STAFF DE LA PROPERTY (RLS + GRANT por columna) ==='
\echo '5. el staff de la property inserta un borrador escalado (el insert de tabla cubre las columnas nuevas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3a01', true);
with i as (
  insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
  values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'Urgente', 'motor_borrador', true, array['emergencia']) returning id
)
select count(*)::int as insertado_deberia_ser_1 from i;
rollback;

\echo '6. el staff de la property lee los borradores de su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3a01', true);
select count(*)::int as visibles_deberia_ser_1 from rentas.borrador_mensaje where conversacion_id = '00000000-0000-0000-0000-0000000e3a30';
rollback;

\echo '7. el staff aprueba (columnas de decision) y la actualizacion SI se aplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3a01', true);
with u as (
  update rentas.borrador_mensaje set estado = 'rechazado', rechazado_por = '00000000-0000-0000-0000-0000000e3a01', rechazado_en = now(), motivo_rechazo = 'no aplica', actualizado_en = now()
  where id = '00000000-0000-0000-0000-0000000e3a40' returning id
)
select count(*)::int as actualizado_deberia_ser_1 from u;
rollback;

\echo '8. el staff NO puede apagar la bandera de escalamiento de un borrador ya generado (GRANT por columna)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3a01', true);
update rentas.borrador_mensaje set necesita_escalamiento = false where id = '00000000-0000-0000-0000-0000000e3a40' returning id as should_fail;
rollback;

\echo '9. el staff NO puede editar las senales de un borrador ya generado (GRANT por columna)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3a01', true);
update rentas.borrador_mensaje set senales = array['vip'] where id = '00000000-0000-0000-0000-0000000e3a40' returning id as should_fail;
rollback;

\echo '=== CROSS-TENANT ==='
\echo '10. el staff de OTRA organizacion no ve ningun borrador de la conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3b01', true);
select count(*)::int as ajenos_deberia_ser_0 from rentas.borrador_mensaje where conversacion_id = '00000000-0000-0000-0000-0000000e3a30';
rollback;

\echo '11. el staff de OTRA organizacion no puede insertar un borrador escalado en la conversacion ajena (RLS)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3b01', true);
insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'x', 'motor_borrador', true, array['queja']) returning id as should_fail;
rollback;

\echo '12. el staff de OTRA organizacion no actualiza nada (0 filas afectadas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3b01', true);
with u as (
  update rentas.borrador_mensaje set actualizado_en = now() where id = '00000000-0000-0000-0000-0000000e3a40' returning id
)
select count(*)::int as ajenos_deberia_ser_0 from u;
rollback;

\echo '=== ANON ==='
\echo '13. anon no puede leer borradores'
begin;
set local role anon;
select count(*) as should_fail from rentas.borrador_mensaje;
rollback;

\echo '14. anon no puede insertar un borrador escalado'
begin;
set local role anon;
insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, generado_por, necesita_escalamiento, senales)
values ('00000000-0000-0000-0000-0000000e3a30', 'airbnb', 'x', 'motor_borrador', true, array['queja']) returning id as should_fail;
rollback;

\echo '=== SESION SIN USUARIO (sistema, auth.uid() nulo) ==='
\echo '15. una sesion authenticated sin usuario no ve ningun borrador (RLS exige property del staff)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as sin_usuario_deberia_ser_0 from rentas.borrador_mensaje;
rollback;

\echo 'listo: los escenarios 2/3/8/9/11/13/14 deben terminar en ERROR; los de valor deben coincidir con su alias.'
