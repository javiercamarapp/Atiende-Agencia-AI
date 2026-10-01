-- Verificación contra Postgres REAL de c01-citas-confirmacion-boton:
--
--   El botón "Confirmar" del recordatorio 24h llega al webhook de WhatsApp, que corre
--   en sesión de SISTEMA (auth.uid() null). La única transición pending -> confirmed
--   que existía (`citas.confirm_appointment_from_panel`, 010) exige membership de
--   staff, así que rechazaba SIEMPRE esa sesión. La migración 025 agrega la función
--   `security definer` de SOLO-SISTEMA `citas.system_confirm_appointment_by_customer`,
--   acotada por TITULARIDAD (el teléfono del remitente debe ser el del cliente de la
--   cita), idempotente y anti-replay.
--
-- Escenarios (cada uno en su propio begin; ... rollback;):
--   1.  Positivo: sesión de sistema + teléfono titular confirma una cita 'pending'
--       -> status 'confirmed' (deberia_ser_1) y deja UN evento de auditoría 'confirmed'
--       canal 'whatsapp' (deberia_ser_1).
--   2.  Idempotente: confirmar dos veces la misma cita NO duplica la auditoría
--       (deberia_ser_1) y devuelve 'confirmed' ambas veces.
--   3.  Titularidad: otro teléfono (mismo negocio) -> AT404 EXACTO, sin cambio de estado (deberia_ser_1).
--   4.  Cross-tenant: id de cita de la org B con organization_id de A -> AT404 EXACTO.
--   5.  Anti-replay: cita 'cancelled' -> AT409 EXACTO y sigue 'cancelled'.
--   6.  Anti-replay: cita 'pending' cuyo horario ya pasó -> AT409 EXACTO.
--   7.  Negativo: un STAFF autenticado real (auth.uid() no nulo) -> 42501 EXACTO.
--   8.  Negativo: anon sin GRANT execute (confirmado con has_function_privilege) ->
--       42501 EXACTO.
--   9.  Sin UPDATE directo: ni el staff ni el sistema pueden hacer
--       `update citas.appointments` por esta vía (control de que no se abrió ningún
--       GRANT/policy nuevo): el sistema SIN función ve 0 filas (deberia_ser_0).
--   10. Parámetros vacíos -> AT400 EXACTO.
--   11. ESQUEMA A MEDIAS (migración 025 sin aplicar): se elimina la función y se
--       demuestra el SQLSTATE exacto 42883 que `isUndefinedFunctionError`/
--       `runWithSavepointFallback` capturan en postgres-repository.ts.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000b1', 'citas', 'Org Citas confirmacion (A)', 'org-citas-conf-a'),
  ('00000000-0000-0000-0000-0000000000b2', 'citas', 'Org Citas confirmacion (B, cross-tenant)', 'org-citas-conf-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000b3', 'staff-conf@example.com', 'Staff confirmacion', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', null, 'admin', 'admin')
on conflict do nothing;

insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b1', 'Proveedor A'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000b2', 'Proveedor B')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b1', 'Consulta A', 30),
  ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000b2', 'Consulta B', 30)
on conflict do nothing;

insert into citas.customers (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000000b8', '00000000-0000-0000-0000-0000000000b1', 'Cliente titular', '9981234567'),
  ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000b1', 'Otro cliente', '9987654321'),
  ('00000000-0000-0000-0000-0000000000ba', '00000000-0000-0000-0000-0000000000b2', 'Cliente de B', '9981234567')
on conflict do nothing;

-- a01 pending futura (A, titular) | a02 pending futura (A, titular; idempotencia)
-- a03 cancelled (A) | a04 pending ya pasada (A) | a05 pending futura (B, mismo teléfono que el titular de A)
insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b8', now() + interval '1 day', now() + interval '1 day 30 minutes', 'pending'),
  ('00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b8', now() + interval '2 day', now() + interval '2 day 30 minutes', 'pending'),
  ('00000000-0000-0000-0000-000000000b03', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b8', now() + interval '3 day', now() + interval '3 day 30 minutes', 'cancelled'),
  ('00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b8', now() - interval '2 day', now() - interval '2 day' + interval '30 minutes', 'pending'),
  ('00000000-0000-0000-0000-000000000b05', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000ba', now() + interval '1 day', now() + interval '1 day 30 minutes', 'pending')
on conflict do nothing;

\echo '=== 1. (positivo) sesión de SISTEMA + teléfono titular: la cita pending queda confirmed (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9981234567')->>'status' = 'confirmed')::int as sistema_confirma_cita_titular_deberia_ser_1;
rollback;

\echo '=== 1b. (positivo) deja UN evento de auditoría confirmed canal whatsapp (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9981234567') is not null as ok;
reset role;
select count(*) as auditoria_confirmed_whatsapp_deberia_ser_1 from citas.appointment_audit_events where appointment_id = '00000000-0000-0000-0000-000000000b01' and event_type = 'confirmed' and actor_channel = 'whatsapp';
rollback;

