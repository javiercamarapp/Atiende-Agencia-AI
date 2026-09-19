-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales -- nunca el
-- repositorio en memoria de domain-rentas, que no aplica ninguno de los dos), el
-- gap y el hallazgo de seguridad que
-- packages/domain-rentas/migrations/018_break_glass_wiring.sql cierra:
--
--   1. CRITERIO DE SUPERADMIN CORREGIDO: `rentas.is_platform_superadmin` ya NO
--      cuenta "staff sin ninguna membership" como superadmin (el criterio débil
--      de 012_break_glass_audit.sql) -- ahora delega en `core.platform_superadmin`
--      (fuente de verdad real, re-atada a `auth.uid()` por
--      0012_caller_binding_fase2.sql). Un staff recién creado, invitado sin
--      aceptar, o al que le quitaron sus membresías YA NO puede abrir/leer
--      break-glass solo por carecer de membership.
--   2. Las 4 funciones nuevas (`open_break_glass_session`/
--      `list_break_glass_sessions_for_superadmin`/`close_break_glass_session`/
--      `list_reservas_for_break_glass`) exigen `auth.uid() = p_caller_id` +
--      `rentas.is_platform_superadmin(p_caller_id)` -- mismo patrón que
--      `core.*_for_superadmin` (0011_superadmin_caller_binding.sql).
--   3. `list_reservas_for_break_glass` SOLO devuelve datos mientras exista una
--      `rentas.break_glass_session` VIGENTE (sin cerrar, sin vencer) para el
--      mismo actor+organización -- el requisito central del gap ("las lecturas
--      SOLO mientras haya un acceso activo y vigente").
--   4. `rentas.break_glass_access_log` (012_break_glass_audit.sql) sigue siendo
--      append-only: ni UPDATE ni DELETE, para NADIE, ni siquiera `service_role`.
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de eso
-- persiste salvo las filas de fixture insertadas antes (directas, como el
-- superusuario `postgres` que corre este script -- mismo criterio que el resto
-- de scripts/verify-*/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures (persisten para TODOS los escenarios de abajo)
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000b6001', 'rentas', 'Org Break-Glass', 'org-break-glass'),
  ('00000000-0000-0000-0000-0000000b6002', 'rentas', 'Org Break-Glass (vencida)', 'org-break-glass-vencida'),
  ('00000000-0000-0000-0000-0000000b6003', 'rentas', 'Org Break-Glass (sin acceso)', 'org-break-glass-sin-acceso')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6001', 'rentas', 'Property Break-Glass')
on conflict do nothing;

-- superadmin-bg / superadmin-bg-2: dos superadmins REALES (core.platform_superadmin).
-- staff-sin-membresias-bg: staff real, CERO membership, y SIN alta en
-- core.platform_superadmin -- exactamente el caso que el criterio VIEJO
-- ("staff existe + cero membership") habría contado como superadmin.
-- staff-con-membresia-bg: staff real, member de org-break-glass como
-- admin_gestora -- ni superadmin, ni "sin membership".
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', 'Superadmin Break-Glass', 'seed'),
  ('00000000-0000-0000-0000-0000000b6101', 'superadmin-bg-2@example.com', 'Superadmin Break-Glass 2', 'seed'),
  ('00000000-0000-0000-0000-0000000b6102', 'sin-membresias-bg@example.com', 'Sin Membresías Break-Glass', 'seed'),
  ('00000000-0000-0000-0000-0000000b6103', 'con-membresia-bg@example.com', 'Con Membresía Break-Glass', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000b6100'),
  ('00000000-0000-0000-0000-0000000b6101')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, 'owner', 'admin_gestora')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000b6020', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', 'Unidad Break-Glass', 1)
on conflict do nothing;

insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto) values
  ('00000000-0000-0000-0000-0000000b6030', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', 'Huésped Break-Glass', '+52 555 000 0000')
on conflict do nothing;

insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, huesped_minimo_id) values
  ('00000000-0000-0000-0000-0000000b6040', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', daterange('2026-10-01', '2026-10-05', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, '00000000-0000-0000-0000-0000000b6030')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- Fase 10c -- fixtures de los 6 lectores restantes (ver
-- ../../packages/domain-rentas/migrations/020_break_glass_lectores.sql), todas
-- sobre org-break-glass (b6001) / Property Break-Glass (b6010) / Unidad
-- Break-Glass (b6020) -- MISMAS filas que ya usa el bloque de reservas de
-- arriba, para no multiplicar fixtures sin necesidad. `org-break-glass-otra`
-- (b6004) / `property-otra-org` (b6011) son SOLO para el escenario de
-- "propiedad que no pertenece a la organización" (P0002) de cada función.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000b6004', 'rentas', 'Org Break-Glass (otra, solo para property mismatch)', 'org-break-glass-otra')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000b6011', '00000000-0000-0000-0000-0000000b6004', 'rentas', 'Property de otra organización')
on conflict do nothing;

