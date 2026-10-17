-- R12 "romper" ronda 2 (red team del agente de PM) -- escenarios de INFRAESTRUCTURA contra Postgres REAL. Solo PRUEBAS: no hay migracion y no se toca la base real.
--
-- Complementa packages/domain-restaurantes/tests/pm-r11-romper/{7,8,9,10,11}-ronda-2-*.spec.ts (repositorio en memoria). Aqui va lo que el repositorio en memoria no
-- puede ver: el comportamiento real de las funciones de SOLO SISTEMA con las que el webhook de WhatsApp se defiende de reintentos, duplicados de dos instancias,
-- mensajes fuera de orden y transacciones abortadas.
--
--   K. transaccion abortada: un error de negocio de la base (CHECK) dentro de un sub-bloque (SAVEPOINT) no tumba el pedido siguiente.
--   L. claim_whatsapp_message: dedupe de dos instancias, reintento de un mensaje fallido, mensaje ya procesado, reclamo vencido (> 5 min), mensajes fuera de orden.
--   M. claim_whatsapp_conversation: el lease serializa mensajes del mismo telefono y se libera al terminar (o al vencer).
--
-- Lo que sigue ABIERTO a este nivel (reloj de la base que retrocede) esta en hallazgos-abiertos.sql, que run.sh imprime y NO forma parte del gate.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor esperado.
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f1201', 'restaurantes', 'R12 Org A', 'r12-org-a')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f1201', 'restaurantes', 'A1', 'active')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f1201', 'a1', 'America/Merida')
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000f12c1', '00000000-0000-0000-0000-0000000f1201', '+529990000001', 'Cliente R12')
on conflict do nothing;

create or replace function public.t_orden(p_org uuid, p_prop uuid, p_cliente uuid, p_total numeric, p_fp text, p_key text default null, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
  return restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', p_org, 'property_id', p_prop, 'customer_id', p_cliente,
      'customer_name', 'Cliente R12', 'customer_phone', '+529990000001', 'branch', 'Sucursal R12',
      'total', p_total, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'quantity', 2, 'price', p_total / 2)),
      'source', 'whatsapp', 'payment_method', 'efectivo'
    ) || p_extra,
    md5(p_fp) || md5(p_fp || 'x'),
    case when p_key is null then null else md5(p_key) || md5(p_key || 'x') end
  );
end $$;

-- Huella de telefono valida (64 hex) para las funciones de reclamo.
create or replace function public.t_hash(p text) returns text language sql immutable as $$ select md5(p) || md5(p || 'h') $$;

\echo '=== K1. un error de negocio de la base (propina negativa, 23514) dentro de un sub-bloque no deja la sesion inservible: el pedido siguiente se crea y queda UNO solo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform public.t_orden('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f12c1', 90, 'k1-malo', null, '{"propina":-50}'::jsonb);
  exception when others then
    null;
  end;
end $$;
select public.t_orden('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f12c1', 90, 'k1-bueno');
reset role;
select count(*) as un_pedido_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f1201';
rollback;

\echo '=== K2. un pedido que SI se guardo pero cuya respuesta se perdio (conexion cortada): el reintento con la misma llave devuelve el MISMO pedido y no crea otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_orden('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f12c1', 90, 'k2', 'llave-k2');
select public.t_orden('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-0000000f12a1', '00000000-0000-0000-0000-0000000f12c1', 90, 'k2', 'llave-k2');
reset role;
select count(*) as un_pedido_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f1201' and idempotency_key = md5('llave-k2') || md5('llave-k2' || 'x');
rollback;

\echo '=== L1. DOS INSTANCIAS reciben el mismo mensaje de Meta a la vez: solo la primera lo reclama ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l1', public.t_hash('p1'));
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l1', public.t_hash('p1'))::int as segunda_instancia_deberia_ser_0;
rollback;

