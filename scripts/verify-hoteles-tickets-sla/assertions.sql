-- H-05 (P0) -- TICKETS DE HUESPED con SLA, escalacion automatica, bitacora y creacion
-- desde resenas. Verifica contra Postgres REAL (nunca el mirror en memoria de domain-hoteles,
-- que jamas aplica RLS/GRANT/triggers/CHECK) que
-- packages/domain-hoteles/migrations/034_guest_ticket_sla_escalacion.sql cierra lo que dice
-- cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI,
-- auto-descubierto). Mismo patron que verify-hoteles-housekeeping: fixtures persistentes
-- (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion de los negativos: public.verify_expect_error(sql, sqlstate) ejecuta la sentencia
-- bajo el rol/auth.uid() activo y EXIGE el SQLSTATE exacto (42501 = RLS o GRANT, 23514 =
-- CHECK/trigger, 23503 = FK, 23505 = unico, 22023 = parametro invalido). Los positivos y los
-- filtros silenciosos de RLS usan alias con sufijo de valor exacto.
-- La sesion de SISTEMA (cron) es el rol authenticated SIN sub (auth.uid() is null).
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.verify_expect_error(p_sql text, p_sqlstate text) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception 'esperaba SQLSTATE %, obtuve % (%) en: %', p_sqlstate, v_state, v_msg, p_sql;
    end if;
    return;
  end;
  raise exception 'esperaba SQLSTATE % pero la sentencia no fallo: %', p_sqlstate, p_sql;
end;
$$;
grant execute on function public.verify_expect_error(text, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-tk'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-tk')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'reservations-a@example.com', 'Reservations A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a06', 'housekeeping2-a@example.com', 'Housekeeping A2', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a07', 'maintenance-a@example.com', 'Maintenance A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a08', 'fnb-a@example.com', 'FNB A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a09', 'accountant-a@example.com', 'Accountant A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a06', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a07', '00000000-0000-0000-0000-00000000a001', null, 'member', 'maintenance'),
  ('00000000-0000-0000-0000-0000000a0a08', '00000000-0000-0000-0000-00000000a001', null, 'member', 'fnb'),
  ('00000000-0000-0000-0000-0000000a0a09', '00000000-0000-0000-0000-00000000a001', null, 'member', 'accountant'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000bc001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble A'),
  ('00000000-0000-0000-0000-0000000bc002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble B')
on conflict do nothing;
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000ab101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '101', 'disponible'),
  ('00000000-0000-0000-0000-0000000bb201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000bc002', '201', 'disponible')
on conflict do nothing;