insert into rentas.reserva_financiero (id, organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, neto_centavos) values
  ('00000000-0000-0000-0000-0000000b6050', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6040', 'MXN', 500000, 450000)
on conflict do nothing;

insert into rentas.payout_canal (id, organization_id, property_id, canal_id, moneda, monto_total_centavos, fecha_payout) values
  ('00000000-0000-0000-0000-0000000b6060', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', (select id from rentas.canal where codigo = 'airbnb'), 'MXN', 100000, '2026-09-01')
on conflict do nothing;

insert into rentas.tarifa_base (id, organization_id, property_id, unidad_id, precio_noche_centavos, moneda) values
  ('00000000-0000-0000-0000-0000000b6070', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', 150000, 'MXN')
on conflict do nothing;

insert into rentas.conversacion (id, organization_id, property_id, unidad_id, canal_codigo, huesped_nombre, propiedad_nombre) values
  ('00000000-0000-0000-0000-0000000b6080', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', 'airbnb', 'Huésped Break-Glass', 'Property Break-Glass')
on conflict do nothing;

insert into rentas.tarea_operativa (id, organization_id, property_id, unidad_id, tipo, programada_para) values
  ('00000000-0000-0000-0000-0000000b6090', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', 'limpieza', '2026-09-22')
on conflict do nothing;

-- URL con un token de un solo uso embebido en el query string -- exactamente el
-- caso real que el enmascarado de 020_break_glass_lectores.sql debe cubrir
-- (el escenario 45 de abajo verifica que la función NUNCA devuelve este query
-- string completo).
insert into rentas.canal_feed_externo (id, organization_id, property_id, unidad_id, canal_id, url_importacion) values
  ('00000000-0000-0000-0000-0000000b6095', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', (select id from rentas.canal where codigo = 'airbnb'), 'https://www.airbnb.com/calendar/ical/12345.ics?s=tok_secreto_de_un_solo_uso_9f8e7d6c')
on conflict do nothing;

-- Tres ventanas de acceso, insertadas DIRECTO (como el superusuario que corre
-- este script -- bypassa RLS/el trigger de INSERT no aplica, solo bloquea
-- UPDATE) para poder ejercitar los 3 estados sin depender de que
-- `open_break_glass_session` ya funcione (eso se prueba aparte, escenario 9):
--   - bg-activa: vigente, sobre org-break-glass (la que tiene la reserva real).
--   - bg-vencida: expires_at en el PASADO, nunca cerrada explícitamente, sobre
--     org-break-glass-vencida.
--   - bg-para-cerrar: vigente, sobre org-break-glass, dedicada al escenario de
--     `close_break_glass_session` (para no interferir con bg-activa).
insert into rentas.break_glass_session (id, actor_user_id, actor_email, organization_id, reason, opened_at, expires_at) values
  ('00000000-0000-0000-0000-0000000b6200', '00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', '00000000-0000-0000-0000-0000000b6001', 'Ticket SOP-VERIFY: verificación real de romper-cristal contra Postgres.', now(), now() + interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000b6201', '00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', '00000000-0000-0000-0000-0000000b6002', 'Ticket SOP-VERIFY: ventana ya vencida, nunca cerrada a mano.', now() - interval '1 hour', now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000b6202', '00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', '00000000-0000-0000-0000-0000000b6001', 'Ticket SOP-VERIFY: ventana dedicada al escenario de cierre manual.', now(), now() + interval '30 minutes')
on conflict do nothing;

-- Una fila de bitácora real (directo, mismo criterio) -- para el bloque de
-- inmutabilidad de abajo.
insert into rentas.break_glass_access_log (id, actor_user_id, actor_email, organization_id, reason, resource_type, resource_scope, result_summary) values
  ('00000000-0000-0000-0000-0000000b6300', '00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', '00000000-0000-0000-0000-0000000b6001', 'Ticket SOP-VERIFY: fila de bitácora para probar inmutabilidad.', 'reservas', '{}'::jsonb, '{"total": 0}'::jsonb)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Criterio de superadmin CORREGIDO
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. rentas.is_platform_superadmin: staff SIN NINGUNA membresía (criterio VIEJO lo habría contado como superadmin) -- FALSE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6102', true);
select rentas.is_platform_superadmin('00000000-0000-0000-0000-0000000b6102')::int as deberia_ser_0;
rollback;

\echo '=== 2. rentas.is_platform_superadmin: superadmin REAL con su propia sesión -- TRUE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select rentas.is_platform_superadmin('00000000-0000-0000-0000-0000000b6100')::int as deberia_ser_1;
rollback;

\echo '=== 3. rentas.is_platform_superadmin: staff CON membership real (ni superadmin, ni "sin membership") -- FALSE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select rentas.is_platform_superadmin('00000000-0000-0000-0000-0000000b6103')::int as deberia_ser_0;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) open_break_glass_session -- atadura a auth.uid() + superadmin real + validación
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 4. open_break_glass_session: staff con membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', 'Intento de staff normal con membership real.', 30) as should_fail;
rollback;

\echo '=== 5. open_break_glass_session: staff SIN NINGUNA membresía (criterio viejo lo habría dejado pasar) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6102', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6102', '00000000-0000-0000-0000-0000000b6001', 'Intento de staff sin ninguna membership.', 30) as should_fail;
rollback;

\echo '=== 6. open_break_glass_session: sesión de SISTEMA (auth.uid() NULL) pasando el UUID del superadmin es RECHAZADA -- el patrón exacto que apps/api NUNCA debe usar aquí ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', 'Intento desde sesión de sistema, sin auth.uid() real.', 30) as should_fail;
rollback;

\echo '=== 7. open_break_glass_session: anon no puede ni ejecutar la función (sin GRANT EXECUTE) ==='
begin;
set local role anon;
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', 'anon nunca debería llegar aquí.', 30) as should_fail;
rollback;

\echo '=== 8. open_break_glass_session: superadmin real, motivo demasiado corto -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', 'corto', 30) as should_fail;
rollback;

\echo '=== 9. open_break_glass_session: superadmin real, duración fuera de rango (9999 min) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', 'Duración deliberadamente fuera de rango para este escenario.', 9999) as should_fail;
rollback;

\echo '=== 10. open_break_glass_session: superadmin real, entrada VÁLIDA -- abre sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select rentas.open_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', 'Ticket SOP-VERIFY: apertura válida de un acceso de emergencia real.', 30);
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) list_reservas_for_break_glass -- SOLO mientras haya un acceso activo y vigente
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 11. list_reservas_for_break_glass: sin NINGÚN acceso para esta organización -- RECHAZADO (403 lógico) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003') as should_fail;
rollback;

\echo '=== 12. list_reservas_for_break_glass: acceso VENCIDO (fixture bg-vencida, nunca cerrado a mano) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002') as should_fail;
rollback;

