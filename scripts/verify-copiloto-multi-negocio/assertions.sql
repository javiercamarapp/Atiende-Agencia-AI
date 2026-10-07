-- Copiloto de superadmin multi-negocio (migracion 0056) -- verificacion contra Postgres REAL de
-- core.get_operaciones_por_organizacion_for_superadmin, core.log_superadmin_org_access, core.list_superadmin_org_access_for_superadmin
-- y de la tabla append-only core.superadmin_org_access_log. Cada escenario corre en su propio `begin; ... rollback;`.
-- Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs).
-- Datos ficticios. Sesion de sistema = sin `set local role` ni claim; usuario real = `set local role authenticated` + claim `request.jwt.claim.sub`.
-- Sujetos: c1 superadmin completo, c2 superadmin restringido a finanzas, c3 miembro de R1 (no superadmin), c4 sin nada.
-- Organizaciones: R1 restaurantes (con actividad), R2 restaurantes (SIN actividad), H1 hoteles (con actividad), H2 hoteles (sin actividad),
-- L1 licitaciones, D1 despachos. Ventana: 2026-09-01..2026-09-30, hoy = 2026-09-30.
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000a5d01', 'restaurantes', 'Taqueria R1', 'taqueria-r1-multi'),
  ('00000000-0000-0000-0000-0000000a5d02', 'restaurantes', 'Taqueria R2 sin ventas', 'taqueria-r2-multi'),
  ('00000000-0000-0000-0000-0000000a5d03', 'hoteles', 'Hotel H1', 'hotel-h1-multi'),
  ('00000000-0000-0000-0000-0000000a5d04', 'hoteles', 'Hotel H2 sin reservas', 'hotel-h2-multi'),
  ('00000000-0000-0000-0000-0000000a5d05', 'licitaciones', 'Licitadora L1', 'licitadora-l1-multi'),
  ('00000000-0000-0000-0000-0000000a5d06', 'despachos', 'Despacho D1', 'despacho-d1-multi'),
  ('00000000-0000-0000-0000-0000000a5d07', 'rentas', 'Renta RE1', 'renta-re1-multi'),
  ('00000000-0000-0000-0000-0000000a5d08', 'citas', 'Clinica CI1', 'clinica-ci1-multi')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a5e01', '00000000-0000-0000-0000-0000000a5d01', 'restaurantes', 'R1 centro'),
  ('00000000-0000-0000-0000-0000000a5e02', '00000000-0000-0000-0000-0000000a5d03', 'hoteles', 'H1 principal'),
  ('00000000-0000-0000-0000-0000000a5e03', '00000000-0000-0000-0000-0000000a5d06', 'despachos', 'D1 oficina')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a5c01', 'multi-c1@example.com', 'C1', 'seed'),
  ('00000000-0000-0000-0000-0000000a5c02', 'multi-c2@example.com', 'C2', 'seed'),
  ('00000000-0000-0000-0000-0000000a5c03', 'multi-c3@example.com', 'C3', 'seed'),
  ('00000000-0000-0000-0000-0000000a5c04', 'multi-c4@example.com', 'C4', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a5c03', '00000000-0000-0000-0000-0000000a5d01', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000a5c01'), ('00000000-0000-0000-0000-0000000a5c02') on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-0000000a5c02', 'finanzas', 'Rol restringido de prueba para la verificacion');

-- R1: 2 pedidos de septiembre (100 + 200), 1 cancelado (no cuenta), 1 pendiente de agosto (abierto ahora, fuera del rango); 1 toma humana en septiembre.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000a5f01', '00000000-0000-0000-0000-0000000a5d01', '00000000-0000-0000-0000-0000000a5e01', 'Cliente Uno', '9990000001', 100.00, 'completado', '[]', 'whatsapp', '2026-09-10T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000a5f02', '00000000-0000-0000-0000-0000000a5d01', '00000000-0000-0000-0000-0000000a5e01', 'Cliente Dos', '9990000002', 200.00, 'completado', '[]', 'web', '2026-09-11T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000a5f03', '00000000-0000-0000-0000-0000000a5d01', '00000000-0000-0000-0000-0000000a5e01', 'Cliente Tres', '9990000003', 50.00, 'cancelado', '[]', 'web', '2026-09-12T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000a5f04', '00000000-0000-0000-0000-0000000a5d01', '00000000-0000-0000-0000-0000000a5e01', 'Cliente Cuatro', '9990000004', 70.00, 'pending', '[]', 'web', '2026-08-15T18:00:00Z')
on conflict do nothing;
insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at) values
  ('00000000-0000-0000-0000-0000000a5d01', '00000000-0000-0000-0000-0000000a5e01', 'whatsapp', '00000000-0000-0000-0000-0000000a5f10', 'pendiente', 'agente', '2026-09-10T18:00:00Z');
