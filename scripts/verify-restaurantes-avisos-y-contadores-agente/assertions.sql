-- Fixtures + escenarios contra Postgres REAL (GRANT/RLS + funcion definer reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/047_avisos_idempotentes_y_contadores_agente.sql (restaurantes.callback_registrar_agente).
--
-- Cada escenario corre en su propio `begin; ... rollback;` y TERMINA SIN ERROR si todo se cumple: las comprobaciones de valor son bloques
-- `do $$ ... raise exception ... $$` (el gate de CI las juzga por ausencia de error), las de rechazo esperan el SQLSTATE exacto.
-- El agente es la sesion de SISTEMA: rol `authenticated` sin `sub` (auth.uid() es null).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'CBI Org A', 'cbi-a'),
  ('00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'CBI Org B (ajena)', 'cbi-b')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'Sucursal B1')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'a1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'b1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0011', 'staff-a@cbi.example.com', 'Staff A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0001', null, 'member', 'staff')
on conflict do nothing;

\echo '=== A1. POSITIVO: un aviso nuevo del agente (WhatsApp) se registra con el id del evento ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Marcela', '+5219991110001', 'escalada:cliente_lo_pide', 'Quiere una persona', 'whatsapp', 'wamid.A1:escalada:cliente_lo_pide');
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110001') <> 1 then raise exception 'A1: debio crear 1 aviso'; end if;
  if (select source_event_id from restaurantes.callback_requests where customer_phone = '+5219991110001') <> 'wamid.A1:escalada:cliente_lo_pide' then raise exception 'A1: source_event_id'; end if;
end $$;
rollback;

\echo '=== A2. IDEMPOTENTE: Meta reenvia el MISMO id 3 veces -> 1 solo aviso y las repeticiones dicen evento_repetido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r1 text; r2 text; r3 text;
begin
  select registro into r1 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110002', 'escalada:queja', 'm', 'whatsapp', 'wamid.A2');
  select registro into r2 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110002', 'escalada:queja', 'm', 'whatsapp', 'wamid.A2');
  select registro into r3 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110002', 'escalada:queja', 'm', 'whatsapp', 'wamid.A2');
  if r1 <> 'nuevo' or r2 <> 'evento_repetido' or r3 <> 'evento_repetido' then raise exception 'A2: registros % % %', r1, r2, r3; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110002') <> 1 then raise exception 'A2: debio quedar 1 aviso'; end if;
  if (select avisos_repetidos from restaurantes.callback_requests where customer_phone = '+5219991110002') <> 0 then raise exception 'A2: un reenvio no es un aviso repetido'; end if;
end $$;
rollback;

\echo '=== A3. DEDUPE POR MOTIVO: el cliente repite lo mismo 3 veces (ids distintos) -> 1 aviso abierto con 3 notas (1 original + 2 agregadas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r text[];
begin
  select array_agg(registro order by n) into r from (
    select 1 as n, registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110003', 'escalada:cliente_lo_pide', 'Primera vez', 'whatsapp', 'wamid.A3.1')
    union all select 2, registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110003', 'escalada:cliente_lo_pide', 'Segunda vez', 'whatsapp', 'wamid.A3.2')
    union all select 3, registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'Marcela', '+5219991110003', 'escalada:cliente_lo_pide', 'Tercera vez', 'whatsapp', 'wamid.A3.3')
  ) t;
  if r <> array['nuevo', 'nota_agregada', 'nota_agregada'] then raise exception 'A3: registros %', r; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110003') <> 1 then raise exception 'A3: debio quedar 1 aviso'; end if;
  if (select avisos_repetidos from restaurantes.callback_requests where customer_phone = '+5219991110003') <> 2 then raise exception 'A3: avisos_repetidos'; end if;
  if (select message from restaurantes.callback_requests where customer_phone = '+5219991110003') not like '%Segunda vez%' or (select message from restaurantes.callback_requests where customer_phone = '+5219991110003') not like '%Tercera vez%' then raise exception 'A3: las notas deben estar en message'; end if;
end $$;
rollback;

\echo '=== A4. El reenvio de un evento YA agregado como nota no repite la nota ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r text;
begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110004', 'escalada:queja', 'uno', 'whatsapp', 'wamid.A4.1');
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110004', 'escalada:queja', 'dos', 'whatsapp', 'wamid.A4.2');
  select registro into r from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110004', 'escalada:queja', 'dos', 'whatsapp', 'wamid.A4.2');
  if r <> 'evento_repetido' then raise exception 'A4: registro %', r; end if;
end $$;
reset role;
do $$ begin
  if (select avisos_repetidos from restaurantes.callback_requests where customer_phone = '+5219991110004') <> 1 then raise exception 'A4: una sola nota agregada'; end if;
end $$;
rollback;

\echo '=== A5. DOS MOTIVOS DISTINTOS (mismo telefono y canal) -> 2 avisos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from (
  select 1 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110005', 'escalada:queja', 'a', 'whatsapp', 'wamid.A5.1')
  union all select 1 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110005', 'escalada:alergia_salud', 'b', 'whatsapp', 'wamid.A5.2')
) t;
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110005') <> 2 then raise exception 'A5: debieron ser 2 avisos'; end if;
end $$;
rollback;