\echo '=== 13. list_reservas_for_break_glass: acceso ACTIVO real (fixture bg-activa) -- SÍ devuelve la reserva real (la fuga que este mecanismo debe permitir, auditada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001');
rollback;

\echo '=== 14. list_reservas_for_break_glass: staff CON membership real en la organización (sin ser superadmin) es RECHAZADO, aunque exista una ventana activa de OTRO actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001') as should_fail;
rollback;

\echo '=== 15. list_reservas_for_break_glass: anon no puede ni ejecutar la función ==='
begin;
set local role anon;
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001') as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) list_break_glass_sessions_for_superadmin / close_break_glass_session
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 16. list_break_glass_sessions_for_superadmin: el superadmin real ve sus 3 ventanas (activa + vencida + para-cerrar) -- activas E históricas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_3 from rentas.list_break_glass_sessions_for_superadmin('00000000-0000-0000-0000-0000000b6100');
rollback;

\echo '=== 17. list_break_glass_sessions_for_superadmin: staff con membership real (no superadmin) ve CERO -- nunca las sesiones de otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select count(*) as deberia_ser_0 from rentas.list_break_glass_sessions_for_superadmin('00000000-0000-0000-0000-0000000b6103');
rollback;

\echo '=== 18. close_break_glass_session: el propio superadmin cierra SU ventana (bg-para-cerrar) -- éxito real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select (closed_at is not null)::int as deberia_ser_1 from rentas.close_break_glass_session('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6202');
rollback;

