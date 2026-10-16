-- Escenarios contra Postgres REAL (rol `authenticated` + `request.jwt.claim.sub`, exactamente lo que abre `withAppSession`/`dbSession`) para la clase de
-- defecto «funcion de SOLO sistema llamada con la sesion del staff» (8-oct-2026: «Probar agente» del panel respondia «Error interno» al primer mensaje).
--
--   A. Causa raiz: `restaurantes.consume_api_rate_limit` con la sesion de un STAFF (auth.uid() no nulo) lanza 42501 «es solo para la sesión de
--      sistema». Es el error exacto del registro de produccion; el arreglo NO relaja la funcion (sigue rechazando al staff y a anon), mueve el
--      consumo del contador a una sesion de sistema.
--   B. Con la sesion de SISTEMA (auth.uid() nulo, la que ahora usa la ruta) el contador funciona: tope por staff de «Probar agente» (40 mensajes /
--      10 min: el 41 se rechaza), tope por organizacion (400/dia: el 401 se rechaza), aislamiento entre staff y entre organizaciones.
--   C. La misma clase en citas («Probar conexion» de Cal.com/CalDAV): el limitador y la lectura del secreto del Vault de citas tambien son de
--      solo sistema y rechazan al staff.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado; cualquier otro debe completar sin error (los bloques DO lanzan excepcion si algo no cumple).
\set ON_ERROR_STOP off
\pset pager off

\echo ''
\echo '=== A) causa raiz: con la sesion del staff el limitador lanza 42501 ==='
\echo ''

\echo '--- 1. staff autenticado (auth.uid() no nulo) consume el tope de «Probar agente»: RECHAZADO (es el 500 de produccion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600) as should_fail;
rollback;

\echo '--- 2. el mismo tope con el staff de OTRO usuario tambien: RECHAZADO (no depende de quien sea) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c02', true);
select restaurantes.consume_api_rate_limit('voz-preview-sesion', repeat('b', 64), 20, 600) as should_fail;
rollback;

\echo '--- 3. anon no tiene EXECUTE: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600) as should_fail;
rollback;

\echo '--- 4. el rechazo dice «solo para la sesión de sistema» con SQLSTATE 42501 (el mensaje del registro de produccion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
do $$
begin
  perform restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600);
  raise exception 'se esperaba 42501 y la funcion NO fallo con la sesion del staff';
exception when sqlstate '42501' then
  if sqlerrm not like '%solo para la sesión de sistema%' then
    raise exception 'el 42501 no trae el mensaje esperado: %', sqlerrm;
  end if;
end $$;
rollback;

\echo ''
\echo '=== B) con la sesion de SISTEMA (la que usa la ruta tras el arreglo) los topes funcionan ==='
\echo ''

\echo '--- 5. sesion de sistema (auth.uid() nulo): el PRIMER mensaje pasa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600)::int as primer_mensaje_deberia_ser_1;
rollback;

\echo '--- 6. tope por staff: de 41 mensajes en la ventana pasan 40 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) filter (where ok)::int as mensajes_permitidos_deberia_ser_40
from (select n, restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600) as ok from generate_series(1, 41) n) t;
rollback;

\echo '--- 7. tope por staff: el mensaje 41 se rechaza (la ruta responde 429) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (array_agg(ok order by n))[41]::int as mensaje_41_deberia_ser_0
from (select n, restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600) as ok from generate_series(1, 41) n) t;
rollback;

\echo '--- 8. tope por organizacion/dia: el 400 pasa y el 401 se rechaza (la ruta responde 429 agente_preview_tope) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v_ok boolean; i integer;
begin
  for i in 1..400 loop
    v_ok := restaurantes.consume_api_rate_limit('agente-preview-org', repeat('c', 64), 400, 86400);
    if not v_ok then raise exception 'el mensaje % de la organizacion debio pasar', i; end if;
  end loop;
  if restaurantes.consume_api_rate_limit('agente-preview-org', repeat('c', 64), 400, 86400) then
    raise exception 'el mensaje 401 de la organizacion debio rechazarse';
  end if;
end $$;
rollback;

\echo '--- 9. aislamiento: agotar el tope de un staff NO afecta a otro staff ni a otro scope (voz) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare i integer;
begin
  for i in 1..40 loop perform restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600); end loop;
  if restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('a', 64), 40, 600) then raise exception 'el staff A debio quedar agotado'; end if;
  if not restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('d', 64), 40, 600) then raise exception 'otro staff no debio verse afectado'; end if;
  if not restaurantes.consume_api_rate_limit('voz-preview-sesion', repeat('a', 64), 20, 600) then raise exception 'otro scope (voz) no debio verse afectado'; end if;
end $$;
rollback;

\echo '--- 10. aislamiento entre organizaciones: el tope diario de la organizacion A no toca a la B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare i integer;
begin
  for i in 1..401 loop perform restaurantes.consume_api_rate_limit('agente-preview-org', repeat('c', 64), 400, 86400); end loop;
  if not restaurantes.consume_api_rate_limit('agente-preview-org', repeat('e', 64), 400, 86400) then raise exception 'la organizacion B no debio verse afectada'; end if;
end $$;
rollback;

\echo '--- 11. una ventana vencida reinicia el contador (el staff recupera el cupo tras 10 min) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare i integer;
begin
  for i in 1..41 loop perform restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('f', 64), 40, 600); end loop;
  reset role;
  update restaurantes.api_rate_limits set window_started_at = now() - interval '11 minutes' where scope = 'agente-preview-staff' and actor_hash = repeat('f', 64);
  set local role authenticated;
  if not restaurantes.consume_api_rate_limit('agente-preview-staff', repeat('f', 64), 40, 600) then raise exception 'la ventana vencida debio reiniciar el cupo'; end if;
end $$;
rollback;

\echo '--- 12. el actor se guarda como sha256: un valor en claro (id de staff, IP) NO cuenta ni queda registrado (devuelve false) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.consume_api_rate_limit('agente-preview-staff', '00000000-0000-0000-0000-0000000f0c01', 40, 600)::int as actor_en_claro_deberia_ser_0;
rollback;

\echo ''
\echo '=== C) misma clase en citas («Probar conexion» de Cal.com/CalDAV) ==='
\echo ''

\echo '--- 13. citas.consume_api_rate_limit con la sesion del staff: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select citas.consume_api_rate_limit('citas-calendar-test-connection', repeat('a', 64), 20, 60) as should_fail;
rollback;

\echo '--- 14. citas.consume_api_rate_limit con la sesion de sistema: el 21 de 21 se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (array_agg(ok order by n))[21]::int as prueba_21_deberia_ser_0
from (select n, citas.consume_api_rate_limit('citas-calendar-test-connection', repeat('a', 64), 20, 60) as ok from generate_series(1, 21) n) t;
rollback;

\echo '--- 15. citas.get_provider_calendar_refresh_token (secreto del Vault) con la sesion del staff: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select citas.get_provider_calendar_refresh_token('00000000-0000-0000-0000-0000000f0d01') as should_fail;
rollback;