\echo '=== A6. NEGATIVO: un aviso RESUELTO o FUERA DE LA VENTANA no absorbe uno nuevo; otro canal tampoco ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110006', 'escalada:queja', 'a', 'whatsapp', 'wamid.A6.1');
reset role;
update restaurantes.callback_requests set status = 'resuelto' where customer_phone = '+5219991110006';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110006', 'escalada:queja', 'b', 'whatsapp', 'wamid.A6.2');
reset role;
update restaurantes.callback_requests set created_at = now() - interval '3 hours' where customer_phone = '+5219991110006' and source_event_id = 'wamid.A6.2';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110006', 'escalada:queja', 'c', 'whatsapp', 'wamid.A6.3');
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110006', 'escalada:queja', 'd', 'voice', 'call.A6.4');
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110006') <> 4 then raise exception 'A6: debieron ser 4 avisos (resuelto, fuera de ventana, otro canal)'; end if;
end $$;
rollback;

\echo '=== A7. MULTI-TENANT: el mismo id de evento en OTRA organizacion es un aviso aparte (indice unico por organizacion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110007', 'escalada:queja', 'a', 'whatsapp', 'wamid.A7');
select registro from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0002', null, 'M', '+5219991110007', 'escalada:queja', 'a', 'whatsapp', 'wamid.A7');
reset role;
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110007') <> 2 then raise exception 'A7: cada organizacion registra el suyo'; end if;
end $$;
rollback;

\echo '=== A8. TOPE: muchas repeticiones no pasan de 4000 caracteres en message, pero siguen contandose ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare i int;
begin
  for i in 1..30 loop
    perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110008', 'escalada:queja', repeat('x', 500), 'whatsapp', 'wamid.A8.' || i);
  end loop;
end $$;
reset role;
do $$ begin
  if (select char_length(message) from restaurantes.callback_requests where customer_phone = '+5219991110008') > 4000 then raise exception 'A8: message pasa de 4000'; end if;
  if (select avisos_repetidos from restaurantes.callback_requests where customer_phone = '+5219991110008') <> 29 then raise exception 'A8: avisos_repetidos debe ser 29'; end if;
end $$;
rollback;

\echo '=== S1. RECHAZADO: un staff autenticado (auth.uid() no nulo) no puede usar la funcion (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
do $$ begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110009', 'escalada:queja', 'x', 'whatsapp', 'wamid.S1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== S2. ANON: sin EXECUTE sobre la funcion ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110010', 'escalada:queja', 'x', 'whatsapp', 'wamid.S2');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== S3. CROSS-TENANT: una sucursal de otra organizacion se rechaza (42501) y no se escribe nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00b1', 'M', '+5219991110011', 'escalada:queja', 'x', 'whatsapp', 'wamid.S3');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
reset role;
do $$ begin
  if exists (select 1 from restaurantes.callback_requests where customer_phone = '+5219991110011') then raise exception 'S3: no debio escribir nada'; end if;
end $$;
rollback;

\echo '=== S4. VALIDACION: canal invalido y ventana invalida -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110012', 'x', 'x', 'web', 'e1');
  raise exception 'DEBIO FALLAR con 22023';
exception when sqlstate '22023' then null; end $$;
do $$ begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110012', 'x', 'x', 'whatsapp', 'e2', 0);
  raise exception 'DEBIO FALLAR con 22023';
exception when sqlstate '22023' then null; end $$;
rollback;

\echo '=== S5. SIN ESCRITURA DIRECTA: authenticated no puede insertar en callback_requests (solo la funcion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
do $$ begin
  insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, source, source_event_id) values ('00000000-0000-0000-0000-0000000f0001', 'x', '+5219991110013', 'whatsapp', 'directo');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== S6. INDICE UNICO: dos filas con el mismo (organizacion, source_event_id) -> 23505 ==='
begin;
insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, source, source_event_id) values ('00000000-0000-0000-0000-0000000f0001', 'x', '+5219991110014', 'whatsapp', 'dup');
do $$ begin
  insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, source, source_event_id) values ('00000000-0000-0000-0000-0000000f0001', 'y', '+5219991110015', 'voice', 'dup');
  raise exception 'DEBIO FALLAR con 23505';
exception when sqlstate '23505' then null; end $$;
rollback;

\echo '=== C1. COMPATIBILIDAD: el INSERT anterior (sin source_event_id) sigue funcionando y se puede repetir (filas historicas) ==='
begin;
insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, reason, message, source) values ('00000000-0000-0000-0000-0000000f0001', 'x', '+5219991110016', 'r', 'm', 'whatsapp');
insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, reason, message, source) values ('00000000-0000-0000-0000-0000000f0001', 'x', '+5219991110016', 'r', 'm', 'whatsapp');
do $$ begin
  if (select count(*) from restaurantes.callback_requests where customer_phone = '+5219991110016') <> 2 then raise exception 'C1: el camino anterior debe seguir insertando'; end if;