-- Resenas fixture: dos en Hotel A (una libre para ligar, otra para el segundo intento) y una en Hotel B.
insert into hoteles.guest_review (id, organization_id, property_id, source, texto, sentiment, sentiment_score) values
  ('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'encuesta_propia', 'El aire acondicionado no funciona', 'negativo', -0.6),
  ('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'encuesta_propia', 'La habitacion estaba sucia', 'muy_negativo', -0.9),
  ('00000000-0000-0000-0000-0000000d0b01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'encuesta_propia', 'Mala atencion', 'negativo', -0.5)
on conflict do nothing;

-- Tickets fixture (superusuario, auth.uid() is null: los triggers derivan org/SLA igual).
insert into hoteles.guest_ticket (id, property_id, department, priority, channel, guest_message, sla_minutes, created_by) values
  ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'staff', 'Fixture frontdesk', 120, '00000000-0000-0000-0000-0000000a0a03'),
  ('00000000-0000-0000-0000-0000000e0a02', '00000000-0000-0000-0000-0000000a1a01', 'fnb', 'alta', 'staff', 'Fixture fnb', 30, '00000000-0000-0000-0000-0000000a0a08'),
  ('00000000-0000-0000-0000-0000000e0b01', '00000000-0000-0000-0000-0000000b1b01', 'frontdesk', 'media', 'staff', 'Fixture hotel B', 120, '00000000-0000-0000-0000-0000000b0b01');

-- =============================================================================
-- (a) Crear tickets: positivo, triggers, GRANT de columna, cross-tenant, anon
-- =============================================================================

\echo '=== 1. frontdesk crea un ticket: org derivada, estado abierto, autoria = auth.uid(), SLA fijado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'Toallas', 120);
select count(*) as creado_deberia_ser_1 from hoteles.guest_ticket
 where guest_message = 'Toallas' and organization_id = '00000000-0000-0000-0000-00000000a001' and status = 'abierto' and created_by = '00000000-0000-0000-0000-0000000a0a03'
   and sla_due_at > now() and escalated_at is null and closed_at is null;
rollback;

\echo '=== 2. cualquier rol hotelero crea (housekeeping, fnb, maintenance) y ve lo que reporto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'maintenance', 'alta', 'Fuga en baño', 30);
select count(*) as propio_visible_deberia_ser_1 from hoteles.guest_ticket where guest_message = 'Fuga en baño';
rollback;

\echo '=== 3. la bitacora registra 'creado' con el actor, sin que el cliente la escriba ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'Bitacora creado', 120);
select count(*) as bitacora_deberia_ser_1 from hoteles.guest_ticket_event e join hoteles.guest_ticket t on t.id = e.ticket_id
 where t.guest_message = 'Bitacora creado' and e.event_type = 'creado' and e.actor_id = '00000000-0000-0000-0000-0000000a0a03' and e.organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 4. mandar organization_id, created_by, sla_due_at, status o campos de escalacion en el INSERT es rechazado por el GRANT de columna (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (organization_id, property_id, department, guest_message, sla_minutes) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (created_by, property_id, department, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (sla_due_at, property_id, department, guest_message, sla_minutes) values (now() + interval '1 year', '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (status, property_id, department, guest_message, sla_minutes) values ('cerrado', '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (escalated_at, property_id, department, guest_message, sla_minutes) values (now(), '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (closed_at, property_id, department, guest_message, sla_minutes) values (now(), '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (sla_warning_notified_at, property_id, department, guest_message, sla_minutes) values (now(), '00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60)$q$, '42501');
rollback;

\echo '=== 5. otro tenant (owner B) no puede crear tickets en la property de Hotel A (42501); property inexistente da 42501 por RLS ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'Intruso', 120)$q$, '42501');
rollback;

\echo '=== 6. anon no puede insertar ni leer tickets (42501) ==='
begin;
set local role anon;
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'Anon', 120)$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.guest_ticket$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.guest_ticket_event$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.ticket_sla_policy$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now())$q$, '42501');
rollback;

\echo '=== 7. CHECKs: mensaje vacio, SLA 0, prioridad/departamento/canal invalidos (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'staff', '', 60)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'staff', 'ok', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'urgente', 'staff', 'ok', 60)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'nadie', 'media', 'staff', 'ok', 60)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'media', 'telepatia', 'ok', 60)$q$, '23514');
rollback;

-- =============================================================================
-- (b) SLA configurable: la politica manda sobre el valor del cliente
-- =============================================================================

\echo '=== 8. owner define la politica (frontdesk, alta) = 10 min; un ticket nuevo ignora el sla_minutes holgado que mande el cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'alta', 10);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'alta', 'Politica manda', 9999);
select count(*) as sla_politica_deberia_ser_1 from hoteles.guest_ticket where guest_message = 'Politica manda' and sla_minutes = 10
 and sla_due_at < now() + interval '11 minutes';
rollback;

\echo '=== 9. la politica de SLA solo la escriben owner/gm: frontdesk, fnb y accountant reciben 42501; gm si puede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60)$q$, '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a09', true);
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60)$q$, '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60) returning id, organization_id, updated_by;
rollback;

\echo '=== 10. la politica: organization_id derivado (no mandable), un SLA por (departamento, prioridad) (23505), rango 1..43200 (23514), otro tenant no escribe (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'media', 45);
select count(*) as derivada_deberia_ser_1 from hoteles.ticket_sla_policy where department = 'fnb' and priority = 'media' and organization_id = '00000000-0000-0000-0000-00000000a001' and updated_by = '00000000-0000-0000-0000-0000000a0a01';
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'media', 50)$q$, '23505');
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (organization_id, property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60)$q$, '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60)$q$, '42501');
rollback;

\echo '=== 11. la politica de otra property no es visible (owner B ve 0 de Hotel A) y staff de A la ve ==='
begin;
insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'fnb', 'baja', 60);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.ticket_sla_policy where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

