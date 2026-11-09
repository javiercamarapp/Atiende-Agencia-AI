-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/107_aviso_en_camino.sql (aviso «su pedido va en camino»):
--
--   A. aviso_en_camino_contexto: interruptor (encendido sin fila), ventana de 23 h por las huellas del telefono del PEDIDO, consentimiento (091),
--      plantilla aprobada SOLO de la organizacion y del evento `order.en_camino`, «ya avisado». Quien puede leerlo: sistema, gestor con alcance a la
--      sucursal y el chofer ASIGNADO; staff de otra sucursal, chofer ajeno, otro tenant y anon no.
--   B. aviso_en_camino_marcar: registra el estado; un aviso ya encolado no se pisa; estado invalido 22023; ajenos 42501.
--   C. Interruptor: solo owner/admin de toda la organizacion lo cambia; nadie lee ni escribe la tabla directo.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el valor esperado;
-- t_esperar_error exige el SQLSTATE exacto.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

create or replace function public.t_como(p_uid text) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_uid, true) $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e9401', 'restaurantes', 'En camino Org A', 'en-camino-a'),
  ('00000000-0000-0000-0000-0000000e9402', 'restaurantes', 'En camino Org B (ajena)', 'en-camino-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e94a1', '00000000-0000-0000-0000-0000000e9401', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e94a2', '00000000-0000-0000-0000-0000000e9401', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e94b1', '00000000-0000-0000-0000-0000000e9402', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e9411', 'owner-a@camino.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e9412', 'staff-a1@camino.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e9413', 'staff-a2@camino.example.com', 'Staff A2', 'seed'),
  ('00000000-0000-0000-0000-0000000e9414', 'chofer-a1@camino.example.com', 'Chofer A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e9415', 'chofer-a1b@camino.example.com', 'Chofer A1 ajeno', 'seed'),
  ('00000000-0000-0000-0000-0000000e9416', 'admin-a1@camino.example.com', 'Admin A1 acotado', 'seed'),
  ('00000000-0000-0000-0000-0000000e9417', 'owner-b@camino.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e9411', '00000000-0000-0000-0000-0000000e9401', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e9412', '00000000-0000-0000-0000-0000000e9401', array['00000000-0000-0000-0000-0000000e94a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e9413', '00000000-0000-0000-0000-0000000e9401', array['00000000-0000-0000-0000-0000000e94a2']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e9414', '00000000-0000-0000-0000-0000000e9401', array['00000000-0000-0000-0000-0000000e94a1']::uuid[], 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e9415', '00000000-0000-0000-0000-0000000e9401', array['00000000-0000-0000-0000-0000000e94a1']::uuid[], 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e9416', '00000000-0000-0000-0000-0000000e9401', array['00000000-0000-0000-0000-0000000e94a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e9417', '00000000-0000-0000-0000-0000000e9402', null, 'owner', 'owner')
on conflict do nothing;

-- c1: domicilio de WhatsApp/voz en A1 con chofer A1; c2: capturado por llamada en A1 (requiere consentimiento); c5: de la organizacion B.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, assigned_repartidor_id) values
  ('00000000-0000-0000-0000-0000000e94c1', '00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94a1', 'Cliente Uno', '+52 5500000001', 100, 'en_camino', '[]', 'voice', 'domicilio', '00000000-0000-0000-0000-0000000e9414'),
  ('00000000-0000-0000-0000-0000000e94c5', '00000000-0000-0000-0000-0000000e9402', '00000000-0000-0000-0000-0000000e94b1', 'Cliente Ajeno', '+52 5500000005', 100, 'en_camino', '[]', 'voice', 'domicilio', null);
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, canal_captura) values
  ('00000000-0000-0000-0000-0000000e94c2', '00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94a1', 'Cliente Dos', '5500000002', 100, 'en_camino', '[]', 'admin', 'domicilio', 'llamada');