\echo '=== L2. el reintento de Meta de un mensaje que FALLO se reclama otra vez (el cliente no se queda sin respuesta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l2', public.t_hash('p2'));
select restaurantes.finish_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l2', public.t_hash('p2'), 'failed', 'Timeout');
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l2', public.t_hash('p2'))::int as reintento_deberia_ser_1;
rollback;

\echo '=== L3. un mensaje ya PROCESADO no se reclama otra vez aunque Meta lo reenvie (no hay segundo turno ni segundo pedido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l3', public.t_hash('p3'));
select restaurantes.finish_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l3', public.t_hash('p3'), 'processed', null);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l3', public.t_hash('p3'))::int as reenvio_deberia_ser_0;
rollback;

\echo '=== L4. una instancia que se cayo a media faena deja el mensaje en processing: pasados 5 minutos otra instancia lo retoma ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l4', public.t_hash('p4'));
reset role;
update restaurantes.whatsapp_inbound_events set claimed_at = now() - interval '6 minutes' where message_id = 'wamid.l4';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l4', public.t_hash('p4'))::int as retomado_deberia_ser_1;
rollback;

\echo '=== L5. antes de los 5 minutos otra instancia NO lo retoma (no se corre dos veces el mismo turno) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l5', public.t_hash('p5'));
reset role;
update restaurantes.whatsapp_inbound_events set claimed_at = now() - interval '4 minutes' where message_id = 'wamid.l5';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l5', public.t_hash('p5'))::int as no_retomado_deberia_ser_0;
rollback;

\echo '=== L6. mensajes FUERA DE ORDEN del mismo telefono (llega el segundo antes que el primero): ambos se reclaman, ninguno se pierde ni se bloquea por el otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l6-b', public.t_hash('p6'))::int
      + restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l6-a', public.t_hash('p6'))::int) as ambos_reclamados_deberia_ser_2;
rollback;

\echo '=== L7. un id de mensaje absurdo (vacio, 300 caracteres) o una huella de telefono mal formada NO se reclama (false, sin error) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', '', public.t_hash('p7'))::int
      + restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', repeat('x', 300), public.t_hash('p7'))::int
      + restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.l7', 'no-es-hash')::int) as ninguno_deberia_ser_0;
rollback;

\echo '=== M1. el lease de la conversacion serializa: con el lease vigente, el mensaje casi simultaneo del MISMO telefono no lo obtiene ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m1'), 'wamid.m1-a', 120);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m1'), 'wamid.m1-b', 120)::int as segundo_deberia_ser_0;
rollback;

\echo '=== M2. otro telefono NO espera el lease de este (no se bloquean entre clientes) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m2-a'), 'wamid.m2-a', 120);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m2-b'), 'wamid.m2-b', 120)::int as otro_telefono_deberia_ser_1;
rollback;

\echo '=== M3. al terminar el mensaje el lease se libera: el siguiente mensaje del mismo telefono lo obtiene ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.m3-a', public.t_hash('m3'));
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m3'), 'wamid.m3-a', 120);
select restaurantes.finish_whatsapp_message('00000000-0000-0000-0000-0000000f1201', 'wamid.m3-a', public.t_hash('m3'), 'processed', null);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m3'), 'wamid.m3-b', 120)::int as liberado_deberia_ser_1;
rollback;

\echo '=== M4. un lease abandonado (la instancia murio) vence solo: pasado su plazo otro mensaje lo toma ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m4'), 'wamid.m4-a', 120);
reset role;
update restaurantes.whatsapp_conversation_leases set locked_until = now() - interval '1 second' where owner_message_id = 'wamid.m4-a';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m4'), 'wamid.m4-b', 120)::int as vencido_deberia_ser_1;
rollback;

\echo '=== M5. un plazo de lease absurdo (0 s, 10 000 s) se rechaza sin error (false): un lease eterno no puede dejar muda a una conversacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m5'), 'wamid.m5-a', 0)::int
      + restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hash('m5'), 'wamid.m5-b', 10000)::int) as ninguno_deberia_ser_0;
rollback;