-- H1: una reserva de septiembre con la estancia vigente el 30 (cuenta y esta abierta) y una cancelada (no cuenta).
insert into hoteles.reservation (id, organization_id, property_id, check_in_date, check_out_date, status, total_amount, created_at) values
  ('00000000-0000-0000-0000-0000000a5f21', '00000000-0000-0000-0000-0000000a5d03', '00000000-0000-0000-0000-0000000a5e02', '2026-09-29', '2026-10-02', 'confirmada', 3000.00, '2026-09-05T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000a5f22', '00000000-0000-0000-0000-0000000a5d03', '00000000-0000-0000-0000-0000000a5e02', '2026-09-20', '2026-09-22', 'cancelada', 999.00, '2026-09-06T18:00:00Z')
on conflict do nothing;
-- L1: una convocatoria de septiembre que cierra despues de hoy.
insert into licitaciones.tender (id, organization_id, title, submission_deadline, created_at) values
  ('00000000-0000-0000-0000-0000000a5f31', '00000000-0000-0000-0000-0000000a5d05', 'Convocatoria de prueba', '2026-10-20T18:00:00Z', '2026-09-12T18:00:00Z')
on conflict do nothing;
-- D1: dos vencimientos abiertos (uno ya vencido al 30-sep) y uno completado.
insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values
  ('00000000-0000-0000-0000-0000000a5f41', '00000000-0000-0000-0000-0000000a5d06', '00000000-0000-0000-0000-0000000a5e03', 'IVA', '2026-09', '2026-10-17', 'alta', 'pendiente'),
  ('00000000-0000-0000-0000-0000000a5f42', '00000000-0000-0000-0000-0000000a5d06', '00000000-0000-0000-0000-0000000a5e03', 'DIOT', '2026-08', '2026-09-17', 'critica', 'pendiente'),
  ('00000000-0000-0000-0000-0000000a5f43', '00000000-0000-0000-0000-0000000a5d06', '00000000-0000-0000-0000-0000000a5e03', 'ISR', '2026-08', '2026-09-17', 'media', 'completado')
on conflict do nothing;

-- Conversaciones de plataforma: K1 de c1, K2 de c2 (otro superadmin).
insert into core.data_chat_conversation (id, scope, organization_id, vertical, property_id, user_id, title, message_count) values
  ('00000000-0000-0000-0000-0000000a5b01', 'plataforma', null, 'plataforma', null, '00000000-0000-0000-0000-0000000a5c01', 'Resumen de plataforma c1', 2),
  ('00000000-0000-0000-0000-0000000a5b02', 'plataforma', null, 'plataforma', null, '00000000-0000-0000-0000-0000000a5c02', 'Resumen de plataforma c2', 2)
on conflict do nothing;

\echo '1. c1 superadmin: una fila por cada una de las 6 organizaciones sembradas, incluidas las SIN actividad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as filas_deberia_ser_6 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where organization_id in ('00000000-0000-0000-0000-0000000a5d01','00000000-0000-0000-0000-0000000a5d02','00000000-0000-0000-0000-0000000a5d03','00000000-0000-0000-0000-0000000a5d04','00000000-0000-0000-0000-0000000a5d05','00000000-0000-0000-0000-0000000a5d06');
rollback;

\echo '1b. las 6 verticales se leen de verdad: ninguna organizacion sembrada cae a razon = fuente_no_migrada (un error de columna no se degrada en silencio)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as sin_razon_deberia_ser_8 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where organization_id in ('00000000-0000-0000-0000-0000000a5d01','00000000-0000-0000-0000-0000000a5d02','00000000-0000-0000-0000-0000000a5d03','00000000-0000-0000-0000-0000000a5d04','00000000-0000-0000-0000-0000000a5d05','00000000-0000-0000-0000-0000000a5d06','00000000-0000-0000-0000-0000000a5d07','00000000-0000-0000-0000-0000000a5d08') and razon is null;
select count(*)::int as con_razon_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where razon is not null;
rollback;

\echo '2. R1: 2 pedidos (los cancelados no cuentan), ingresos 300, 1 escalacion y 1 pedido abierto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as r1_deberia_ser_1 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where organization_id = '00000000-0000-0000-0000-0000000a5d01' and operaciones = 2 and ingresos = 300 and escalaciones = 1 and abiertos = 1 and razon is null;
rollback;