-- =============================================================================
-- (c) Visibilidad (RLS) y bitacora
-- =============================================================================

\echo '=== 12. fnb NO ve el ticket de frontdesk (fixture) pero SI el de su departamento ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select count(*) as ajeno_deberia_ser_0 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 13. fnb ve el ticket de su departamento ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select count(*) as propio_dept_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a02';
rollback;

\echo '=== 14. owner/gm/frontdesk ven todos los tickets de la property (2 fixtures) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select count(*) as todos_deberia_ser_2 from hoteles.guest_ticket where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 15. cross-tenant: owner B ve solo SU ticket (1), nunca los de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as solo_propios_deberia_ser_1 from hoteles.guest_ticket;
rollback;

\echo '=== 16. el responsable asignado ve un ticket de otro departamento ==='
begin;
update hoteles.guest_ticket set assigned_to = '00000000-0000-0000-0000-0000000a0a07' where id = '00000000-0000-0000-0000-0000000e0a01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a07', true);
select count(*) as asignado_ve_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 17. la bitacora hereda la visibilidad del ticket: fnb no ve eventos del ticket de frontdesk; frontdesk si ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select count(*) as eventos_ajenos_deberia_ser_0 from hoteles.guest_ticket_event where ticket_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 18. frontdesk ve la bitacora de un ticket de la property ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as eventos_visibles_deberia_ser_1 from hoteles.guest_ticket_event where ticket_id = '00000000-0000-0000-0000-0000000e0a01' and event_type = 'creado';
rollback;

\echo '=== 19. la bitacora es inmutable para el cliente: INSERT/UPDATE/DELETE rechazados (42501), igual que DELETE de tickets ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0a01', 'cerrado')$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket_event set event_type = 'cancelado'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.guest_ticket_event$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.guest_ticket$q$, '42501');
rollback;

-- =============================================================================
-- (d) Ciclo de vida: transiciones, columnas inmutables, responsables, departamento
-- =============================================================================

\echo '=== 20. frontdesk toma el ticket: abierto -> en_progreso, con evento de bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000e0a01' returning id, status;
select count(*) as evento_deberia_ser_1 from hoteles.guest_ticket_event where ticket_id = '00000000-0000-0000-0000-0000000e0a01' and event_type = 'en_progreso' and actor_id = '00000000-0000-0000-0000-0000000a0a03';
rollback;

\echo '=== 21. cerrar fija closed_at (derivado) y guarda la nota; un ticket cerrado es inmutable (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set status = 'cerrado', resolution_note = 'Resuelto' where id = '00000000-0000-0000-0000-0000000e0a01';
select count(*) as cerrado_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01' and status = 'cerrado' and closed_at is not null and resolution_note = 'Resuelto';
select public.verify_expect_error($q$update hoteles.guest_ticket set status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '23514');
select public.verify_expect_error($q$update hoteles.guest_ticket set resolution_note = 'otra' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '23514');
rollback;

\echo '=== 22. transicion invalida: en_progreso no regresa a abierto (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000e0a01';
select public.verify_expect_error($q$update hoteles.guest_ticket set status = 'abierto' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '23514');
rollback;

\echo '=== 23. columnas inmutables para el cliente: sla_minutes, sla_due_at, escalated_at, escalated_to_roles, closed_at, organization_id, property_id, room_id, created_by (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$update hoteles.guest_ticket set sla_minutes = 100000 where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set sla_due_at = now() + interval '9 days' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set escalated_at = now() where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set escalated_to_roles = '["owner"]'::jsonb where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set closed_at = now() where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set organization_id = '00000000-0000-0000-0000-00000000b001' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set property_id = '00000000-0000-0000-0000-0000000b1b01' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set room_id = '00000000-0000-0000-0000-0000000ab101' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.guest_ticket set created_by = '00000000-0000-0000-0000-0000000a0a05' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '42501');
rollback;

