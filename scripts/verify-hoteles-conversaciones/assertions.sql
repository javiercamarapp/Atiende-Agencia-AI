-- H-20 -- BANDEJA DE CONVERSACIONES DE WHATSAPP CON HANDOFF A HUMANO. Verifica contra Postgres REAL (nunca el mirror en
-- memoria, que jamas aplica RLS/GRANT/CHECK) que packages/domain-hoteles/migrations/043_hoteles_conversaciones_handoff.sql
-- cierra lo que dice cerrar: transiciones agente/humano/cerrada, tomar con un solo ganador, responsable, notas
-- append-only, respuesta humana encolada en messaging_outbox, funciones de solo-sistema, cross-tenant y anon. Corre via
-- ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto). Mismo patron que
-- verify-hoteles-recepcion-ficha: fixtures persistentes (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion: public.verify_expect_error(sql, sqlstate) EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/guard,
-- 22023 = parametro invalido, 55000 = estado invalido, P0002 = no encontrada/otro tenant, 23P01 = traslape de habitacion,
-- 23503 = referencia invalida). public.verify_assert(cond, msg) falla el escenario si cond no es cierto. Los positivos con
-- valor usan alias con sufijo de valor exacto (..._deberia_ser_N) en la ULTIMA sentencia del escenario (una sola por
-- escenario). public.verify_as(sub) fija el rol authenticated con auth.uid() = sub; sub vacio = SESION DE SISTEMA
-- (auth.uid() is null). public.verify_su() vuelve al superusuario.
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

create or replace function public.verify_assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'asercion fallida: %', p_msg;
  end if;
end;
$$;
grant execute on function public.verify_assert(boolean, text) to public;

create or replace function public.verify_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
end;
$$;
create or replace function public.verify_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create or replace function public.verify_su() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function public.verify_as(text), public.verify_anon(), public.verify_su() to public;


-- Estado de una conversacion leido sin RLS (security definer) para aserciones entre roles.
create or replace function public.verify_conv(p_id uuid) returns text language sql security definer as $$
  select modo || '|' || coalesce(responsable_id::text, '-') || '|' || no_leidos || '|' || handoff_n from hoteles.whatsapp_conversations where id = p_id
$$;
create or replace function public.verify_outbox_n(p_property uuid) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.messaging_outbox where property_id = p_property and event_type = 'whatsapp.respuesta_humana'
$$;
grant execute on function public.verify_conv(uuid), public.verify_outbox_n(uuid) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-cv'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-cv')
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
  ('00000000-0000-0000-0000-0000000a0a09', 'accountant-a@example.com', 'Accountant A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a09', '00000000-0000-0000-0000-00000000a001', null, 'member', 'accountant'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id, enabled) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '10000000000001', true),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', '10000000000002', true)
on conflict do nothing;
insert into hoteles.guest (id, organization_id, property_id, full_name, email, phone) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Ana Torres', 'ana@example.com', '5511112222')
on conflict do nothing;
-- C1: conversacion del huesped Ana, atendida por el agente, con un mensaje del huesped reciente.
-- C2: otro telefono. CB: conversacion de OTRO hotel.
insert into hoteles.whatsapp_conversations (id, organization_id, property_id, phone, messages, ultimo_entrante_en) values
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+5215511112222', '[{"role":"user","content":"Hola, quiero late check-out"},{"role":"assistant","content":"Con gusto, una persona le ayuda"}]'::jsonb, now()),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+5215599990000', '[{"role":"user","content":"Buenas"}]'::jsonb, now()),
  ('00000000-0000-0000-0000-00000000c3b1', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '+5215500001111', '[{"role":"user","content":"Hola B"}]'::jsonb, now())
on conflict do nothing;

-- =============================================================================
-- (a) Funciones de sistema (webhook)
-- =============================================================================

\echo '=== 1. el sistema registra un entrante: suma un no leido, marca la hora y no cambia el modo ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215511112222') = 'agente', 'devuelve el modo actual');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215511112222') = 'agente', 'segundo entrante');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'agente|-|2|0', 'dos no leidos, sigue en agente');
select public.verify_as('');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+0000') is null, 'telefono inexistente devuelve null');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000b1b01', '+5215511112222') is null, 'otra property no encuentra la conversacion');
rollback;