end $$;
rollback;

\echo '=== C2. SIN source_event_id (llamada sin id): el dedupe por motivo sigue agrupando ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r2 text;
begin
  perform restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110017', 'escalada:queja', 'a', 'voice', null);
  select registro into r2 from restaurantes.callback_registrar_agente('00000000-0000-0000-0000-0000000f0001', null, 'M', '+5219991110017', 'escalada:queja', 'b', 'voice', null);
  if r2 <> 'nota_agregada' then raise exception 'C2: registro %', r2; end if;
end $$;
rollback;

-- ===== PARTE B: contadores del agente de WhatsApp (whatsapp_contador_agente) =====
insert into restaurantes.whatsapp_conversations (organization_id, phone) values
  ('00000000-0000-0000-0000-0000000f0001', '+5219993330001'),
  ('00000000-0000-0000-0000-0000000f0002', '+5219993330002')
on conflict do nothing;

\echo '=== K1. POSITIVO: incrementar dos veces cuenta 1 y 2; reiniciar lo deja en 0 y quita la clave ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare a int; b int; c int;
begin
  a := restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'incrementar');
  b := restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'incrementar');
  if a <> 1 or b <> 2 then raise exception 'K1: contadores % %', a, b; end if;
  c := restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'reiniciar');
  if c <> 0 then raise exception 'K1: reiniciar debe devolver 0'; end if;
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'incrementar') <> 1 then raise exception 'K1: tras reiniciar vuelve a 1'; end if;
end $$;
rollback;

\echo '=== K2. Las dos claves son independientes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'incrementar');
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'colonia_no_reconocida', 'incrementar');
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'incrementar') <> 1 then raise exception 'K2: no_entiende arranca en 1'; end if;
end $$;
rollback;

\echo '=== K2b. La clave ubicacion_solicitada: la 1.a vez devuelve 1 (se pide), la 2.a ya 2 (no se repite) y reiniciar la libera para el siguiente pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'ubicacion_solicitada', 'incrementar') <> 1 then raise exception 'K2b: la primera vez debe devolver 1'; end if;
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'ubicacion_solicitada', 'incrementar') <> 2 then raise exception 'K2b: la segunda ya no es 1'; end if;
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'ubicacion_solicitada', 'reiniciar');
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'ubicacion_solicitada', 'incrementar') <> 1 then raise exception 'K2b: tras reiniciar vuelve a 1'; end if;
end $$;
rollback;

\echo '=== K3. NEGATIVO: un contador de mas de 2 h cuenta como 0 (071: tabla propia, sin bloquear la conversacion) ==='
begin;
insert into restaurantes.whatsapp_contadores_agente (organization_id, phone_hash, clave, n, updated_at)
  values ('00000000-0000-0000-0000-0000000f0001', encode(sha256(convert_to('+5219993330001', 'UTF8')), 'hex'), 'no_entiende', 5, now() - interval '3 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'incrementar') <> 1 then raise exception 'K3: un contador viejo no arrastra'; end if;
end $$;
rollback;

\echo '=== K4. CROSS-TENANT: el contador de la organizacion B es SUYO; no toca el de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0002', '+5219993330001', 'no_entiende', 'incrementar') <> 1 then raise exception 'K4: B cuenta su propio contador desde 1'; end if;
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'incrementar') <> 1 then raise exception 'K4: el contador de A no se toco (arranca en 1)'; end if;
end $$;
rollback;

\echo '=== K4b. 071: contar no necesita la fila de la conversacion (una sola conexion: la espera entre dos sesiones se probo con dos psql a mano, ver el PR) ==='
begin;
-- Esta transaccion bloquea la fila de la conversacion como lo hace el webhook al reclamar el turno ...
select 1 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f0001' and phone = '+5219993330001' for update;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
set local lock_timeout = '1s';
-- ... y el contador responde sin esperar ese lock (antes: `for update` sobre la misma fila => espera hasta el statement_timeout en OTRA sesion).
do $$
begin
  if restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'ubicacion_solicitada', 'incrementar') <> 1 then raise exception 'K4b'; end if;
end $$;
rollback;

\echo '=== K5. RECHAZADO: staff autenticado -> 42501; anon -> 42501; clave o accion invalidas -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
do $$ begin
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'incrementar');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'incrementar');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'otra_clave', 'incrementar');
  raise exception 'DEBIO FALLAR con 22023';
exception when sqlstate '22023' then null; end $$;
do $$ begin
  perform restaurantes.whatsapp_contador_agente('00000000-0000-0000-0000-0000000f0001', '+5219993330001', 'no_entiende', 'borrar');
  raise exception 'DEBIO FALLAR con 22023';
exception when sqlstate '22023' then null; end $$;
rollback;

\echo 'Todos los escenarios deben terminar SIN error: las comprobaciones de valor lanzan excepcion si algo no se cumple.'