\echo '=== 24. RLS filtra el UPDATE de un rol sin relacion con el ticket (fnb sobre el de frontdesk): 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
with upd as (update hoteles.guest_ticket set status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000e0a01' returning 1)
select count(*) as filas_deberia_ser_0 from upd;
rollback;

\echo '=== 25. el departamento asignado puede operar su ticket (housekeeping toma uno de housekeeping) ==='
begin;
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'housekeeping', 'media', 'Sabanas', 120);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
with upd as (update hoteles.guest_ticket set status = 'en_progreso' where guest_message = 'Sabanas' returning 1)
select count(*) as filas_deberia_ser_1 from upd;
rollback;

\echo '=== 26. reasignar el departamento: solo manager. housekeeping sobre su ticket recibe 42501; frontdesk si, con bitacora ==='
begin;
insert into hoteles.guest_ticket (property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'housekeeping', 'media', 'Reasignar', 120);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$update hoteles.guest_ticket set department = 'maintenance' where guest_message = 'Reasignar'$q$, '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set department = 'maintenance' where guest_message = 'Reasignar';
select count(*) as evento_dept_deberia_ser_1 from hoteles.guest_ticket_event e join hoteles.guest_ticket t on t.id = e.ticket_id
 where t.guest_message = 'Reasignar' and e.event_type = 'departamento_cambiado' and e.detail->>'a' = 'maintenance';
rollback;

\echo '=== 27. reasignar el departamento NO reinicia el SLA (sla_due_at y sla_minutes no cambian) ==='
begin;
insert into hoteles.guest_ticket (id, property_id, department, priority, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000e0a99', '00000000-0000-0000-0000-0000000a1a01', 'housekeeping', 'media', 'SLA congelado', 120);
create temp table sla_antes as select sla_due_at, sla_minutes from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a99';
grant select on sla_antes to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set department = 'maintenance' where id = '00000000-0000-0000-0000-0000000e0a99';
select count(*) as sla_igual_deberia_ser_1 from hoteles.guest_ticket t join sla_antes a on a.sla_due_at = t.sla_due_at and a.sla_minutes = t.sla_minutes where t.id = '00000000-0000-0000-0000-0000000e0a99';
rollback;

\echo '=== 28. asignar responsable: staff de la property si (bitacora 'asignado'); staff de otro tenant 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set assigned_to = '00000000-0000-0000-0000-0000000a0a05' where id = '00000000-0000-0000-0000-0000000e0a01';
select count(*) as asignado_deberia_ser_1 from hoteles.guest_ticket_event where ticket_id = '00000000-0000-0000-0000-0000000e0a01' and event_type = 'asignado' and detail->>'a' = '00000000-0000-0000-0000-0000000a0a05';
select public.verify_expect_error($q$update hoteles.guest_ticket set assigned_to = '00000000-0000-0000-0000-0000000b0b01' where id = '00000000-0000-0000-0000-0000000e0a01'$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, department, guest_message, sla_minutes, assigned_to) values ('00000000-0000-0000-0000-0000000a1a01', 'frontdesk', 'x', 60, '00000000-0000-0000-0000-0000000b0b01')$q$, '23514');
rollback;

\echo '=== 29. escalacion manual por frontdesk: fija escalated_at y roles gm/owner (derivados) y deja bitacora 'manual' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.guest_ticket set status = 'escalado' where id = '00000000-0000-0000-0000-0000000e0a01';
select count(*) as escalado_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01' and status = 'escalado' and escalated_at is not null and escalated_to_roles = '["gm", "owner"]'::jsonb;
select count(*) as bitacora_manual_deberia_ser_1 from hoteles.guest_ticket_event where ticket_id = '00000000-0000-0000-0000-0000000e0a01' and event_type = 'escalado' and detail->>'origen' = 'manual';
rollback;