\echo '=== 2. un usuario real no puede llamar a las funciones de sistema (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215511112222')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'agente_derivo')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215511112222')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'agente_derivo')$q$, '42501');
select 1 as ok_sistema_solo;
rollback;

\echo '=== 3. derivar a humano: la primera derivacion cambia el estado y cuenta; la repetida no ==='
begin;
select public.verify_as('');
select public.verify_assert((select transicion from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'agente_derivo')) is true, 'primera derivacion hace transicion');
select public.verify_assert((select transicion from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'agente_derivo')) is false, 'segunda no repite');
select public.verify_assert((select handoff_n from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'agente_derivo')) = 1, 'solo una derivacion contada');
select public.verify_assert((select count(*) from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+0000', 'agente_derivo') where transicion) = 0, 'telefono inexistente: sin transicion');
select public.verify_expect_error($q$select * from hoteles.conversacion_derivar_a_humano('00000000-0000-0000-0000-0000000a1a01', '+5215511112222', 'Motivo con espacios')$q$, '22023');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'humano|-|0|1', 'humano sin responsable, una derivacion');
rollback;

\echo '=== 4. un entrante sobre una conversacion cerrada la reabre con el agente; en humano no la suelta ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'cerrada', cerrada_en = now() where id = '00000000-0000-0000-0000-00000000c301';
update hoteles.whatsapp_conversations set modo = 'humano', responsable_id = '00000000-0000-0000-0000-0000000a0a03', tomada_en = now() where id = '00000000-0000-0000-0000-00000000c302';
select public.verify_as('');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215511112222') = 'agente', 'cerrada vuelve al agente');
select public.verify_assert(hoteles.conversacion_registrar_entrante('00000000-0000-0000-0000-0000000a1a01', '+5215599990000') = 'humano', 'humano sigue en humano');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c302') = 'humano|00000000-0000-0000-0000-0000000a0a03|1|0', 'el responsable se conserva');
select public.verify_assert((select cerrada_en from hoteles.whatsapp_conversations where id = '00000000-0000-0000-0000-00000000c301') is null, 'cerrada_en se limpia');
rollback;

-- =============================================================================
-- (b) Bandeja y detalle (staff)
-- =============================================================================

\echo '=== 5. la bandeja lista solo las conversaciones de la property, con huesped enlazado por telefono y vista previa ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')) = 2, 'dos conversaciones del hotel A');
select public.verify_assert((select huesped_nombre from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01') where id = '00000000-0000-0000-0000-00000000c301') = 'Ana Torres', 'huesped enlazado por los ultimos 10 digitos');
select public.verify_assert((select vista_previa from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01') where id = '00000000-0000-0000-0000-00000000c301') = 'Con gusto, una persona le ayuda', 'vista previa del ultimo mensaje');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', null, false, '5511112222')) = 1, 'filtro por telefono (clave de 10 digitos)');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', 'humano')) = 0, 'ninguna en humano todavia');
select public.verify_assert((select max(total) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', null, false, null, 1, 0)) = 2, 'total independiente de la pagina');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', 'otro')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', null, false, null, 101, 0)$q$, '22023');
rollback;

\echo '=== 6. filtros por estado y no leidas; por_atender = humano sin responsable ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'humano', no_leidos = 3 where id = '00000000-0000-0000-0000-00000000c301';
update hoteles.whatsapp_conversations set modo = 'humano', responsable_id = '00000000-0000-0000-0000-0000000a0a03', tomada_en = now() where id = '00000000-0000-0000-0000-00000000c302';
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', 'por_atender')) = 1, 'solo la que nadie tomo');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', 'humano')) = 2, 'las dos en humano');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01', null, true)) = 1, 'solo la que tiene no leidos');
select public.verify_assert((select id from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01') limit 1) = '00000000-0000-0000-0000-00000000c301', 'la que espera atencion va primero');
select public.verify_assert((select responsable_nombre from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01') where id = '00000000-0000-0000-0000-00000000c302') = 'Frontdesk A', 'nombre del responsable');
rollback;

\echo '=== 7. roles sin acceso a conversaciones (housekeeping, contabilidad) y otro tenant: no ven nada (P0002) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
select public.verify_expect_error($q$select hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', 'intruso')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'intruso')$q$, 'P0002');
select public.verify_assert((select count(*) from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000b1b01')) = 1, 'su propia property si la ve');
rollback;

\echo '=== 8. anon: sin EXECUTE en las funciones y sin SELECT en las tablas ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'x')$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.whatsapp_conversations$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.conversacion_nota$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.messaging_outbox$q$, '42501');
select 1 as ok_anon_sin_acceso;
rollback;

\echo '=== 9. el detalle trae mensajes, responsable y huesped; un usuario sin sesion de usuario (sistema) no lo lee ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_assert((select jsonb_array_length(mensajes) from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')) = 2, 'dos mensajes');
select public.verify_assert((select total_mensajes from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')) = 2, 'total de mensajes');
select public.verify_assert((select huesped_nombre from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')) = 'Ana Torres', 'huesped');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.conversaciones_listar('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select 1 as ok_sistema_no_lee_bandeja;
rollback;

\echo '=== 10. marcar leida pone el contador en cero (cualquier rol de reservas de la property) ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set no_leidos = 4 where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select hoteles.conversacion_leer('00000000-0000-0000-0000-00000000c301');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'agente|-|0|0', 'contador en cero');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select hoteles.conversacion_leer('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
rollback;

-- =============================================================================
-- (c) Tomar, devolver, cerrar
-- =============================================================================

\echo '=== 11. tomar: el primero gana; el segundo recibe 55000 ya_tomada; el mismo usuario es idempotente ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'humano' where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select modo from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')) = 'humano', 'frontdesk toma');
select public.verify_assert((select responsable_id from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')) = '00000000-0000-0000-0000-0000000a0a03'::uuid, 'idempotente para el mismo usuario');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')$q$, '55000');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'humano|00000000-0000-0000-0000-0000000a0a03|0|0', 'sigue con el primero');
rollback;

\echo '=== 12. tomar directo desde el agente deja el motivo; reasignar solo owner/gm ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_assert((select responsable_id from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c302')) = '00000000-0000-0000-0000-0000000a0a04'::uuid, 'reservations toma una atendida por el agente');
select public.verify_su();
select public.verify_assert((select handoff_motivo from hoteles.whatsapp_conversations where id = '00000000-0000-0000-0000-00000000c302') = 'tomada_por_personal', 'motivo tomada_por_personal');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c302', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_assert((select responsable_id from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c302', true)) = '00000000-0000-0000-0000-0000000a0a02'::uuid, 'gm reasigna');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c302') = 'humano|00000000-0000-0000-0000-0000000a0a02|0|0', 'responsable gm');
rollback;