\echo '3. R2 sin actividad aparece con 0 (no se omite) y 0 escalaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as r2_deberia_ser_1 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where organization_id = '00000000-0000-0000-0000-0000000a5d02' and operaciones = 0 and ingresos = 0 and escalaciones = 0 and abiertos = 0;
rollback;

\echo '4. H1: 1 reserva que cuenta (la cancelada no) y 1 estancia vigente hoy; H2 sin reservas con 0'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as hoteles_deberia_ser_2 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where (organization_id = '00000000-0000-0000-0000-0000000a5d03' and operaciones = 1 and abiertos = 1 and ingresos = 3000) or (organization_id = '00000000-0000-0000-0000-0000000a5d04' and operaciones = 0 and abiertos = 0);
rollback;

\echo '5. D1: 2 vencimientos abiertos de los cuales 1 vencido; L1: 1 convocatoria abierta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as despachos_licitaciones_deberia_ser_2 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30') where (organization_id = '00000000-0000-0000-0000-0000000a5d06' and abiertos = 2 and vencidos = 1) or (organization_id = '00000000-0000-0000-0000-0000000a5d05' and operaciones = 1 and abiertos = 1);
rollback;

\echo '6. fuera del rango de fechas la actividad es 0 pero la organizacion sigue en la lista'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as fuera_de_rango_deberia_ser_1 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-01-01','2026-01-31','2026-09-30') where organization_id = '00000000-0000-0000-0000-0000000a5d01' and operaciones = 0 and ingresos = 0;
rollback;

\echo '7. filtrar por una organizacion devuelve solo esa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as una_org_deberia_ser_1 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30', '00000000-0000-0000-0000-0000000a5d01');
rollback;

\echo '8. una organizacion que no existe devuelve 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as inexistente_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30', '00000000-0000-0000-0000-0000000a5eee');
rollback;

\echo '9. rango de mas de 400 dias se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*) as should_fail from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2024-01-01','2026-09-30','2026-09-30');
rollback;

\echo '10. c2 superadmin restringido a finanzas: 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
select count(*)::int as finanzas_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c02', '2026-09-01', '2026-09-30', '2026-09-30');
rollback;

\echo '11. c3 miembro de R1 (no superadmin): 0 filas, nunca los datos de otras organizaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c03', true);
select count(*)::int as miembro_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c03', '2026-09-01', '2026-09-30', '2026-09-30');
rollback;

\echo '12. c4 sin nada: 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c04', true);
select count(*)::int as sin_rol_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c04', '2026-09-01', '2026-09-30', '2026-09-30');
rollback;

\echo '13. c1 con un p_caller_id ajeno: 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*)::int as ajeno_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c02', '2026-09-01', '2026-09-30', '2026-09-30');
rollback;

\echo '14. sesion de sistema (auth.uid() nulo): 0 filas'
begin;

select count(*)::int as sistema_deberia_ser_0 from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30');
rollback;

\echo '15. anon no puede ejecutar la funcion'
begin;
set local role anon;
select count(*) as should_fail from core.get_operaciones_por_organizacion_for_superadmin('00000000-0000-0000-0000-0000000a5c01', '2026-09-01','2026-09-30','2026-09-30');
rollback;

\echo '16. c1 registra el acceso a 2 organizaciones: una fila por organizacion (la inexistente se ignora)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c01', array['00000000-0000-0000-0000-0000000a5d01','00000000-0000-0000-0000-0000000a5d03','00000000-0000-0000-0000-0000000a5eee']::uuid[], 'ranking_actividad', '{"metrica":"operaciones"}'::jsonb) as registradas_deberia_ser_2;
rollback;

\echo '17. la lectura de la bitacora devuelve quien, que organizacion y que herramienta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c01', array['00000000-0000-0000-0000-0000000a5d01','00000000-0000-0000-0000-0000000a5d03']::uuid[], 'operaciones_organizacion', '{}'::jsonb);
select count(*)::int as bitacora_deberia_ser_2 from core.list_superadmin_org_access_for_superadmin('00000000-0000-0000-0000-0000000a5c01', 50) where actor_user_id = '00000000-0000-0000-0000-0000000a5c01' and tool = 'operaciones_organizacion' and organization_id in ('00000000-0000-0000-0000-0000000a5d01','00000000-0000-0000-0000-0000000a5d03') and vertical in ('restaurantes','hoteles');
rollback;