\echo '=== 30. un ticket escalado puede volver a en_progreso y cerrarse ==='
begin;
update hoteles.guest_ticket set status = 'escalado' where id = '00000000-0000-0000-0000-0000000e0a01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
update hoteles.guest_ticket set status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000e0a01';
update hoteles.guest_ticket set status = 'cerrado' where id = '00000000-0000-0000-0000-0000000e0a01';
select count(*) as cerrado_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01' and status = 'cerrado' and escalated_at is not null;
rollback;

-- =============================================================================
-- (e) Barrido de SLA (sistema): escalar al vencer + aviso al 75%, idempotente
-- =============================================================================

\echo '=== 31. un usuario autenticado NO puede llamar al barrido (42501); anon tampoco (cubierto arriba) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$select * from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours')$q$, '42501');
rollback;

\echo '=== 32. el barrido de sistema escala los tickets vencidos (2 de Hotel A) a gerente/dueno y es idempotente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as escalados_deberia_ser_2 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours') where out_kind = 'escalado';
rollback;

\echo '=== 33. segunda corrida del barrido: no vuelve a tocar lo ya escalado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
select count(*) as segunda_vez_deberia_ser_0 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
rollback;

\echo '=== 34. el barrido deja estado, roles y bitacora con actor nulo (sistema) y origen sla_vencido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
reset role;
select count(*) as bitacora_sistema_deberia_ser_2 from hoteles.guest_ticket_event
 where ticket_id in ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0a02') and event_type = 'escalado' and actor_id is null and detail->>'origen' = 'sla_vencido';
rollback;

\echo '=== 35. tras el barrido el ticket queda escalado con roles gm/owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
reset role;
select count(*) as roles_deberia_ser_2 from hoteles.guest_ticket where id in ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0a02') and status = 'escalado' and escalated_at is not null and escalated_to_roles = '["gm", "owner"]'::jsonb;
rollback;

\echo '=== 36. aviso temprano: al 75% del SLA (90 de 120 min) sin vencer solo AVISA (no escala) y es idempotente ==='
begin;
create temp table t0 as select created_at from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
grant select on t0 to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as avisados_deberia_ser_1 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', (select created_at from t0) + interval '100 minutes') where out_kind = 'aviso_sla' and out_ticket_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 37. aviso temprano: el ticket sigue abierto, con la marca de aviso y bitacora aviso_sla; la 2da corrida no repite ==='
begin;
create temp table t0 as select created_at from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
grant select on t0 to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', (select created_at from t0) + interval '100 minutes');
select count(*) as repetido_deberia_ser_0 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', (select created_at from t0) + interval '100 minutes') where out_ticket_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 38. aviso temprano deja status abierto, sla_warning_notified_at y evento aviso_sla ==='
begin;
create temp table t0 as select created_at from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
grant select on t0 to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', (select created_at from t0) + interval '100 minutes');
reset role;
select count(*) as marcado_deberia_ser_1 from hoteles.guest_ticket t where t.id = '00000000-0000-0000-0000-0000000e0a01' and t.status = 'abierto' and t.sla_warning_notified_at is not null
 and exists (select 1 from hoteles.guest_ticket_event e where e.ticket_id = t.id and e.event_type = 'aviso_sla');
rollback;

\echo '=== 39. antes del 75% (60 de 120 min) no pasa nada ==='
begin;
create temp table t0 as select created_at from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0a01';
grant select on t0 to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as nada_deberia_ser_0 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', (select created_at from t0) + interval '60 minutes') where out_ticket_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 40. el barrido de una property no toca la de otra (Hotel B sigue abierto) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
reset role;
select count(*) as hotel_b_abierto_deberia_ser_1 from hoteles.guest_ticket where id = '00000000-0000-0000-0000-0000000e0b01' and status = 'abierto' and escalated_at is null;
rollback;