\echo '=== 13. no se toma una conversacion cerrada (55000) ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'cerrada', cerrada_en = now() where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301')$q$, '55000');
select 1 as ok_cerrada_no_se_toma;
rollback;

\echo '=== 14. devolver al agente: el responsable o owner/gm; otro rol no (42501); sin humano 55000 ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'humano', responsable_id = '00000000-0000-0000-0000-0000000a0a03', tomada_en = now() where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select hoteles.conversacion_devolver('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert(hoteles.conversacion_devolver('00000000-0000-0000-0000-00000000c301') = 'agente', 'el responsable devuelve');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'agente|-|0|0', 'vuelve al agente sin responsable');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.conversacion_devolver('00000000-0000-0000-0000-00000000c301')$q$, '55000');
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'humano', responsable_id = '00000000-0000-0000-0000-0000000a0a03', tomada_en = now() where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_assert(hoteles.conversacion_devolver('00000000-0000-0000-0000-00000000c301') = 'agente', 'gm puede devolver la de otro');
rollback;

\echo '=== 15. cerrar: limpia responsable y no leidos; otro rol no cierra la de alguien (42501); ya cerrada 55000 ==='
begin;
select public.verify_su();
update hoteles.whatsapp_conversations set modo = 'humano', responsable_id = '00000000-0000-0000-0000-0000000a0a03', tomada_en = now(), no_leidos = 5 where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select hoteles.conversacion_cerrar('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert(hoteles.conversacion_cerrar('00000000-0000-0000-0000-00000000c301') = 'cerrada', 'el responsable cierra');
select public.verify_su();
select public.verify_assert(public.verify_conv('00000000-0000-0000-0000-00000000c301') = 'cerrada|-|0|0', 'cerrada sin responsable');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.conversacion_cerrar('00000000-0000-0000-0000-00000000c301')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_assert(hoteles.conversacion_cerrar('00000000-0000-0000-0000-00000000c302') = 'cerrada', 'cualquier rol cierra una atendida por el agente');
rollback;

\echo '=== 16. el estado no se puede escribir directo: sin UPDATE para authenticated (42501) y CHECK del responsable (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$update hoteles.whatsapp_conversations set modo = 'humano' where id = '00000000-0000-0000-0000-00000000c301'$q$, '42501');
select public.verify_expect_error($q$update hoteles.whatsapp_conversations set responsable_id = '00000000-0000-0000-0000-0000000a0a01' where id = '00000000-0000-0000-0000-00000000c301'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.whatsapp_conversations where id = '00000000-0000-0000-0000-00000000c301'$q$, '42501');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.whatsapp_conversations set responsable_id = '00000000-0000-0000-0000-0000000a0a03' where id = '00000000-0000-0000-0000-00000000c301'$q$, '23514');
select public.verify_expect_error($q$update hoteles.whatsapp_conversations set modo = 'otro' where id = '00000000-0000-0000-0000-00000000c301'$q$, '23514');
select public.verify_expect_error($q$update hoteles.whatsapp_conversations set handoff_motivo = 'Con Espacios' where id = '00000000-0000-0000-0000-00000000c301'$q$, '23514');
select 1 as ok_estado_protegido;
rollback;