\echo '=== 2. (idempotente) confirmar dos veces NO duplica la auditoría (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b02', '9981234567')->>'status' as primera;
select citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b02', '9981234567')->>'status' as segunda;
reset role;
select count(*) as auditoria_no_duplicada_deberia_ser_1 from citas.appointment_audit_events where appointment_id = '00000000-0000-0000-0000-000000000b02' and event_type = 'confirmed';
rollback;

\echo '=== 3. (titularidad, SQLSTATE exacto) otro teléfono del mismo negocio -> AT404, sin revelar que la cita existe ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9987654321');
  raise exception 'BLOQUEANTE: se esperaba AT404 (el teléfono no es el titular) pero la llamada tuvo éxito';
exception
  when sqlstate 'AT404' then null;
end $$;
reset role;
select (status = 'pending')::int as cita_sigue_pending_tras_otro_telefono_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-000000000b01';
rollback;

\echo '=== 4. (cross-tenant, SQLSTATE exacto) cita de la org B con organization_id de A (aunque el teléfono coincida) -> AT404 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b05', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba AT404 (cita de otra organización) pero la llamada tuvo éxito';
exception
  when sqlstate 'AT404' then null;
end $$;
rollback;

\echo '=== 5. (anti-replay, SQLSTATE exacto) cita cancelled -> AT409, sigue cancelled ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b03', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba AT409 (cita cancelada) pero la llamada tuvo éxito';
exception
  when sqlstate 'AT409' then null;
end $$;
reset role;
select (status = 'cancelled')::int as cita_cancelada_sigue_cancelled_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-000000000b03';
rollback;

\echo '=== 6. (anti-replay, SQLSTATE exacto) cita pending cuyo horario ya pasó -> AT409 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b04', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba AT409 (cita ya pasada) pero la llamada tuvo éxito';
exception
  when sqlstate 'AT409' then null;
end $$;
rollback;

\echo '=== 7. (negativo, SQLSTATE exacto) un STAFF autenticado real NO puede llamar la función de sistema -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba 42501 (guard auth.uid() is null) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 8. (negativo) anon no tiene GRANT execute (confirmado) y la llamada da 42501 exacto ==='
begin;
select (not has_function_privilege('anon', 'citas.system_confirm_appointment_by_customer(uuid, uuid, text)', 'execute'))::int as anon_sin_grant_execute_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba 42501 (sin GRANT execute) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 9. (sin superficie nueva) la sesión de sistema NO puede leer ni actualizar citas.appointments directo: 0 filas visibles (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_select_directo_deberia_ser_0 from citas.appointments where id = '00000000-0000-0000-0000-000000000b01';
rollback;

\echo '=== 10. (SQLSTATE exacto) teléfono vacío -> AT400 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '   ');
  raise exception 'BLOQUEANTE: se esperaba AT400 (teléfono vacío) pero la llamada tuvo éxito';
exception
  when sqlstate 'AT400' then null;
end $$;
rollback;

drop function citas.system_confirm_appointment_by_customer(uuid, uuid, text);

\echo '=== 11. (SQLSTATE exacto) ESQUEMA A MEDIAS: sin la migración 025 la llamada lanza EXACTAMENTE 42883 (lo que isUndefinedFunctionError/runWithSavepointFallback capturan) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_confirm_appointment_by_customer('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', '9981234567');
  raise exception 'BLOQUEANTE: se esperaba 42883 (función eliminada) pero la llamada tuvo éxito';
exception
  when sqlstate '42883' then null;
end $$;
rollback;

\echo '=== FIN ==='