\echo '=== 19. close_break_glass_session: OTRO superadmin real (no el actor) NO puede cerrar una ventana ajena -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select rentas.close_break_glass_session('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6202') as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) rentas.break_glass_access_log -- inmutable (ver 012_break_glass_audit.sql),
--    verificado de nuevo aquí porque esta fase es la primera vez que el
--    mecanismo queda alcanzable por una ruta HTTP real.
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 20. break_glass_access_log: UPDATE está bloqueado incluso para service_role ==='
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite `as`
-- sobre la sentencia completa; este comentario, DENTRO del bloque
-- begin;/rollback;, es lo que el runner automático detecta para marcar el
-- escenario como "debe terminar en ERROR").
set local role service_role;
update rentas.break_glass_access_log set reason = 'alterado' where id = '00000000-0000-0000-0000-0000000b6300';
rollback;

\echo '=== 21. break_glass_access_log: DELETE está bloqueado incluso para service_role ==='
begin;
-- as should_fail (ver nota del escenario 20 -- mismo motivo, DELETE tampoco
-- admite `as` sobre la sentencia completa).
set local role service_role;
delete from rentas.break_glass_access_log where id = '00000000-0000-0000-0000-0000000b6300';
rollback;

\echo '=== 22. break_glass_access_log: un staff con membership real (no superadmin) NO puede insertar a nombre del superadmin ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
insert into rentas.break_glass_access_log (actor_user_id, actor_email, organization_id, reason, resource_type, resource_scope, result_summary)
values ('00000000-0000-0000-0000-0000000b6100', 'suplantado@example.com', '00000000-0000-0000-0000-0000000b6001', 'Intento de suplantar al superadmin real.', 'reservas', '{}'::jsonb, '{}'::jsonb);
rollback;

\echo '=== 23. break_glass_access_log: el superadmin real SÍ puede insertar a nombre de sí mismo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
insert into rentas.break_glass_access_log (actor_user_id, actor_email, organization_id, reason, resource_type, resource_scope, result_summary)
values ('00000000-0000-0000-0000-0000000b6100', 'superadmin-bg@example.com', '00000000-0000-0000-0000-0000000b6001', 'Ticket SOP-VERIFY: inserción real de bitácora por el propio superadmin.', 'reservas', '{}'::jsonb, '{"total": 1}'::jsonb);
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) Visibilidad del tenant -- admin_gestora ve accesos de emergencia a SU
--    organización (sesiones Y bitácora), mismo criterio en ambas tablas.
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 24. break_glass_session: admin_gestora del tenant SÍ ve las ventanas de acceso de emergencia abiertas contra su organización ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select count(*) as deberia_ser_2 from rentas.break_glass_session where organization_id = '00000000-0000-0000-0000-0000000b6001';
rollback;