-- =============================================================================
-- (d) Notas internas
-- =============================================================================

\echo '=== 17. notas: autor y organizacion los fija la base; se leen por rol de reservas; append-only ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert(hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', '  Pidio late check-out hasta las 3 pm  ') is not null, 'nota creada');
select public.verify_assert((select count(*) from hoteles.conversacion_nota where conversation_id = '00000000-0000-0000-0000-00000000c301' and author_id = '00000000-0000-0000-0000-0000000a0a03' and organization_id = '00000000-0000-0000-0000-00000000a001' and body = 'Pidio late check-out hasta las 3 pm') = 1, 'autor y organizacion derivados, texto recortado');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_assert((select count(*) from hoteles.conversacion_nota where conversation_id = '00000000-0000-0000-0000-00000000c301') = 1, 'otro rol de reservas la ve');
select public.verify_assert((select autor_nombre from hoteles.conversacion_notas('00000000-0000-0000-0000-00000000c301')) = 'Frontdesk A', 'la funcion de lectura trae el nombre del autor');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.conversacion_nota) = 0, 'housekeeping no ve notas (RLS)');
select public.verify_expect_error($q$select hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', 'intruso')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.conversacion_notas('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.conversacion_nota) = 0, 'otro tenant no ve notas');
select public.verify_expect_error($q$select * from hoteles.conversacion_notas('00000000-0000-0000-0000-00000000c301')$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.conversacion_nota (organization_id, property_id, conversation_id, author_id, body) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-0000000a0a01', 'falsificada')$q$, '42501');
select public.verify_expect_error($q$update hoteles.conversacion_nota set body = 'x'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.conversacion_nota$q$, '42501');
select 1 as ok_notas_append_only;
rollback;

\echo '=== 18. notas: minimizacion (13 a 19 digitos) y longitud ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', 'Tarjeta 4111 1111 1111 1111')$q$, '22023');
select public.verify_expect_error($q$select hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', '   ')$q$, '22023');
select public.verify_expect_error($q$select hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', repeat('x', 1001))$q$, '22023');
select public.verify_assert(hoteles.conversacion_agregar_nota('00000000-0000-0000-0000-00000000c301', repeat('x', 1000)) is not null, 'el limite exacto pasa');
rollback;

-- =============================================================================
-- (e) Responder (outbox)
-- =============================================================================

\echo '=== 19. responder: solo el responsable con la conversacion en humano; encola en outbox con destino y canal de la base ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'Hola')$q$, '55000');
select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'Hola')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select envio from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', '  Claro, el late check-out es a las 3 pm  ')) = 'pending', 'queda pendiente de envio');
select public.verify_su();
select public.verify_assert(public.verify_outbox_n('00000000-0000-0000-0000-0000000a1a01') = 1, 'una fila en el outbox');
select public.verify_assert((select payload ->> 'to' from hoteles.messaging_outbox where property_id = '00000000-0000-0000-0000-0000000a1a01' and event_type = 'whatsapp.respuesta_humana') = '+5215511112222', 'destino = telefono de la conversacion');
select public.verify_assert((select payload ->> 'phone_number_id' from hoteles.messaging_outbox where property_id = '00000000-0000-0000-0000-0000000a1a01' and event_type = 'whatsapp.respuesta_humana') = '10000000000001', 'numero de la property');
select public.verify_assert((select payload ->> 'body' from hoteles.messaging_outbox where property_id = '00000000-0000-0000-0000-0000000a1a01' and event_type = 'whatsapp.respuesta_humana') = 'Claro, el late check-out es a las 3 pm', 'texto recortado');
select public.verify_assert((select status from hoteles.messaging_outbox where property_id = '00000000-0000-0000-0000-0000000a1a01' and event_type = 'whatsapp.respuesta_humana') = 'pending', 'pending');
select public.verify_assert((select messages -> -1 ->> 'origen' from hoteles.whatsapp_conversations where id = '00000000-0000-0000-0000-00000000c301') = 'humano', 'queda en el historial como humano');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select mensajes -> -1 ->> 'envio' from hoteles.conversacion_detalle('00000000-0000-0000-0000-00000000c301')) = 'pending', 'el detalle muestra el estado de envio');
rollback;