\echo '18. finanzas no puede registrar accesos a organizaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c02', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'ranking_actividad', '{}'::jsonb) as should_fail;
rollback;

\echo '19. un miembro de R1 no puede registrar accesos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c03', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c03', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'ranking_actividad', '{}'::jsonb) as should_fail;
rollback;

\echo '20. c1 no puede registrar a nombre de otro (p_caller_id ajeno)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c02', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'ranking_actividad', '{}'::jsonb) as should_fail;
rollback;

\echo '21. la sesion de sistema no registra accesos'
begin;

select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c01', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'ranking_actividad', '{}'::jsonb) as should_fail;
rollback;

\echo '22. anon no puede registrar accesos'
begin;
set local role anon;
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c01', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'ranking_actividad', '{}'::jsonb) as should_fail;
rollback;

\echo '23. una herramienta con nombre invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.log_superadmin_org_access('00000000-0000-0000-0000-0000000a5c01', array['00000000-0000-0000-0000-0000000a5d01']::uuid[], 'Robar; drop', '{}'::jsonb) as should_fail;
rollback;

\echo '24. la bitacora no se lee directo: authenticated no tiene SELECT'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select count(*) as should_fail from core.superadmin_org_access_log;
rollback;

\echo '25. la bitacora no se escribe directo: authenticated no tiene INSERT'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
insert into core.superadmin_org_access_log (actor_user_id, organization_id, vertical, tool) values ('00000000-0000-0000-0000-0000000a5c01', '00000000-0000-0000-0000-0000000a5d01', 'restaurantes', 'x') returning 1 as should_fail;
rollback;

\echo '26. la bitacora es append-only: ni el dueno puede editar una fila'
begin;
insert into core.superadmin_org_access_log (id, actor_user_id, organization_id, vertical, tool) values ('00000000-0000-0000-0000-0000000a5a01', '00000000-0000-0000-0000-0000000a5c01', '00000000-0000-0000-0000-0000000a5d01', 'restaurantes', 'ranking_actividad');
update core.superadmin_org_access_log set tool = 'otra' where id = '00000000-0000-0000-0000-0000000a5a01' returning 1 as should_fail;
rollback;

\echo '27. la bitacora es append-only: ni el dueno puede borrar una fila'
begin;
insert into core.superadmin_org_access_log (id, actor_user_id, organization_id, vertical, tool) values ('00000000-0000-0000-0000-0000000a5a02', '00000000-0000-0000-0000-0000000a5c01', '00000000-0000-0000-0000-0000000a5d01', 'restaurantes', 'ranking_actividad');
delete from core.superadmin_org_access_log where id = '00000000-0000-0000-0000-0000000a5a02' returning 1 as should_fail;
rollback;

\echo '28. finanzas no lee la bitacora (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);

select count(*)::int as lectura_finanzas_deberia_ser_0 from core.list_superadmin_org_access_for_superadmin('00000000-0000-0000-0000-0000000a5c02', 50);
rollback;

\echo '29. un miembro de R1 no lee la bitacora (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c03', true);
select count(*)::int as lectura_miembro_deberia_ser_0 from core.list_superadmin_org_access_for_superadmin('00000000-0000-0000-0000-0000000a5c03', 50);
rollback;

\echo '30. estructura: funciones definer con search_path fijo, sin EXECUTE para anon ni PUBLIC, tabla con RLS y sin policies'
begin;

select count(*)::int as estructura_deberia_ser_0 from (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'core'
     and p.proname in ('get_operaciones_por_organizacion_for_superadmin', 'log_superadmin_org_access', 'list_superadmin_org_access_for_superadmin')
     and (not p.prosecdef
          or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute')
          or not has_function_privilege('authenticated', p.oid, 'execute'))
  union all
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'core' and c.relname = 'superadmin_org_access_log'
     and (not c.relrowsecurity
          or has_table_privilege('anon', c.oid, 'select,insert,update,delete')
          or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'))
  union all
  select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname = 'superadmin_org_access_log'
) fallos;
rollback;

\echo '=== FIJADOS DE PLATAFORMA ==='

\echo '31. c1 fija un resultado de plataforma y lo ve (RLS del autor)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
select count(*)::int as fijados_propios_deberia_ser_1 from core.copiloto_pin where vertical = 'plataforma';
rollback;

\echo '32. fijar dos veces lo mismo no duplica (misma herramienta y argumentos)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
select count(*)::int as sin_duplicar_deberia_ser_1 from core.copiloto_pin where vertical = 'plataforma';
rollback;

\echo '33. el fijado de plataforma no lleva organizacion y no se comparte'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
select count(*)::int as forma_deberia_ser_1 from core.copiloto_pin where vertical = 'plataforma' and organization_id is null and shared = false and author_id = '00000000-0000-0000-0000-0000000a5c01';
rollback;

\echo '34. otro superadmin (c2) no ve los fijados de c1'
begin;
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'De c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
select count(*)::int as ajeno_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '35. un miembro de una organizacion no ve fijados de plataforma'
begin;
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'De c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c03', true);
select count(*)::int as miembro_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '36. un miembro de una organizacion no puede crear fijados de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c03', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio') as should_fail;
rollback;

