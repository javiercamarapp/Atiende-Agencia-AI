-- Fixtures + escenarios de autorización para las 2 funciones de
-- `packages/db/migrations/0018_billing_webhook_registro.sql`
-- (`core.record_billing_webhook_event`/`core.list_billing_webhook_log_for_
-- superadmin`) — mismo patrón EXACTO que
-- `scripts/verify-superadmin-facturacion/assertions.sql`: cada escenario es
-- su propia transacción (`begin;`...`rollback;`, nunca persiste nada salvo
-- los fixtures de arriba), y el alias de la columna de verificación
-- (`deberia_ser_N`/`should_fail`) es lo que
-- `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir pass/fail
-- automáticamente quien lo corre en CI — este archivo también se corre a
-- mano con `run.sh` para inspección humana.
--
-- Actores:
--   - staff-bitacora-a: staff REAL (member normal) de org-bitacora, sin
--     ninguna autoridad de superadmin.
--   - superadmin-bitacora: superadmin REAL (fila en core.platform_superadmin).
--   - org-bitacora: organización real, con staff-bitacora-a como 'member'.
--   - 2 filas YA COMMITEADAS en core.billing_webhook_log (insertadas
--     directamente como fixture, no vía la función, para tener datos reales
--     que los escenarios de LECTURA puedan ver): una 'procesado' con
--     organización resuelta, una 'rechazado' sin organización (firma
--     inválida real -- nunca trae organización resuelta).
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000b1', 'staff-bitacora-a@example.com', 'Staff Bitacora A', 'seed'),
  ('00000000-0000-0000-0000-0000000000b3', 'superadmin-bitacora@example.com', 'Superadmin Bitacora', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000b3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000b9', 'hoteles', 'Org Bitacora', 'org-bitacora')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b9', null, 'member', 'staff')
on conflict do nothing;

insert into core.billing_webhook_log (provider_event_id, event_type, organization_id, result, reason) values
  ('evt_fixture_ok', 'checkout.session.completed', '00000000-0000-0000-0000-0000000000b9', 'procesado', 'aplicado'),
  (null, null, null, 'rechazado', 'firma_invalida');

-- ═══ core.record_billing_webhook_event (escritura, solo sesión de sistema) ═══

\echo '=== 1. record_billing_webhook_event: sesión de SISTEMA (auth.uid() null) SI puede insertar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event('evt_sistema_1', 'checkout.session.completed', '00000000-0000-0000-0000-0000000000b9', 'procesado', 'aplicado');
-- `core.billing_webhook_log` no tiene NINGUNA policy/GRANT directa para
-- `authenticated` (ver el comentario de cabecera de la migración: "TODO el
-- acceso pasa por las 2 funciones") -- `reset role` vuelve al superusuario de
-- esta conexión SOLO para verificar que el INSERT de arriba (hecho por la
-- función `security definer`) de verdad ocurrió, nunca para probar que
-- `authenticated` pueda leer la tabla directo (eso SIGUE prohibido, ver el
-- escenario 16).
reset role;
select count(*) as deberia_ser_1 from core.billing_webhook_log where provider_event_id = 'evt_sistema_1';
rollback;

\echo '=== 2. record_billing_webhook_event: un staff AUTENTICADO normal (auth.uid() real, NUNCA sesión de sistema) NO puede escribir -- este es exactamente el patron que un caller mal-armado ejercitaria si abriera la sesion del webhook como el caller en vez de como sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select core.record_billing_webhook_event('evt_intruso', 'x', null, 'procesado', 'aplicado') as should_fail;
rollback;

\echo '=== 3. record_billing_webhook_event: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.record_billing_webhook_event('evt_anon', 'x', null, 'procesado', 'aplicado') as should_fail;
rollback;

\echo '=== 4. record_billing_webhook_event: un result fuera de catalogo lanza (guard interno explicito) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event('evt_result_malo', 'x', null, 'no-es-un-result', 'aplicado') as should_fail;
rollback;

\echo '=== 5. record_billing_webhook_event: un reason fuera de catalogo lanza (CHECK constraint de la tabla, defensa en profundidad) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event('evt_reason_malo', 'x', null, 'rechazado', 'motivo-inventado') as should_fail;
rollback;

\echo '=== 6. record_billing_webhook_event: organization_id inexistente se guarda como NULL, nunca lanza por FK rota (best-effort por contrato) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event('evt_org_fantasma', 'x', '00000000-0000-0000-0000-000000000fff', 'procesado', 'aplicado');
reset role;
select count(*) as deberia_ser_1 from core.billing_webhook_log where provider_event_id = 'evt_org_fantasma' and organization_id is null;
rollback;

\echo '=== 7. record_billing_webhook_event: rechazo SIN payload -- provider_event_id/event_type/organization_id los 3 NULL a la vez se inserta igual (firma invalida real, ver routes/billing.ts) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event(null, null, null, 'rechazado', 'firma_invalida');
reset role;
-- deberia_ser_2, no 1: el fixture de arriba YA sembró una fila idéntica
-- (mismo caso real -- una firma inválida real nunca trae más que esto) --
-- esta inserción agrega una SEGUNDA.
select count(*) as deberia_ser_2 from core.billing_webhook_log where reason = 'firma_invalida' and provider_event_id is null and event_type is null and organization_id is null and result = 'rechazado';
rollback;

\echo '=== 8. record_billing_webhook_event: el MISMO provider_event_id insertado 2 veces produce 2 filas -- esta bitacora es un LOG de auditoria, nunca un dedupe (el dedupe real vive en core.billing_webhook_event, tabla aparte, sin tocar por esta migracion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_billing_webhook_event('evt_repetido', 'customer.subscription.updated', null, 'ignorado', 'duplicado');
select core.record_billing_webhook_event('evt_repetido', 'customer.subscription.updated', null, 'ignorado', 'duplicado');
reset role;
select count(*) as deberia_ser_2 from core.billing_webhook_log where provider_event_id = 'evt_repetido';
rollback;

\echo '=== 9. record_billing_webhook_event: tope anti-inflado -- 250 intentos de result=rechazado en la misma ventana de 1 minuto se descartan a partir del 200, el total NUNCA pasa de 200 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  for i in 1..250 loop
    perform core.record_billing_webhook_event(null, null, null, 'rechazado', 'firma_invalida');
  end loop;
end $$;
reset role;
select count(*) as deberia_ser_200 from core.billing_webhook_log where result = 'rechazado';
rollback;

-- ═══ core.list_billing_webhook_log_for_superadmin (lectura, solo superadmin real) ═══

\echo '=== 10. list_billing_webhook_log_for_superadmin: superadmin-bitacora, con SU PROPIA sesion, ve las 2 filas reales sembradas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
select count(*) as deberia_ser_2 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', null::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 11. list_billing_webhook_log_for_superadmin: filtro por organization_id trae solo la fila resuelta (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
select count(*) as deberia_ser_1 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', null::text, null::text, '00000000-0000-0000-0000-0000000000b9'::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 12. list_billing_webhook_log_for_superadmin: filtro por result=rechazado trae solo la fila sin organizacion resuelta (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
select count(*) as deberia_ser_1 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', 'rechazado'::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 13. list_billing_webhook_log_for_superadmin: staff-bitacora-a (sesion real, NO superadmin) pasando SU PROPIO id obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select count(*) as deberia_ser_0 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b1', null::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 14. list_billing_webhook_log_for_superadmin: staff-bitacora-a pasando el id de superadmin-bitacora como p_caller_id (caller-binding) tambien obtiene CERO filas -- el hueco real que esto cierra: sin la atadura a auth.uid(), cualquier authenticated podria leer la bitacora completa suplantando al superadmin ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select count(*) as deberia_ser_0 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', null::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 15. list_billing_webhook_log_for_superadmin: sesion de SISTEMA (auth.uid() null) pasando el id de superadmin-bitacora tambien obtiene CERO filas -- el patron que apps/api usaria si ProductionCoreRepository olvidara abrir la sesion COMO el caller para esta lectura ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', null::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0);
rollback;

\echo '=== 16. list_billing_webhook_log_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_billing_webhook_log_for_superadmin('00000000-0000-0000-0000-0000000000b3', null::text, null::text, null::uuid, null::timestamptz, null::timestamptz, 50, 0) as should_fail;
rollback;

-- ═══ Garantía estructural -- ver el comentario de cabecera de la migración ═══

\echo '=== 17. core.billing_webhook_log NUNCA tiene columnas de payload/firma cruda (garantia estructural, no solo de comportamiento) ==='
begin;
select count(*) as deberia_ser_0 from information_schema.columns where table_schema = 'core' and table_name = 'billing_webhook_log' and column_name in ('payload', 'raw_payload', 'stripe_signature', 'signature', 'body', 'headers');
rollback;
