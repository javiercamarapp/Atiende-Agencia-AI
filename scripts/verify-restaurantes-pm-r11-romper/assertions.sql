-- R11 "romper" (red team del agente de PM) -- escenarios contra Postgres REAL (RLS, GRANT, auth.uid() y jsonb reales). Solo PRUEBAS: no hay migracion.
--
-- Complementa packages/domain-restaurantes/tests/pm-r11-romper/*.spec.ts (que corren contra el repositorio en memoria y no ven nada de esto):
--
--   J. lo que jsonb NO acepta en el historial de WhatsApp (NUL, sustituto UTF-16 suelto). Es la EVIDENCIA de los hallazgos R11-08 y R11-09: el TypeScript
--      hoy puede mandar esos caracteres (ver los `hallazgo(...)` de 2-abuso-y-entradas-raras.spec.ts); la base los rechaza con 22P05 / 22P02 y el mensaje
--      queda como reintentable. Cuando el TS los limpie antes de guardar, estos escenarios siguen valiendo como red de seguridad.
--   O. create_order_idempotent (solo sistema): idempotencia, aislamiento por organizacion, CHECKs y rechazo de llaves reutilizadas.
--   R. aislamiento entre organizaciones (RLS) y funciones de solo-sistema que un usuario autenticado NO puede llamar (privacidad: nada de telefonos
--      ni pedidos de otros clientes).
--   C. avisos al equipo del agente: idempotentes por evento y motivo.
--
-- Los hallazgos de ESTE nivel que siguen ABIERTOS (la funcion acepta datos que el TypeScript nunca manda) estan en hallazgos-abiertos.sql, que
-- run.sh imprime como ABIERTO / CORREGIDO y NO forma parte del gate de CI.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor esperado; un escenario
-- sin alias debe terminar sin error (t_esperar_error exige el SQLSTATE exacto).
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

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f1101', 'restaurantes', 'R11 Org A', 'r11-org-a'),
  ('00000000-0000-0000-0000-0000000f1102', 'restaurantes', 'R11 Org B (ajena)', 'r11-org-b')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f1101', 'restaurantes', 'A1', 'active'),
  ('00000000-0000-0000-0000-0000000f11b1', '00000000-0000-0000-0000-0000000f1102', 'restaurantes', 'B1', 'active')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f1101', 'a1', 'America/Merida'),
  ('00000000-0000-0000-0000-0000000f11b1', '00000000-0000-0000-0000-0000000f1102', 'b1', 'America/Merida')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f1111', 'r11-owner-a@qa.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f1112', 'r11-owner-b@qa.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f1111', '00000000-0000-0000-0000-0000000f1101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f1112', '00000000-0000-0000-0000-0000000f1102', null, 'owner', 'owner')
on conflict do nothing;
-- El MISMO telefono en dos organizaciones: son dos clientes distintos.
insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000f11c1', '00000000-0000-0000-0000-0000000f1101', '+529990000001', 'Cliente Real A'),
  ('00000000-0000-0000-0000-0000000f11c2', '00000000-0000-0000-0000-0000000f1102', '+529990000001', 'Cliente Real B')
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, items, source, status) values
  ('00000000-0000-0000-0000-0000000f11d1', '00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 'Cliente Real A', '+529990000001', 90, '[{"name":"Coca-Cola","price":45,"quantity":2}]'::jsonb, 'whatsapp', 'pending')
on conflict do nothing;
insert into restaurantes.whatsapp_conversations (organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000f1101', '+529990000001', '00000000-0000-0000-0000-0000000f11a1', '[{"role":"user","content":"secreto-de-A"}]'::jsonb)
on conflict do nothing;
insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source) values
  ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', 'Cliente Real A', '+529990000001', 'queja', 'llamenme', 'whatsapp');

-- Crea un pedido con la RPC real; devuelve el jsonb del pedido. La huella y la llave se derivan de semillas de texto.
create or replace function public.t_orden(p_org uuid, p_prop uuid, p_cliente uuid, p_total numeric, p_fp text, p_key text default null, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
  return restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', p_org, 'property_id', p_prop, 'customer_id', p_cliente,
      'customer_name', 'Cliente R11', 'customer_phone', '+529990000001', 'branch', 'Sucursal R11',
      'total', p_total, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'quantity', 2, 'price', p_total / 2)),
      'source', 'whatsapp', 'payment_method', 'efectivo'
    ) || p_extra,
    md5(p_fp) || md5(p_fp || 'x'),
    case when p_key is null then null else md5(p_key) || md5(p_key || 'x') end
  );
end $$;

\echo '=== J1. un NUL (U+0000) en un mensaje del cliente NO cabe en jsonb: 22P05 (evidencia de R11-08) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000001', '[{"role":"user","content":"quiero dos tacos\u0000 por favor"}]'::jsonb, 'active', null, null)$q$, '22P05');
rollback;

\echo '=== J2. un sustituto UTF-16 suelto (emoji partido por el acotado a 1500) NO cabe en jsonb: 22P02 (evidencia de R11-09) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000001', '[{"role":"user","content":"tacos \ud83c"}]'::jsonb, 'active', null, null)$q$, '22P02');
rollback;

\echo '=== J3. un emoji COMPLETO (par de sustitutos) si se guarda: el acotado correcto no pierde el mensaje ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000009', '[{"role":"user","content":"tacos 🌮"}]'::jsonb, 'active', null, null)) as emoji_completo_deberia_ser_1;
rollback;

\echo '=== J4. el error por NUL dentro de un sub-bloque (savepoint implicito) no deja la sesion inservible: el siguiente guardado funciona ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000008', '[{"role":"user","content":"a\u0000b"}]'::jsonb, 'active', null, null);
  exception when others then
    null;
  end;
end $$;
select jsonb_array_length(restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000008', '[{"role":"user","content":"hola"}]'::jsonb, 'active', null, null)) as siguiente_guardado_deberia_ser_1;
rollback;

\echo '=== O1. un usuario autenticado (con auth.uid) NO puede crear pedidos por la RPC de sistema -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1111', true);
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o1')$q$, '42501');
rollback;

\echo '=== O2. una huella o llave de idempotencia mal formada se rechaza (P0001) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.create_order_idempotent('{"organization_id":"00000000-0000-0000-0000-0000000f1101"}'::jsonb, 'no-es-sha256', null)$q$, 'P0001');
rollback;

\echo '=== O3. la MISMA llave de idempotencia en dos organizaciones crea dos pedidos (no se pisan) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o3a', 'misma-llave');
select public.t_orden('00000000-0000-0000-0000-0000000f1102', '00000000-0000-0000-0000-0000000f11b1', '00000000-0000-0000-0000-0000000f11c2', 91, 'o3b', 'misma-llave');
reset role;
select count(*) as dos_pedidos_deberia_ser_2 from restaurantes.orders where idempotency_key = md5('misma-llave') || md5('misma-llave' || 'x');
rollback;

\echo '=== O4. la misma llave con OTRO contenido se rechaza (PT409) y no devuelve el pedido viejo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o4a', 'llave-o4');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 300, 'o4b', 'llave-o4')$q$, 'PT409');
rollback;

\echo '=== O5. doble envio (misma huella, sin llave) devuelve el MISMO pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o5')->>'id') = (public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o5')->>'id'))::int as mismo_pedido_deberia_ser_1;
rollback;

\echo '=== O6. la misma huella en OTRA organizacion NO colapsa con el pedido de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o6');
select public.t_orden('00000000-0000-0000-0000-0000000f1102', '00000000-0000-0000-0000-0000000f11b1', '00000000-0000-0000-0000-0000000f11c2', 90, 'o6');
reset role;
select count(distinct id) as dos_pedidos_deberia_ser_2 from restaurantes.orders where dedupe_fingerprint = md5('o6') || md5('o6' || 'x');
rollback;

\echo '=== O7. un pedido programado en el pasado se rechaza con 22023 (regla de negocio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o7', null, '{"programado_para":"2020-01-01T12:00:00Z"}'::jsonb)$q$, '22023');
rollback;

\echo '=== O8. fuente inventada -> 23514 (CHECK) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o8', null, '{"source":"hacker"}'::jsonb)$q$, '23514');
rollback;

\echo '=== O9. propina negativa -> 23514 (CHECK) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o9', null, '{"propina":-50}'::jsonb)$q$, '23514');
rollback;

\echo '=== O10. un total fuera de rango numerico -> 22003 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 99999999999, 'o10')$q$, '22003');
rollback;

\echo '=== O11. el contador de pedidos del cliente sube UNA vez aunque el doble envio llegue dos veces ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o11');
select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o11');
reset role;
select order_count as una_vez_deberia_ser_1 from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f11c1';
rollback;

\echo '=== O12-O19. defensa en profundidad (migracion 089; antes eran los hallazgos ABIERTOS R11-15 y R11-16) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- R11-15: sucursal / cliente de OTRA organizacion -> 42501
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11b1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o12')$q$, '42501');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c2', 90, 'o13')$q$, '42501');
-- R11-16: total negativo, items que no es arreglo, cantidad negativa o cero, items vacio, renglon que no es objeto -> 22023
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', -100, 'o14')$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 'NaN'::numeric, 'o14n')$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o15', null, '{"items":"hola"}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o16', null, '{"items":[{"name":"Taco","price":45,"quantity":-2}]}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o17', null, '{"items":[]}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o18', null, '{"items":[{"name":"Taco","price":45,"quantity":0}]}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o19', null, '{"items":[1,2]}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o19b', null, '{"items":[{"name":"Taco","quantity":"dos"}]}'::jsonb)$q$, '22023');
rollback;

\echo '=== O20. un pedido valido SIGUE funcionando tras el endurecimiento: con cliente, sin cliente (null), total 0 y renglon sin quantity ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o20a')->>'id') is not null as con_cliente_deberia_ser_t;
select (public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', null, 90, 'o20b')->>'id') is not null as sin_cliente_deberia_ser_t;
select (public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 0, 'o20c')->>'id') is not null as total_cero_deberia_ser_t;
select (public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'o20d', null, '{"items":[{"name":"Agua","price":20}]}'::jsonb)->>'id') is not null as sin_quantity_deberia_ser_t;
rollback;

\echo '=== O21. CHECK de tabla: quien escribe SIN la funcion tampoco mete total negativo o NaN, items que no es arreglo ni un aviso de 1 MB -> 23514 ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, source, status) values ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', 'X', '+529990000001', -5, '[{"name":"Taco","quantity":1}]'::jsonb, 'whatsapp', 'pending')$q$, '23514');
select public.t_esperar_error($q$insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, source, status) values ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', 'X', '+529990000001', 'NaN'::numeric, '[{"name":"Taco","quantity":1}]'::jsonb, 'whatsapp', 'pending')$q$, '23514');
select public.t_esperar_error($q$insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, source, status) values ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', 'X', '+529990000001', 5, '{"a":1}'::jsonb, 'whatsapp', 'pending')$q$, '23514');
select public.t_esperar_error($q$insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source) values ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', 'X', '+529990000002', 'queja', repeat('x', 1000000), 'whatsapp')$q$, '23514');
rollback;

\echo '=== O22. los 3 CHECK de la migracion 089 existen y estan VALIDADOS (la re-ejecucion idempotente la prueba run.sh) ==='
select count(*) as checks_deberia_ser_3 from pg_constraint where conname in ('callback_requests_message_largo', 'orders_total_no_negativo', 'orders_items_es_arreglo') and convalidated;

\echo '=== R1. el owner de B no ve pedidos, clientes, conversaciones ni avisos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1112', true);
select (
  (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f1101')
  + (select count(*) from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f1101')
  + (select count(*) from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f1101')
  + (select count(*) from restaurantes.callback_requests where organization_id = '00000000-0000-0000-0000-0000000f1101')
) as filas_ajenas_deberia_ser_0;
rollback;

\echo '=== R1b. el owner de A SI ve lo suyo (el aislamiento no es "nadie ve nada") ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1111', true);
select (
  (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f1101')
  + (select count(*) from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f1101')
) as filas_propias_deberia_ser_2;
rollback;

\echo '=== R2. anon no lee pedidos -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select id from restaurantes.orders$q$, '42501');
rollback;

\echo '=== R3. anon no lee conversaciones de WhatsApp -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select messages from restaurantes.whatsapp_conversations$q$, '42501');
rollback;

\echo '=== R4. un usuario (owner de B) no puede escribir en el historial de WhatsApp de A: funcion de solo sistema -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1112', true);
select public.t_esperar_error($q$select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1101', '+529990000001', '[{"role":"user","content":"intruso"}]'::jsonb, 'active', null, null)$q$, '42501');
rollback;

\echo '=== R5. un usuario no puede reclamar el id de mensaje de Meta de A (dedupe de entrada es de sistema) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1112', true);
select public.t_esperar_error($q$select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1101', 'wamid.intruso', 'h')$q$, '42501');
rollback;

\echo '=== R6. un usuario no puede dejar avisos al equipo de A como si fuera el agente -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1112', true);
select public.t_esperar_error($q$select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'x', '+529990000001', 'escalada:queja', 'intruso', 'whatsapp', 'evt-intruso')$q$, '42501');
rollback;

\echo '=== R7. el mismo telefono en dos organizaciones guarda conversaciones SEPARADAS: el texto de A no aparece en la conversacion de B ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000f1102', '+529990000001', '[{"role":"user","content":"hola desde B"}]'::jsonb, 'active', null, null);
reset role;
select count(*) as mezcla_deberia_ser_0 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f1102' and messages::text like '%secreto-de-A%';
rollback;

\echo '=== C1. el mismo aviso del agente (mismo evento y motivo) repetido 5 veces deja UNA sola fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000077', 'escalada:queja', 'm1', 'whatsapp', 'evt-c1:escalada:queja');
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000077', 'escalada:queja', 'm1', 'whatsapp', 'evt-c1:escalada:queja');
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000077', 'escalada:queja', 'm1', 'whatsapp', 'evt-c1:escalada:queja');
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000077', 'escalada:queja', 'm1', 'whatsapp', 'evt-c1:escalada:queja');
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000077', 'escalada:queja', 'm1', 'whatsapp', 'evt-c1:escalada:queja');
reset role;
select count(*) as una_fila_deberia_ser_1 from restaurantes.callback_requests where customer_phone = '+529990000077';
rollback;

\echo '=== C2. avisos con la MISMA llave de evento pero de organizaciones distintas no se pisan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1101', null, 'Ana', '+529990000078', 'escalada:queja', 'a', 'whatsapp', 'evt-c2:escalada:queja');
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f1102', null, 'Ana', '+529990000078', 'escalada:queja', 'b', 'whatsapp', 'evt-c2:escalada:queja');
reset role;
select count(*) as dos_filas_deberia_ser_2 from restaurantes.callback_requests where customer_phone = '+529990000078';
rollback;

\echo '=== P1. R12: las partes de UNA respuesta larga (misma transaccion) salen del claim en el orden en que se encolaron (migracion 088) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000f1101', 'whatsapp', 'whatsapp.inbound_reply',
  case when n = 0 then 'ord-p1:wamid.r12' else 'ord-p1:wamid.r12:' || n end, jsonb_build_object('body', 'parte ' || n)) from generate_series(0, 11) n;
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000f1101', 'whatsapp', 'whatsapp.inbound_reply', 'ord-p1:botones-wamid.r12', '{"body":"botones"}'::jsonb);
do $$
declare
  v_esperado text[] := array['ord-p1:wamid.r12'] || array(select 'ord-p1:wamid.r12:' || n from generate_series(1, 11) n) || array['ord-p1:botones-wamid.r12'];
  v_visto text;
  i integer;
begin
  -- el cron reclama de a UNA fila por sesion: aqui se reclama de a una hasta agotar la cola de esta organizacion
  for i in 1 .. 13 loop
    select c.dedupe_key into v_visto from restaurantes.claim_messaging_outbox_batch(1, 120) c;
    if v_visto is distinct from v_esperado[i] then
      raise exception 'la fila % salio del claim como % y se esperaba %', i, v_visto, v_esperado[i];
    end if;
  end loop;
end $$;
reset role;
select count(*) as reclamadas_en_orden_deberia_ser_13 from restaurantes.messaging_outbox where dedupe_key like 'ord-p1:%' and status = 'processing';
rollback;

\echo '=== P2. R12: re-encolar con la misma llave no crea fila nueva y conserva el orden original ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000f1101', 'whatsapp', 'whatsapp.inbound_reply', 'ord-p2:a', '{"body":"a"}'::jsonb);
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000f1101', 'whatsapp', 'whatsapp.inbound_reply', 'ord-p2:a:1', '{"body":"b"}'::jsonb);
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000f1101', 'whatsapp', 'whatsapp.inbound_reply', 'ord-p2:a', '{"body":"a"}'::jsonb);
reset role;
select count(*) as filas_deberia_ser_2 from restaurantes.messaging_outbox where dedupe_key like 'ord-p2:%';
rollback;

\echo '=== listo: los escenarios con alias deberia_ser_N deben devolver N; los demas deben terminar sin error ==='