\echo '37. anon no puede crear fijados de plataforma'
begin;
set local role anon;
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio') as should_fail;
rollback;

\echo '38. la sesion de sistema no crea fijados de plataforma'
begin;

select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio') as should_fail;
rollback;

\echo '39. c1 no puede fijar desde la conversacion de otro superadmin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b02', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio') as should_fail;
rollback;

\echo '40. un fijado de plataforma no se puede compartir'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
update core.copiloto_pin set shared = true where vertical = 'plataforma' returning 1 as should_fail;
rollback;

\echo '41. c1 puede renombrar su fijado (UPDATE a nivel columna sobre title)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
update core.copiloto_pin set title = 'Nuevo titulo' where vertical = 'plataforma';
select count(*)::int as renombrado_deberia_ser_1 from core.copiloto_pin where vertical = 'plataforma' and title = 'Nuevo titulo';
rollback;

\echo '42. c1 no puede cambiar la herramienta de un fijado (sin GRANT de columna)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
update core.copiloto_pin set tool = 'mrr' where vertical = 'plataforma' returning 1 as should_fail;
rollback;

\echo '43. c1 borra su fijado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio');
delete from core.copiloto_pin where vertical = 'plataforma';
select count(*)::int as borrado_deberia_ser_0 from core.copiloto_pin where vertical = 'plataforma';
rollback;

\echo '44. c2 no puede borrar el fijado de c1 (0 filas afectadas)'
begin;
insert into core.copiloto_pin (id, organization_id, vertical, author_id, tool, args, title) values ('00000000-0000-0000-0000-0000000a5a11', null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'De c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
delete from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000a5a11';
reset role;
select count(*)::int as sigue_existiendo_deberia_ser_1 from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000a5a11';
rollback;

\echo '45. authenticated no inserta fijados directo (solo por la funcion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'x') returning 1 as should_fail;
rollback;

\echo '46. un fijado de plataforma con organizacion se rechaza (CHECK de coherencia)'
begin;

insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values ('00000000-0000-0000-0000-0000000a5d01', 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'x') returning 1 as should_fail;
rollback;

\echo '47. un fijado de vertical sin organizacion se rechaza (CHECK de coherencia)'
begin;

insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'restaurantes', '00000000-0000-0000-0000-0000000a5c01', 'ventas_por_dia', '{}', 'x') returning 1 as should_fail;
rollback;

\echo '48. tope de 50 fijados por superadmin'
begin;
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) select null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', jsonb_build_object('n', g), 'Fijado ' || g from generate_series(1, 50) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c01', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b01', 1, 0, 'ranking_actividad', '{"periodo":"este_mes"}'::jsonb, 'Actividad por negocio') as should_fail;
rollback;

\echo '49. un superadmin que deja de serlo ya no lee ni borra sus fijados'
begin;
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c02', 'organizaciones', '{}', 'De c2');
delete from core.cfo_zone_role where staff_user_id = '00000000-0000-0000-0000-0000000a5c02';
delete from core.platform_superadmin where staff_user_id = '00000000-0000-0000-0000-0000000a5c02';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
select count(*)::int as degradado_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '50. el superadmin restringido a finanzas no fija en el tablero de plataforma (mismo guard que las demas funciones de la 0056)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a5c02', true);
select core.copiloto_pin_create_plataforma('00000000-0000-0000-0000-0000000a5b02', 1, 0, 'organizaciones', '{}'::jsonb, 'De finanzas') as should_fail;
rollback;

\echo '51. el indice parcial rechaza un fijado de plataforma duplicado aunque no pase por la funcion de alta (organization_id NULL no deduplica por el UNIQUE de la 0045)'
begin;
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'Uno');
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, args, title) values (null, 'plataforma', '00000000-0000-0000-0000-0000000a5c01', 'organizaciones', '{}', 'Dos') returning 1 as should_fail;
rollback;