\echo '=== A1. el owner lee el contexto: encendido por omision, sin ventana, sin plantilla, sin consentimiento registrado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select ((c->>'activo')::boolean and not (c->>'ventana_abierta')::boolean and c->'plantilla' = 'null'::jsonb and c->>'consentimiento' = 'sin_registro'
        and not (c->>'requiere_consentimiento')::boolean and not (c->>'ya_avisado')::boolean)::int as contexto_deberia_ser_1
from (select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1') as c) x;
rollback;

\echo '=== A2. el cliente escribio hace 2 h (wa_id 52 + 10 digitos): ventana abierta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at)
values ('wamid.camino.a2', '00000000-0000-0000-0000-0000000e9401', encode(sha256(convert_to('+525500000001', 'UTF8')), 'hex'), now() - interval '2 hours');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'ventana_abierta')::boolean::int as ventana_deberia_ser_1;
rollback;

\echo '=== A3. tambien con el formato 521 de Meta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at)
values ('wamid.camino.a3', '00000000-0000-0000-0000-0000000e9401', encode(sha256(convert_to('+5215500000001', 'UTF8')), 'hex'), now() - interval '1 hours');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'ventana_abierta')::boolean::int as ventana_deberia_ser_1;
rollback;

\echo '=== A4. escribio hace 23 h y media: ventana cerrada (margen de 1 h) ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at)
values ('wamid.camino.a4', '00000000-0000-0000-0000-0000000e9401', encode(sha256(convert_to('+525500000001', 'UTF8')), 'hex'), now() - interval '23 hours 30 minutes');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'ventana_abierta')::boolean::int as ventana_deberia_ser_0;
rollback;

\echo '=== A5. un mensaje del MISMO telefono a OTRA organizacion no abre la ventana de esta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at)
values ('wamid.camino.a5', '00000000-0000-0000-0000-0000000e9402', encode(sha256(convert_to('+525500000001', 'UTF8')), 'hex'), now() - interval '1 hours');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'ventana_abierta')::boolean::int as ventana_deberia_ser_0;
rollback;

\echo '=== A6. plantilla aprobada del evento order.en_camino: se devuelve nombre, idioma y variables ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado)
values ('00000000-0000-0000-0000-0000000e9401', 'restaurantes', 'order.en_camino', 'pedido_en_camino', 'es_MX', '{sucursal,folio,tiempo}', 'aprobada');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (c->'plantilla'->>'nombre' = 'pedido_en_camino' and c->'plantilla'->>'idioma' = 'es_MX' and c->'plantilla'->'variables' = '["sucursal","folio","tiempo"]'::jsonb)::int as plantilla_deberia_ser_1
from (select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1') as c) x;
rollback;

\echo '=== A7. una plantilla en borrador, de otro evento o de OTRA organizacion no cuenta ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values
  ('00000000-0000-0000-0000-0000000e9401', 'restaurantes', 'order.en_camino', 'pedido_en_camino', 'es_MX', '{sucursal}', 'borrador'),
  ('00000000-0000-0000-0000-0000000e9401', 'restaurantes', 'auth.codigo_acceso', 'codigo_acceso', 'es_MX', '{codigo}', 'aprobada'),
  ('00000000-0000-0000-0000-0000000e9402', 'restaurantes', 'order.en_camino', 'pedido_en_camino', 'es_MX', '{sucursal}', 'aprobada');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->'plantilla' = 'null'::jsonb)::int as sin_plantilla_deberia_ser_1;
rollback;

\echo '=== A8. pedido capturado por llamada: requiere consentimiento; con el consentimiento vigente (091) se ve vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94a1', '+525500000002', true, 'verbal_llamada', null);
select ((c->>'requiere_consentimiento')::boolean and c->>'consentimiento' = 'vigente')::int as consentimiento_deberia_ser_1
from (select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c2') as c) x;
rollback;

\echo '=== A9. una BAJA (revocacion de sistema) gana: revocado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94a1', '+525500000001', true, 'mensaje_cliente', null);
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e9401', '+525500000001');
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'consentimiento' = 'revocado')::int as revocado_deberia_ser_1;
rollback;

