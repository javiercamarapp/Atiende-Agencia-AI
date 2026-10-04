-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/053_conocimiento_negocio_y_control_agente.sql.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. Un escenario "RECHAZADO" termina en ERROR real de Postgres (lo marca el
-- comentario `-- as should_fail`); un escenario de conteo termina en `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c0001', 'restaurantes', 'Conocimiento Org A', 'conoc-a'),
  ('00000000-0000-0000-0000-0000000c0002', 'restaurantes', 'Conocimiento Org B (ajena)', 'conoc-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'a1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'a2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0011', 'owner-a@conoc.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0013', 'staff-a@conoc.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0014', 'owner-b@conoc.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0011', '00000000-0000-0000-0000-0000000c0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c0013', '00000000-0000-0000-0000-0000000c0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c0014', '00000000-0000-0000-0000-0000000c0002', null, 'owner', 'owner')
on conflict do nothing;

-- Entradas previas (insertadas como superusuario): una general de A, una general de B y una voz ya configurada en A1.
insert into restaurantes.conocimiento_negocio (id, organization_id, property_id, titulo, texto, tipo) values
  ('00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001', null, 'Estacionamiento', 'Hay estacionamiento gratuito para clientes.', 'faq'),
  ('00000000-0000-0000-0000-0000000c00e2', '00000000-0000-0000-0000-0000000c0002', null, 'Politica B', 'Texto de la organizacion B.', 'politica');

insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, voice_id) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', true, 'Kore');

\echo '=== P1. POSITIVO: owner de A crea una politica general como lo hace la API (columnas concedidas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.conocimiento_negocio (organization_id, property_id, titulo, texto, tipo, prioridad, vigente_desde, vigente_hasta, activo, estado, origen, version, creado_por, actualizado_por, updated_at)
values ('00000000-0000-0000-0000-0000000c0001', null, 'Cambios', 'No hacemos cambios en pedidos ya preparados.', 'politica', 70, null, null, true, 'publicado', 'manual', 1, '00000000-0000-0000-0000-0000000c0011', '00000000-0000-0000-0000-0000000c0011', now())
returning id;
select count(*)::int as politica_creada_deberia_ser_1 from restaurantes.conocimiento_negocio where titulo = 'Cambios';
rollback;

\echo '=== P2. POSITIVO: owner de A crea un aviso temporal de UNA sucursal que sustituye a la entrada general ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.conocimiento_negocio (organization_id, property_id, reemplaza_id, titulo, texto, tipo, vigente_desde, vigente_hasta, creado_por, actualizado_por)
values ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e1', 'Estacionamiento', 'Hoy el estacionamiento esta en obra.', 'aviso_temporal', '2026-10-01', '2026-10-02', '00000000-0000-0000-0000-0000000c0011', '00000000-0000-0000-0000-0000000c0011')
returning id;
select count(*)::int as sustitucion_creada_deberia_ser_1 from restaurantes.conocimiento_negocio where reemplaza_id = '00000000-0000-0000-0000-0000000c00e1';
rollback;

\echo '=== P3. POSITIVO: owner edita (columnas de UPDATE) y apaga una entrada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.conocimiento_negocio set texto = 'Estacionamiento para 20 autos.', version = version + 1, actualizado_por = '00000000-0000-0000-0000-0000000c0011', updated_at = now()
  where id = '00000000-0000-0000-0000-0000000c00e1' returning version;
update restaurantes.conocimiento_negocio set activo = false where id = '00000000-0000-0000-0000-0000000c00e1' returning activo;
rollback;

\echo '=== P4. POSITIVO: owner borra una entrada de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
with borrado as (delete from restaurantes.conocimiento_negocio where id = '00000000-0000-0000-0000-0000000c00e1' returning 1)
select count(*)::int as borradas_deberia_ser_1 from borrado;
rollback;

\echo '=== P5. SISTEMA: la sesion sin usuario (webhook/llamada) lee el conocimiento, y solo ahi se ve de todas las organizaciones ==='
begin;
set local role authenticated;
select count(*)::int as sistema_lee_conocimiento_deberia_ser_2 from restaurantes.conocimiento_negocio;
rollback;

\echo '=== P6. RECHAZADO (debe fallar): CHECK -- un texto de 2001 caracteres no entra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', 'Largo', repeat('x', 2001), 'faq') returning id;
rollback;

\echo '=== P7. RECHAZADO (debe fallar): CHECK -- un tipo fuera del catalogo no entra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', 'Raro', 'texto', 'precio') returning id;
rollback;

\echo '=== P8. RECHAZADO (debe fallar): CHECK -- vigencia invertida (hasta antes que desde) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo, vigente_desde, vigente_hasta) values ('00000000-0000-0000-0000-0000000c0001', 'Invertida', 'texto', 'aviso_temporal', '2026-10-05', '2026-10-01') returning id;
rollback;

\echo '=== P9. RECHAZADO (debe fallar): CHECK -- prioridad fuera de 0..100 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo, prioridad) values ('00000000-0000-0000-0000-0000000c0001', 'Prio', 'texto', 'faq', 101) returning id;
rollback;

\echo '=== P10. RECHAZADO (debe fallar): reemplaza_id sin sucursal (una entrada general no puede sustituir a otra) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, property_id, reemplaza_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', null, '00000000-0000-0000-0000-0000000c00e1', 'X', 'texto', 'faq') returning id;
rollback;

\echo '=== P11. CROSS-TENANT (debe fallar): owner de A no puede sustituir una entrada general de B (with check de reemplaza_id) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, property_id, reemplaza_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e2', 'X', 'texto', 'faq') returning id;
rollback;

\echo '=== P12. CROSS-TENANT (debe fallar): owner de A no puede crear una entrada para una sucursal de B (with check de property_id) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, property_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00b1', 'X', 'texto', 'faq') returning id;
rollback;

\echo '=== P13. CROSS-TENANT (debe fallar): owner de B no puede escribir una entrada a nombre de la organizacion A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', 'X', 'texto', 'faq') returning id;
rollback;

\echo '=== P14. ROL INSUFICIENTE: staff de A no edita (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
with actualizado as (update restaurantes.conocimiento_negocio set texto = 'otro' where organization_id = '00000000-0000-0000-0000-0000000c0001' returning 1)
select count(*)::int as filas_actualizadas_por_staff_deberia_ser_0 from actualizado;
rollback;

\echo '=== P15. ROL INSUFICIENTE: staff de A no borra (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
with borrado as (delete from restaurantes.conocimiento_negocio where organization_id = '00000000-0000-0000-0000-0000000c0001' returning 1)
select count(*)::int as filas_borradas_por_staff_deberia_ser_0 from borrado;
rollback;

\echo '=== P16. ROL: staff de A SI lee el conocimiento de su organizacion (y solo el suyo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
select count(*)::int as staff_lee_solo_su_organizacion_deberia_ser_1 from restaurantes.conocimiento_negocio;
rollback;

\echo '=== P17. CROSS-TENANT: owner de B no edita ni borra el conocimiento de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (update restaurantes.conocimiento_negocio set texto = 'otro' where id = '00000000-0000-0000-0000-0000000c00e1' returning 1),
     borrado as (delete from restaurantes.conocimiento_negocio where id = '00000000-0000-0000-0000-0000000c00e1' returning 1)
select ((select count(*) from actualizado) + (select count(*) from borrado))::int as filas_cross_tenant_deberia_ser_0;
rollback;

\echo '=== P18. RECHAZADO (debe fallar): el GRANT por columna no permite cambiar organization_id de una fila existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
update restaurantes.conocimiento_negocio set organization_id = '00000000-0000-0000-0000-0000000c0002' where id = '00000000-0000-0000-0000-0000000c00e1' returning 1;
rollback;

\echo '=== P19. RECHAZADO (debe fallar): anon no lee el conocimiento ==='
begin;
set local role anon;
-- as should_fail
select titulo from restaurantes.conocimiento_negocio;
rollback;

\echo '=== P20. RECHAZADO (debe fallar): anon no escribe el conocimiento ==='
begin;
set local role anon;
-- as should_fail
insert into restaurantes.conocimiento_negocio (organization_id, titulo, texto, tipo) values ('00000000-0000-0000-0000-0000000c0001', 'X', 'texto', 'faq') returning id;
rollback;

\echo '=== S1. POSITIVO: el upsert EXACTO del repositorio del interruptor (owner de A apaga A1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_sucursal_control as c (property_id, organization_id, agente_activo, actualizado_por, updated_at)
values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', false, '00000000-0000-0000-0000-0000000c0011', now())
on conflict (property_id) do update set agente_activo = excluded.agente_activo, actualizado_por = excluded.actualizado_por, updated_at = excluded.updated_at
returning agente_activo;
select count(*)::int as interruptor_apagado_deberia_ser_1 from restaurantes.whatsapp_sucursal_control where property_id = '00000000-0000-0000-0000-0000000c00a1' and agente_activo = false;
rollback;

\echo '=== S2. POSITIVO: volver a encender (segundo upsert) deja una sola fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_sucursal_control as c (property_id, organization_id, agente_activo, actualizado_por, updated_at)
values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', false, '00000000-0000-0000-0000-0000000c0011', now())
on conflict (property_id) do update set agente_activo = excluded.agente_activo, actualizado_por = excluded.actualizado_por, updated_at = excluded.updated_at;
insert into restaurantes.whatsapp_sucursal_control as c (property_id, organization_id, agente_activo, actualizado_por, updated_at)
values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', true, '00000000-0000-0000-0000-0000000c0011', now())
on conflict (property_id) do update set agente_activo = excluded.agente_activo, actualizado_por = excluded.actualizado_por, updated_at = excluded.updated_at;
select count(*)::int as una_fila_encendida_deberia_ser_1 from restaurantes.whatsapp_sucursal_control where property_id = '00000000-0000-0000-0000-0000000c00a1' and agente_activo = true;
rollback;

\echo '=== S3. SISTEMA: el webhook (sin usuario) lee el interruptor antes de llamar al modelo ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo) values ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', false);
set local role authenticated;
select count(*)::int as sistema_lee_interruptor_deberia_ser_1 from restaurantes.whatsapp_sucursal_control where property_id = '00000000-0000-0000-0000-0000000c00a2' and agente_activo = false;
rollback;

\echo '=== S4. ROL INSUFICIENTE: staff de A no apaga el agente (with check de insert falla) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
-- as should_fail
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo) values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', false) returning 1;
rollback;

\echo '=== S5. CROSS-TENANT (debe fallar): owner de A no apaga el agente de una sucursal de B ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
-- as should_fail
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo) values ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0001', false) returning 1;
rollback;

\echo '=== S6. CROSS-TENANT: owner de B no cambia el interruptor de A (0 filas) ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo) values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (update restaurantes.whatsapp_sucursal_control set agente_activo = false where property_id = '00000000-0000-0000-0000-0000000c00a1' returning 1)
select count(*)::int as filas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== S7. RECHAZADO (debe fallar): anon no lee ni escribe el interruptor ==='
begin;
set local role anon;
-- as should_fail
select agente_activo from restaurantes.whatsapp_sucursal_control;
rollback;

\echo '=== S8. RECHAZADO (debe fallar): anon no escribe el interruptor ==='
begin;
set local role anon;
-- as should_fail
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo) values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', false) returning 1;
rollback;

\echo '=== V1. COMPATIBILIDAD: la configuracion de voz previa queda con el saludo interrumpible (valor por omision true) ==='
begin;
select count(*)::int as voz_previa_interrumpible_deberia_ser_1 from restaurantes.branch_voice_config where property_id = '00000000-0000-0000-0000-0000000c00a1' and mensaje_inicial_interrumpible = true;
rollback;

\echo '=== V2. POSITIVO: owner de A apaga la interrupcion del saludo (UPDATE por columna) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_voice_config set mensaje_inicial_interrumpible = false, updated_at = now() where property_id = '00000000-0000-0000-0000-0000000c00a1' returning mensaje_inicial_interrumpible;
rollback;

\echo '=== V3. ROL INSUFICIENTE / CROSS-TENANT: owner de B no cambia el saludo de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (update restaurantes.branch_voice_config set mensaje_inicial_interrumpible = false where property_id = '00000000-0000-0000-0000-0000000c00a1' returning 1)
select count(*)::int as filas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== V4. RECHAZADO (debe fallar): anon no cambia el saludo ==='
begin;
set local role anon;
-- as should_fail
update restaurantes.branch_voice_config set mensaje_inicial_interrumpible = false returning 1;
rollback;