\echo '=== 25. break_glass_access_log: admin_gestora del tenant SÍ ve la bitácora de accesos de emergencia a su organización ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select count(*) as deberia_ser_1 from rentas.break_glass_access_log where organization_id = '00000000-0000-0000-0000-0000000b6001';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7) Fase 10c -- los 6 lectores restantes (020_break_glass_lectores.sql).
--    Mismo criterio de autorización EXACTO que list_reservas_for_break_glass
--    (bloque 3 de arriba, escenarios 11-15) -- se repite aquí por función
--    porque cada una es su propio cuerpo `security definer`, no una sola pieza
--    de código compartida; los 4 escenarios "core" (sin sesión / sesión
--    vencida / sesión activa real / staff con membership real) se prueban
--    para las 6, `anon`/filtro-por-propiedad-ajena se prueban una vez
--    (representativo, sobre `list_finanzas_for_break_glass` -- la lógica de
--    ambos chequeos es idéntica letra por letra en las otras 5).
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 26. list_finanzas_for_break_glass: sin NINGÚN acceso para esta organización -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 27. list_finanzas_for_break_glass: acceso VENCIDO (fixture bg-vencida) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 28. list_finanzas_for_break_glass: acceso ACTIVO real -- SÍ devuelve la fila real de reserva_financiero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 29. list_finanzas_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO, aunque exista ventana activa de OTRO actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 30. list_finanzas_for_break_glass: anon no puede ni ejecutar la función ==='
begin;
set local role anon;
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 31. list_finanzas_for_break_glass: property_id que NO pertenece a la organización -- RECHAZADO (P0002) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6011', null, null) as should_fail;
rollback;

\echo '=== 32. list_payouts_for_break_glass: sin NINGÚN acceso -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 33. list_payouts_for_break_glass: acceso VENCIDO -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 34. list_payouts_for_break_glass: acceso ACTIVO real -- SÍ devuelve el payout real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 35. list_payouts_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 36. list_pricing_for_break_glass: sin NINGÚN acceso -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 37. list_pricing_for_break_glass: acceso VENCIDO -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 38. list_pricing_for_break_glass: acceso ACTIVO real -- SÍ devuelve la tarifa base real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 39. list_pricing_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 40. list_mensajeria_for_break_glass: sin NINGÚN acceso -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 41. list_mensajeria_for_break_glass: acceso VENCIDO -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 42. list_mensajeria_for_break_glass: acceso ACTIVO real -- SÍ devuelve la conversación real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 43. list_mensajeria_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 44. list_limpieza_for_break_glass: sin NINGÚN acceso -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 45. list_limpieza_for_break_glass: acceso VENCIDO -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 46. list_limpieza_for_break_glass: acceso ACTIVO real -- SÍ devuelve la tarea operativa real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 47. list_limpieza_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 48. list_sync_ical_for_break_glass: sin NINGÚN acceso -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6003', null, null, null) as should_fail;
rollback;

\echo '=== 49. list_sync_ical_for_break_glass: acceso VENCIDO -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6002', null, null, null) as should_fail;
rollback;

\echo '=== 50. list_sync_ical_for_break_glass: acceso ACTIVO real -- SÍ devuelve el feed real, con la URL ENMASCARADA (nunca el token de la query string de fixture) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select (url_importacion_enmascarada not like '%tok_secreto%' and url_importacion_enmascarada = 'https://www.airbnb.com/***')::int as deberia_ser_1
from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null);
rollback;

\echo '=== 51. list_sync_ical_for_break_glass: staff CON membership real (no superadmin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6103', true);
select * from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6103', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 52. list_reservas_for_break_glass (sobrecarga de 5 parámetros, Fase 10c): filtro por propiedad -- SOLO la reserva de la propiedad pedida (aquí la única propiedad del fixture, filtra correctamente por igualdad) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select count(*) as deberia_ser_1 from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', null, null);
rollback;