\echo '=== 41. el barrido ignora tickets ya cerrados o cancelados ==='
begin;
update hoteles.guest_ticket set status = 'cancelado' where id = '00000000-0000-0000-0000-0000000e0a02';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as cerrado_ignorado_deberia_ser_1 from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now() + interval '3 hours');
rollback;

\echo '=== 42. parametro de umbral invalido: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.verify_expect_error($q$select * from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now(), 0)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.sweep_guest_ticket_sla('00000000-0000-0000-0000-0000000a1a01', now(), 1.5)$q$, '22023');
rollback;

-- =============================================================================
-- (f) Creacion desde resenas y aislamiento de FKs
-- =============================================================================

\echo '=== 43. ticket desde una resena negativa de la property (canal resena) y queda ligado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a01', 'maintenance', 'alta', 'resena', 'Resena: aire acondicionado', 30);
select count(*) as ligado_deberia_ser_1 from hoteles.guest_ticket where guest_review_id = '00000000-0000-0000-0000-0000000d0a01' and channel = 'resena' and department = 'maintenance';
rollback;

\echo '=== 44. a lo sumo UN ticket activo por resena (23505); al cerrarlo se puede crear otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a01', 'maintenance', 'alta', 'resena', 'Primero', 30);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a01', 'housekeeping', 'media', 'resena', 'Segundo', 60)$q$, '23505');
update hoteles.guest_ticket set status = 'cerrado' where guest_message = 'Primero';
insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a01', 'housekeeping', 'media', 'resena', 'Tercero', 60);
select count(*) as activo_deberia_ser_1 from hoteles.guest_ticket where guest_review_id = '00000000-0000-0000-0000-0000000d0a01' and status not in ('cerrado', 'cancelado');
rollback;

\echo '=== 45. una resena de OTRA property no se puede ligar a un ticket de esta (FK compuesta, 23503) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0b01', 'maintenance', 'alta', 'resena', 'Cruzada', 30)$q$, '23503');
rollback;

\echo '=== 46. guest_review_id exige canal resena (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, guest_review_id, department, priority, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a01', 'maintenance', 'alta', 'staff', 'Canal malo', 30)$q$, '23514');
rollback;

\echo '=== 47. una habitacion de OTRA property no se puede ligar al ticket (FK compuesta, 23503); la propia si ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.guest_ticket (property_id, room_id, department, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bb201', 'frontdesk', 'Cuarto ajeno', 60)$q$, '23503');
insert into hoteles.guest_ticket (property_id, room_id, department, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab101', 'frontdesk', 'Cuarto propio', 60);
select count(*) as cuarto_deberia_ser_1 from hoteles.guest_ticket where guest_message = 'Cuarto propio' and room_id = '00000000-0000-0000-0000-0000000ab101';
rollback;

\echo '=== 48. borrar la resena (service) conserva el ticket y solo anula el enlace ==='
begin;
insert into hoteles.guest_ticket (property_id, guest_review_id, department, channel, guest_message, sla_minutes) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0a02', 'housekeeping', 'resena', 'Con resena', 60);
delete from hoteles.guest_review where id = '00000000-0000-0000-0000-0000000d0a02';
select count(*) as ticket_sobrevive_deberia_ser_1 from hoteles.guest_ticket where guest_message = 'Con resena' and guest_review_id is null and channel = 'resena';
rollback;

-- =============================================================================
-- (g) Compatibilidad con la base SIN migrar: el repositorio degrada con SAVEPOINT
-- =============================================================================

\echo '=== 49. con hoteles.guest_ticket ELIMINADA (42P01) el SAVEPOINT recupera la transaccion ==='
begin;
drop table hoteles.guest_ticket cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_ticket_missing;
do $$
declare
  v_state text;
begin
  begin
    perform count(*) from hoteles.guest_ticket;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_ticket_missing;
release savepoint sp_verify_ticket_missing;
select count(*) as resenas_visibles_deberia_ser_2 from hoteles.guest_review where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 50. control: tras el DDL destructivo revertido los tickets siguen intactos ==='
begin;
select count(*) as tickets_intactos_deberia_ser_3 from hoteles.guest_ticket;
rollback;