\echo '=== 20. responder: validaciones (texto, tarjeta, ventana de 24 h, canal) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.conversacion_tomar('00000000-0000-0000-0000-00000000c301');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', '   ')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', repeat('x', 1001))$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'Mi tarjeta 4111111111111111')$q$, '22023');
select public.verify_su();
update hoteles.whatsapp_conversations set ultimo_entrante_en = now() - interval '25 hours' where id = '00000000-0000-0000-0000-00000000c301';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'Hola')$q$, '55000');
select public.verify_su();
update hoteles.whatsapp_conversations set ultimo_entrante_en = now() where id = '00000000-0000-0000-0000-00000000c301';
update hoteles.whatsapp_channel_config set enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.conversacion_responder('00000000-0000-0000-0000-00000000c301', 'Hola')$q$, '55000');
select public.verify_su();
select public.verify_assert(public.verify_outbox_n('00000000-0000-0000-0000-0000000a1a01') = 0, 'ninguna de las respuestas rechazadas encolo nada');
rollback;

\echo '=== 21. responder: el cliente no puede escribir en el outbox ni leerlo directo ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.messaging_outbox (property_id, organization_id, channel, event_type, dedupe_key, payload) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'whatsapp', 'x', 'k', '{}'::jsonb)$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.messaging_outbox$q$, '42501');
select public.verify_expect_error($q$select hoteles.conversacion_autorizar('00000000-0000-0000-0000-00000000c301')$q$, '42501');
select 1 as ok_outbox_cerrado;
rollback;

\echo '=== 22. privilegios de las funciones: security definer, search_path fijo y sin EXECUTE para anon ==='
begin;
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hoteles' and (p.proname like 'conversacion\_%' or p.proname = 'conversaciones_listar')
    and not (p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))) = 0, 'todas security definer con search_path fijo');
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hoteles' and (p.proname like 'conversacion\_%' or p.proname = 'conversaciones_listar')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))) = 0, 'sin EXECUTE para anon ni public');
select public.verify_assert(not has_table_privilege('authenticated', 'hoteles.conversacion_nota', 'insert'), 'authenticated no inserta notas');
select public.verify_assert(not has_table_privilege('authenticated', 'hoteles.whatsapp_conversations', 'update'), 'authenticated no actualiza conversaciones');
select 1 as ok_privilegios;
rollback;

\echo 'Escenarios 1 a 22 deben terminar sin error: cada verify_assert/verify_expect_error falla el escenario si no se cumple.'