\echo '=== 53. list_reservas_for_break_glass (sobrecarga de 5 parámetros): property_id que NO pertenece a la organización -- RECHAZADO (P0002) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6011', null, null) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- Fix hallazgo de revisión real (ronda 1 del PR #155, bloqueante 4) --
-- "sesión de OTRO superadmin -> denegado" por lector. Los escenarios negativos
-- 29/35/39/43/47/51 (staff CON membership real, b6103) se rechazan ANTES en
-- `rentas.is_platform_superadmin` -- nunca ejercitan la cláusula central
-- `s.actor_user_id = p_caller_id` de las 7 funciones nuevas de
-- 020_break_glass_lectores.sql. Los 7 escenarios de abajo sí la ejercitan: b6101
-- es un superadmin REAL (`core.platform_superadmin`, pasa el primer chequeo),
-- pero NUNCA abrió una `break_glass_session` sobre org-break-glass (b6001) --
-- solo b6100 la tiene (fixture b6200). Si esa cláusula se borrara, los 53
-- escenarios de arriba seguirían en verde (ninguno la ejercita) pero estos 7
-- fallarían -- exactamente el hueco que señaló la revisión.
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 54. list_reservas_for_break_glass (5 parámetros): OTRO superadmin real (b6101, sin sesión propia sobre esta organización) -- RECHAZADO aunque exista una sesión vigente de OTRO actor (b6100) sobre la misma organización ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 55. list_finanzas_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 56. list_payouts_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 57. list_pricing_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 58. list_mensajeria_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 59. list_limpieza_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

\echo '=== 60. list_sync_ical_for_break_glass: OTRO superadmin real (b6101, sin sesión propia) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6101', true);
select * from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6101', '00000000-0000-0000-0000-0000000b6001', null, null, null) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- Fix hallazgo de revisión real (ronda 1 del PR #155, bloqueante 5) --
-- enmascarado fail-closed de url_importacion. El escenario 50 (arriba) solo
-- prueba el caso feliz `https://host/path?query`. Los escenarios de abajo
-- prueban los casos concretos que el `regexp_replace` original (fail-open)
-- habría devuelto INTACTOS: webcal:// (formato habitual de un enlace de
-- importación iCal), esquema en MAYÚSCULAS, y userinfo (`user:pass@host`) --
-- ninguno debe filtrar el token/credencial ni la URL completa.
-- ═══════════════════════════════════════════════════════════════════════════

insert into rentas.canal_feed_externo (id, organization_id, property_id, unidad_id, canal_id, url_importacion) values
  ('00000000-0000-0000-0000-0000000b6096', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', (select id from rentas.canal where codigo = 'vrbo'), 'webcal://www.airbnb.com/calendar/ical/67890.ics?s=tok_webcal_9a8b7c6d'),
  ('00000000-0000-0000-0000-0000000b6097', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', (select id from rentas.canal where codigo = 'booking'), 'HTTPS://Booking.example.com/ical/feed.ics?s=TOK_MAYUS_1234'),
  ('00000000-0000-0000-0000-0000000b6098', '00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000b6010', '00000000-0000-0000-0000-0000000b6020', (select id from rentas.canal where codigo = 'manual'), 'https://svc_user:svc_pass_secreto@sync.example.com/feed.ics')
on conflict do nothing;

\echo '=== 61. list_sync_ical_for_break_glass: URL webcal:// -- enmascarada correctamente (el regexp_replace original, sensible a esquema http(s), la habría devuelto intacta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select (url_importacion_enmascarada not like '%tok_webcal%' and url_importacion_enmascarada = 'webcal://www.airbnb.com/***')::int as deberia_ser_1
  from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null)
  where id = '00000000-0000-0000-0000-0000000b6096';
rollback;

\echo '=== 62. list_sync_ical_for_break_glass: esquema en MAYÚSCULAS -- enmascarada correctamente (el regexp_replace original era sensible a mayúsculas y la habría devuelto intacta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select (url_importacion_enmascarada not like '%TOK_MAYUS%' and url_importacion_enmascarada = 'HTTPS://Booking.example.com/***')::int as deberia_ser_1
  from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null)
  where id = '00000000-0000-0000-0000-0000000b6097';
rollback;

\echo '=== 63. list_sync_ical_for_break_glass: URL con userinfo (user:pass@host) -- SIN credenciales en el resultado enmascarado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b6100', true);
select (url_importacion_enmascarada not like '%svc_user%' and url_importacion_enmascarada not like '%svc_pass_secreto%' and url_importacion_enmascarada = 'https://sync.example.com/***')::int as deberia_ser_1
  from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-0000000b6100', '00000000-0000-0000-0000-0000000b6001', null, null, null)
  where id = '00000000-0000-0000-0000-0000000b6098';
rollback;
