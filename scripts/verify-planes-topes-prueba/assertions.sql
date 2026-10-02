-- PL-16 (migracion 0045) -- verificacion contra Postgres REAL del medidor mensual de mensajes, los avisos de fin de prueba
-- y las lecturas de consumo. Cada escenario corre en su propio `begin; ... rollback;`.
-- Alias que termina en el sufijo de error = debe fallar; alias con sufijo `_deberia_ser_N` = el valor esperado
-- (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios; nada envia mensajes ni correos.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role authenticated`
-- + claim `request.jwt.claim.sub`.
-- Sujetos: c101 owner de A, c102 owner de B, c103 superadmin sin membresia, c104 miembro (no owner) de A.
-- Organizaciones: A (hoteles, America/Merida, plan con tope 1000), B (restaurantes, sin plan), C (hoteles en prueba).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, timezone) values
  ('00000000-0000-0000-0000-00000000a101', 'hoteles', 'Hotel A', 'hotel-a-pl16', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000a102', 'restaurantes', 'Restaurante B', 'resto-b-pl16', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-00000000a103', 'hoteles', 'Hotel C prueba', 'hotel-c-pl16', 'America/Merida')
on conflict do nothing;
update core.organization set status = 'trial', trial_ends_at = '2026-11-10 18:00:00+00' where id = '00000000-0000-0000-0000-00000000a103';
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c101', 'pl16-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-00000000c102', 'pl16-owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-00000000c103', 'pl16-super@example.com', 'Super', 'seed'),
  ('00000000-0000-0000-0000-00000000c104', 'pl16-member-a@example.com', 'Member A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-00000000a102', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c104', '00000000-0000-0000-0000-00000000a101', null, 'member', 'recepcion'),
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a103', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c103') on conflict do nothing;
insert into core.plan (id, nombre, vertical) values ('pl16-test', 'Plan de prueba PL-16', 'hoteles') on conflict do nothing;
insert into core.plan_limit (plan_id, metrica, limite, accion_al_exceder) values ('pl16-test', 'mensajes_mes', 1000, 'avisar') on conflict do nothing;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000a101', 'pl16-test') on conflict do nothing;

-- Ayuda de fixture: registra N mensajes distintos de una organizacion en un instante.
create or replace function public.pl16_llenar(p_org uuid, p_n integer, p_at timestamptz, p_prefijo text) returns bigint
language sql as $$
  select count(core.message_usage_record(p_org, 'wa_test', p_prefijo || g, p_at, false, false, null)) from generate_series(1, p_n) g;
$$;

\echo '=== MEDIDOR: umbrales y excedente ==='
\echo '1. con 800 mensajes no hay aviso; el 801 (de 1000) cruza el 80 por ciento'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 800, '2026-10-10 12:00:00+00', 'a');
select (core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'b801', '2026-10-10 12:00:00+00')->>'cruce' = 'aviso80')::int as aviso_801_deberia_ser_1;
rollback;

\echo '2. el aviso del 80 por ciento sale una sola vez: el mensaje 802 ya no cruza nada'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 801, '2026-10-10 12:00:00+00', 'a');
select (core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'b802', '2026-10-10 12:00:00+00')->>'cruce' = 'ninguno')::int as sin_segundo_aviso_deberia_ser_1;
rollback;

\echo '3. el mensaje 1001 se registra como excedente y cruza el tope'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, '2026-10-10 12:00:00+00', 'a');
select (core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'b1001', '2026-10-10 12:00:00+00')->>'cruce' = 'excedido')::int as excedido_1001_deberia_ser_1;
rollback;

\echo '4. el excedente se acumula: 1001 y 1002 dan 2 excedentes y el contador sigue (usado 1002)'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1002, '2026-10-10 12:00:00+00', 'a');
select count(*)::int as excedentes_deberia_ser_2 from core.message_usage_event where organization_id = '00000000-0000-0000-0000-00000000a101' and excedente;
rollback;

\echo '5. un mensaje repetido (misma referencia) no cuenta dos veces'
begin;
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'dup-1', '2026-10-10 12:00:00+00');
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'dup-1', '2026-10-10 12:00:00+00');
select count(*)::int as una_sola_fila_deberia_ser_1 from core.message_usage_event where ref_id = 'dup-1';
rollback;

\echo '6. una organizacion sin plan no tiene tope: ni aviso ni excedente'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a102', 50, '2026-10-10 12:00:00+00', 'b');
select count(*)::int as sin_excedente_deberia_ser_0 from core.message_usage_event where organization_id = '00000000-0000-0000-0000-00000000a102' and excedente;
rollback;

\echo '=== MEDIDOR: zona horaria del negocio ==='
\echo '7. 23:30 de Merida del 31 de octubre cuenta en OCTUBRE (en UTC ya seria noviembre)'
begin;
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'tz-1', '2026-11-01 05:30:00+00');
select count(*)::int as cuenta_en_octubre_deberia_ser_1 from core.message_usage_event where ref_id = 'tz-1' and periodo = '2026-10-01';
rollback;

\echo '8. un minuto despues de la medianoche local (00:30 del 1 de noviembre en Merida) cuenta en NOVIEMBRE'
begin;
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'tz-2', '2026-11-01 06:30:00+00');
select count(*)::int as cuenta_en_noviembre_deberia_ser_1 from core.message_usage_event where ref_id = 'tz-2' and periodo = '2026-11-01';
rollback;

\echo '9. los contadores de octubre y noviembre son independientes (el tope se reinicia cada mes)'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, '2026-11-01 05:30:00+00', 'oct');
select (core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'nov-1', '2026-11-01 06:30:00+00')->>'cruce' = 'ninguno')::int as nuevo_mes_sin_cruce_deberia_ser_1;
rollback;

\echo '10. una zona horaria inventada se rechaza'
begin;
update core.organization set timezone = 'Marte/Fobos' where id = '00000000-0000-0000-0000-00000000a102' returning 1 as should_fail;
rollback;

\echo '=== DECISION DE ENVIO (bloqueo solo de proactivos) ==='
\echo '11. plan con accion avisar: aun con el tope consumido se permite un proactivo'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, now(), 'a');
select (core.message_quota_check('00000000-0000-0000-0000-00000000a101', true)->>'permitir' = 'true')::int as avisar_permite_deberia_ser_1;
rollback;

\echo '12. plan con accion pausar y tope consumido: se omite el proactivo no critico'
begin;
update core.plan_limit set accion_al_exceder = 'pausar' where plan_id = 'pl16-test';
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, now(), 'a');
select (core.message_quota_check('00000000-0000-0000-0000-00000000a101', true)->>'permitir' = 'false')::int as pausar_omite_deberia_ser_1;
rollback;

\echo '13. plan con accion pausar y tope consumido: lo transaccional (respuesta a un cliente) SIEMPRE se permite'
begin;
update core.plan_limit set accion_al_exceder = 'pausar' where plan_id = 'pl16-test';
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, now(), 'a');
select (core.message_quota_check('00000000-0000-0000-0000-00000000a101', false)->>'permitir' = 'true')::int as transaccional_permite_deberia_ser_1;
rollback;

\echo '14. plan con accion pausar y tope consumido: un proactivo CRITICO tambien se permite'
begin;
update core.plan_limit set accion_al_exceder = 'pausar' where plan_id = 'pl16-test';
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 1000, now(), 'a');
select (core.message_quota_check('00000000-0000-0000-0000-00000000a101', true, true)->>'permitir' = 'true')::int as critico_permite_deberia_ser_1;
rollback;

\echo '15. plan con accion pausar por debajo del tope: se permite y el motivo es nulo'
begin;
update core.plan_limit set accion_al_exceder = 'pausar' where plan_id = 'pl16-test';
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 999, now(), 'a');
select (core.message_quota_check('00000000-0000-0000-0000-00000000a101', true)->>'permitir' = 'true' and core.message_quota_check('00000000-0000-0000-0000-00000000a101', true)->>'motivo' is null)::int as bajo_tope_permite_deberia_ser_1;
rollback;

\echo '16. un proactivo omitido queda registrado con su motivo y NO cuenta como mensaje atendido'
begin;
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_omitido', 'om-1', now(), true, true, 'tope_mensajes_plan');
select (count(*) filter (where resultado = 'omitido_proactivo' and motivo = 'tope_mensajes_plan') = 1 and count(*) filter (where resultado = 'contado') = 0)::int as omitido_registrado_deberia_ser_1 from core.message_usage_event where organization_id = '00000000-0000-0000-0000-00000000a101';
rollback;

\echo '=== LECTURAS Y AISLAMIENTO ==='
\echo '17. el owner de A lee su consumo (positivo: 801 usados de 1000)'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 801, now(), 'a');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select ((core.message_usage_for_org('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a101') #>> '{mensajes,usado}')::int = 801)::int as lectura_propia_deberia_ser_1;
rollback;

\echo '18. un miembro (no owner) de A tambien lee el consumo de su organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c104', true);
select (core.message_usage_for_org('00000000-0000-0000-0000-00000000c104', '00000000-0000-0000-0000-00000000a101') is not null)::int as miembro_lee_deberia_ser_1;
rollback;

\echo '19. cross-tenant: el owner de B NO ve el consumo de A (devuelve NULL, no un error que confirme existencia)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c102', true);
select (core.message_usage_for_org('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-00000000a101') is null)::int as ajeno_nulo_deberia_ser_1;
rollback;

\echo '20. caller binding: pasar el id de otro usuario como p_caller_id falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c102', true);
select core.message_usage_for_org('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a101') as should_fail;
rollback;

\echo '21. anon NO puede leer el consumo'
begin;
set local role anon;
select core.message_usage_for_org('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a101') as should_fail;
rollback;

\echo '22. un superadmin lee el consumo de cualquier organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c103', true);
select (core.message_usage_for_org('00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-00000000a101') is not null)::int as superadmin_lee_deberia_ser_1;
rollback;

\echo '23. el listado de superadmin devuelve las organizaciones con su consumo del mes (positivo)'
begin;
select public.pl16_llenar('00000000-0000-0000-0000-00000000a101', 3, now(), 'a');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c103', true);
select (count(*) filter (where organization_id = '00000000-0000-0000-0000-00000000a101' and usado = 3 and limite = 1000) = 1)::int as listado_deberia_ser_1 from core.superadmin_list_message_usage('00000000-0000-0000-0000-00000000c103');
rollback;

\echo '24. un owner NO puede usar el listado de superadmin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select * from core.superadmin_list_message_usage('00000000-0000-0000-0000-00000000c101') as should_fail;
rollback;

\echo '=== SOLO-SISTEMA: un usuario autenticado no puede tocar el medidor ==='
\echo '25. un usuario autenticado NO puede registrar mensajes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'hack-1', now()) as should_fail;
rollback;

\echo '26. un usuario autenticado NO puede consultar la decision de envio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select core.message_quota_check('00000000-0000-0000-0000-00000000a101', true) as should_fail;
rollback;

\echo '27. anon NO puede registrar mensajes'
begin;
set local role anon;
select core.message_usage_record('00000000-0000-0000-0000-00000000a101', 'wa_test', 'hack-2', now()) as should_fail;
rollback;

\echo '28. el libro mayor no es legible directo por un usuario autenticado'
begin;
set local role authenticated;
select count(*) from core.message_usage_event as should_fail;
rollback;

\echo '29. el log de avisos de prueba no es legible directo por un usuario autenticado'
begin;
set local role authenticated;
select count(*) from core.trial_notice_log as should_fail;
rollback;

\echo '=== FIN DE PRUEBA: avisos a 7 / 3 / 1 dias ==='
\echo '30. a 7 dias exactos de fin de prueba se reclama un aviso'
begin;
select count(*)::int as aviso_7_deberia_ser_1 from core.trial_notice_claim('2026-11-03 18:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103' and dias_antes = 7;
rollback;

\echo '31. a 6 dias (sin umbral) no se reclama nada'
begin;
select count(*)::int as sin_aviso_6_deberia_ser_0 from core.trial_notice_claim('2026-11-04 18:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '32. el aviso de 7 dias se reclama UNA sola vez aunque el cron corra varias veces el mismo dia'
begin;
select count(*) from core.trial_notice_claim('2026-11-03 18:00:00+00');
select count(*)::int as segunda_corrida_deberia_ser_0 from core.trial_notice_claim('2026-11-03 20:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103' and not es_reintento;
rollback;

\echo '33. a lo largo de la prueba salen exactamente 3 avisos (7, 3 y 1 dia), cada uno una vez'
begin;
select count(*) from core.trial_notice_claim('2026-11-03 18:00:00+00');
select count(*) from core.trial_notice_claim('2026-11-03 19:00:00+00');
select count(*) from core.trial_notice_claim('2026-11-07 18:00:00+00');
select count(*) from core.trial_notice_claim('2026-11-07 19:00:00+00');
select count(*) from core.trial_notice_claim('2026-11-09 18:00:00+00');
select count(*) from core.trial_notice_claim('2026-11-09 19:00:00+00');
select count(*)::int as tres_avisos_deberia_ser_3 from core.trial_notice_log where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '34. a las 23:30 de Merida el dia se cuenta en la zona del negocio (en UTC ya seria otro dia): faltan 7 dias, no 6'
begin;
update core.organization set trial_ends_at = '2026-11-07 18:00:00+00' where id = '00000000-0000-0000-0000-00000000a103';
select count(*)::int as aviso_zona_negocio_deberia_ser_1 from core.trial_notice_claim('2026-11-01 05:30:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103' and dias_antes = 7;
rollback;

\echo '35. una organizacion activa (no en prueba) no recibe aviso aunque tenga fecha'
begin;
update core.organization set status = 'active' where id = '00000000-0000-0000-0000-00000000a103';
select count(*)::int as activa_sin_aviso_deberia_ser_0 from core.trial_notice_claim('2026-11-03 18:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '36. una prueba sin fecha de fin (NULL) nunca avisa'
begin;
update core.organization set trial_ends_at = null where id = '00000000-0000-0000-0000-00000000a103';
select count(*)::int as sin_fecha_deberia_ser_0 from core.trial_notice_claim('2026-11-03 18:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '37. un correo fallido se reintenta (media hora despues) y uno entregado ya no vuelve a reclamarse'
begin;
select count(*) from core.trial_notice_claim('2026-11-03 18:00:00+00');
select core.trial_notice_mark('00000000-0000-0000-0000-00000000a103', 7, '2026-11-10 18:00:00+00', 'error');
select count(*) from core.trial_notice_claim('2026-11-03 19:00:00+00') where es_reintento;
select core.trial_notice_mark('00000000-0000-0000-0000-00000000a103', 7, '2026-11-10 18:00:00+00', 'enviado');
select count(*)::int as entregado_no_reclama_deberia_ser_0 from core.trial_notice_claim('2026-11-03 21:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '38. el reintento de un correo fallido tiene tope de 3 intentos'
begin;
select count(*) from core.trial_notice_claim('2026-11-03 18:00:00+00');
select core.trial_notice_mark('00000000-0000-0000-0000-00000000a103', 7, '2026-11-10 18:00:00+00', 'error');
select count(*) from core.trial_notice_claim('2026-11-03 19:00:00+00');
select core.trial_notice_mark('00000000-0000-0000-0000-00000000a103', 7, '2026-11-10 18:00:00+00', 'error');
select count(*) from core.trial_notice_claim('2026-11-03 20:00:00+00');
select core.trial_notice_mark('00000000-0000-0000-0000-00000000a103', 7, '2026-11-10 18:00:00+00', 'error');
select count(*)::int as tope_intentos_deberia_ser_0 from core.trial_notice_claim('2026-11-03 21:00:00+00') where organization_id = '00000000-0000-0000-0000-00000000a103';
rollback;

\echo '39. los destinatarios del aviso son solo owner/admin de ESA organizacion'
begin;
select count(*)::int as destinatarios_deberia_ser_1 from core.trial_notice_recipients('00000000-0000-0000-0000-00000000a103');
rollback;

\echo '40. un usuario autenticado NO puede pedir los correos de los destinatarios'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select * from core.trial_notice_recipients('00000000-0000-0000-0000-00000000a103') as should_fail;
rollback;

\echo '41. un usuario autenticado NO puede reclamar avisos de prueba'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select * from core.trial_notice_claim('2026-11-03 18:00:00+00') as should_fail;
rollback;

\echo '42. anon NO puede reclamar avisos de prueba'
begin;
set local role anon;
select * from core.trial_notice_claim('2026-11-03 18:00:00+00') as should_fail;
rollback;

\echo '43. la lectura del cliente expone los dias restantes de la prueba calculados en su zona'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c101', true);
select ((core.message_usage_for_org('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000a103') #>> '{prueba,activa}') = 'true')::int as prueba_activa_deberia_ser_1;
rollback;