\echo '=== A10. el chofer ASIGNADO lee el contexto de su pedido ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9414');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1') is not null)::int as chofer_deberia_ser_1;
rollback;

\echo '=== A11. la sesion de sistema (cron del autopiloto) lee el contexto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1') is not null)::int as sistema_deberia_ser_1;
rollback;

\echo '=== A12. rechazos: chofer NO asignado, staff de otra sucursal y owner de otro tenant (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9415');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9413');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9417');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')$q$, '42501');
rollback;

\echo '=== A13. cross-tenant: el pedido de A pedido con la organizacion B no existe (null), y el de B pedido con A tampoco ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9417');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9402', '00000000-0000-0000-0000-0000000e94c1') is null)::int as ajeno_deberia_ser_1;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c5') is null)::int as ajeno_deberia_ser_1;
rollback;

\echo '=== A14. anon no ejecuta ninguna funcion del aviso (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'texto')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_leer('00000000-0000-0000-0000-0000000e9401')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
rollback;

\echo '=== A15. el helper interno no se concede a authenticated (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_puede('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94a1', null)$q$, '42501');
rollback;

\echo '=== B1. el chofer marca «plantilla»: queda en el pedido con su hora; ya_avisado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9414');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'plantilla');
select (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'ya_avisado')::boolean::int as ya_avisado_deberia_ser_1;
reset role;
select (aviso_en_camino = 'plantilla' and aviso_en_camino_at is not null)::int as marcado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e94c1';
rollback;

\echo '=== B2. un aviso ya encolado no se pisa (una sola vez por pedido) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'texto');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'omitido_falta_plantilla')::int as segundo_deberia_ser_0;
reset role;
select (aviso_en_camino = 'texto')::int as intacto_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e94c1';
rollback;

\echo '=== B3. un omitido si se puede reintentar despues (p. ej. ya hay plantilla) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'omitido_falta_plantilla');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'plantilla')::int as reintento_deberia_ser_1;
rollback;

\echo '=== B4. rechazos de marcar: estado invalido (22023), chofer ajeno y staff de otra sucursal (42501); pedido de otro tenant = false ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'enviado')$q$, '22023');
select public.t_como('00000000-0000-0000-0000-0000000e9415');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'texto')$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9413');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1', 'texto')$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select restaurantes.aviso_en_camino_marcar('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c5', 'texto')::int as ajeno_deberia_ser_0;
rollback;

\echo '=== C1. el owner apaga el aviso: el contexto y la lectura lo reflejan ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false);
select (not restaurantes.aviso_en_camino_config_leer('00000000-0000-0000-0000-0000000e9401')
        and not (restaurantes.aviso_en_camino_contexto('00000000-0000-0000-0000-0000000e9401', '00000000-0000-0000-0000-0000000e94c1')->>'activo')::boolean)::int as apagado_deberia_ser_1;
rollback;

\echo '=== C2. sin fila el interruptor esta encendido (lo lee el staff) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select restaurantes.aviso_en_camino_config_leer('00000000-0000-0000-0000-0000000e9401')::int as encendido_deberia_ser_1;
rollback;

\echo '=== C3. no cambian el interruptor: staff, admin acotado a una sucursal, owner de otro tenant ni la sesion de sistema (42501); nulo = 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9412');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9416');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9417');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_leer('00000000-0000-0000-0000-0000000e9401')$q$, '42501');
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select public.t_esperar_error($q$select restaurantes.aviso_en_camino_config_guardar('00000000-0000-0000-0000-0000000e9401', null)$q$, '22023');
rollback;

\echo '=== C4. nadie lee ni escribe la tabla del interruptor directo (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e9411');
select public.t_esperar_error($q$select * from restaurantes.aviso_en_camino_config$q$, '42501');
select public.t_esperar_error($q$insert into restaurantes.aviso_en_camino_config (organization_id, activo) values ('00000000-0000-0000-0000-0000000e9401', false)$q$, '42501');
rollback;
