-- Cobro por plan medido (packages/db/migrations/0080 + packages/domain-restaurantes/migrations/200) contra Postgres REAL.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias con
-- sufijo `_deberia_ser_N` = valor esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role authenticated`
-- + claim `request.jwt.claim.sub`.
-- Sujetos: c201 owner de A, c202 owner de B, c203 superadmin sin membresia, c204 miembro (no owner) de A.
-- Organizaciones: A y B (restaurantes, America/Merida), H (hoteles).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, timezone) values
  ('00000000-0000-0000-0000-00000000b201', 'restaurantes', 'Resto A cobro', 'resto-a-cobro', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000b202', 'restaurantes', 'Resto B cobro', 'resto-b-cobro', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000b203', 'hoteles', 'Hotel H cobro', 'hotel-h-cobro', 'America/Merida')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000b201', 'restaurantes', 'A sucursal 1', 'active'),
  ('00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-00000000b201', 'restaurantes', 'A sucursal 2', 'active'),
  ('00000000-0000-0000-0000-00000000d203', '00000000-0000-0000-0000-00000000b201', 'restaurantes', 'A sucursal cerrada', 'inactive'),
  ('00000000-0000-0000-0000-00000000d204', '00000000-0000-0000-0000-00000000b202', 'restaurantes', 'B sucursal 1', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c201', 'cobro-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-00000000c202', 'cobro-owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-00000000c203', 'cobro-super@example.com', 'Super', 'seed'),
  ('00000000-0000-0000-0000-00000000c204', 'cobro-member-a@example.com', 'Member A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000b201', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000b202', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-00000000b201', null, 'member', 'staff')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c203') on conflict do nothing;
-- Plan a la medida de A (cifras de prueba, no son precios reales) y un plan de lista.
insert into core.plan (id, nombre, vertical, precio_base_mxn_centavos, modelo_cobro, sucursales_incluidas, minutos_voz_incluidos,
  precio_minuto_voz_excedente_mxn_centavos, conversaciones_wa_incluidas, precio_conversacion_wa_excedente_mxn_centavos, uso_justo_pct,
  organizacion_exclusiva_id)
values ('cobro-medida-a', 'A la medida A', 'restaurantes', 1000000, 'medido', 7, 1000, 100, 100, 50, 150, '00000000-0000-0000-0000-00000000b201')
on conflict do nothing;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_sucursal_mxn_centavos, minutos_voz_incluidos_por_sucursal)
values ('cobro-lista', 'Lista por sucursal', 'restaurantes', 'medido', 100000, 100)
on conflict do nothing;

\echo '=== TARIFA (superadmin) ==='
\echo '1. el superadmin fija la tarifa y la funcion la devuelve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select ((core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"minutosVozIncluidosPorSucursal": 1300, "precioMinutoVozExcedenteCentavos": 250, "cuotaAltaCentavos": 500000}'::jsonb)->>'minutosVozIncluidosPorSucursal') = '1300')::int as tarifa_fijada_deberia_ser_1;
rollback;

\echo '2. una clave ausente conserva su valor (precioSucursalCentavos sigue en 100000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select ((core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"usoJustoPct": 150}'::jsonb)->>'precioSucursalCentavos') = '100000')::int as conserva_deberia_ser_1;
rollback;

\echo '3. la tarifa queda en la bitacora append-only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"usoJustoPct": 150}'::jsonb);
reset role;
select count(*)::int as bitacora_deberia_ser_1 from core.plan_audit_log where plan_id = 'cobro-lista' and event = 'plan_upserted' and detail ? 'tarifa';
rollback;

\echo '4. un owner NO puede fijar tarifas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c201', 'cobro-lista', '{"usoJustoPct": 150}'::jsonb) as should_fail;
rollback;

\echo '5. caller binding: el superadmin no puede firmar como otro'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"usoJustoPct": 150}'::jsonb) as should_fail;
rollback;

\echo '6. una clave desconocida se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"descuentoMagico": 100}'::jsonb) as should_fail;
rollback;

\echo '7. un monto con decimales se rechaza (todo va en centavos enteros)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"precioMinutoVozExcedenteCentavos": 2.5}'::jsonb) as should_fail;
rollback;

\echo '8. un monto negativo se rechaza (check de la tabla)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"precioSucursalCentavos": -1}'::jsonb) as should_fail;
rollback;

\echo '9. uso justo menor a 100 por ciento se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"usoJustoPct": 90}'::jsonb) as should_fail;
rollback;

\echo '10. modeloCobro invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"modeloCobro": "gratis"}'::jsonb) as should_fail;
rollback;

\echo '11. un plan a la medida no puede atarse a una organizacion de otra vertical'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"organizacionExclusivaId": "00000000-0000-0000-0000-00000000b203"}'::jsonb) as should_fail;
rollback;

\echo '12. anon no puede fijar tarifas'
begin;
set local role anon;
select core.superadmin_set_plan_tarifa('00000000-0000-0000-0000-00000000c203', 'cobro-lista', '{"usoJustoPct": 150}'::jsonb) as should_fail;
rollback;

\echo '13. el listado de tarifas: el superadmin ve los 2 planes de prueba'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select count(*)::int as tarifas_deberia_ser_2 from core.list_plan_tarifas_for_superadmin('00000000-0000-0000-0000-00000000c203') t where t->>'planId' like 'cobro-%';
rollback;

\echo '14. el listado de tarifas: un owner no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select count(*)::int as owner_no_ve_deberia_ser_0 from core.list_plan_tarifas_for_superadmin('00000000-0000-0000-0000-00000000c201');
rollback;

\echo '=== PLAN A LA MEDIDA (integridad en la base) ==='
\echo '15. el plan a la medida de A se asigna a A'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b201', 'cobro-medida-a');
select count(*)::int as asignado_deberia_ser_1 from core.organization_plan where organization_id = '00000000-0000-0000-0000-00000000b201' and plan_id = 'cobro-medida-a';
rollback;

\echo '16. el plan a la medida de A NO se asigna a B (aun escribiendo directo en la tabla)'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b202', 'cobro-medida-a') returning 1 as should_fail;
rollback;

\echo '17. un plan de lista asignado a B no se puede volver a la medida de A'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b202', 'cobro-lista');
update core.plan set organizacion_exclusiva_id = '00000000-0000-0000-0000-00000000b201' where id = 'cobro-lista' returning 1 as should_fail;
rollback;

\echo '18. la solicitud de asignacion del superadmin tambien respeta la exclusividad (B no puede recibir el plan de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-00000000b202', 'cobro-medida-a', 'prueba de exclusividad del plan a la medida');
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-00000000c203', (select id from core.plan_assignment_request where organization_id = '00000000-0000-0000-0000-00000000b202' and estado = 'pending')) as should_fail;
rollback;

\echo '=== TARIFA DE UNA ORGANIZACION ==='
\echo '19. el owner de A ve su plan y sus 2 sucursales activas (la inactiva no cuenta)'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b201', 'cobro-medida-a');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select (core.plan_tarifa_for_org('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000b201')->>'sucursalesActivas')::int as sucursales_deberia_ser_2;
rollback;

\echo '20. un miembro (no owner) de A tambien la ve (es la pantalla Plan y uso)'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b201', 'cobro-medida-a');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c204', true);
select ((core.plan_tarifa_for_org('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-00000000b201')->'plan'->>'minutosVozIncluidos') = '1000')::int as miembro_ve_deberia_ser_1;
rollback;

\echo '21. el owner de B NO ve la tarifa de A (null)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c202', true);
select (core.plan_tarifa_for_org('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000b201') is null)::int as cruzado_es_null_deberia_ser_1;
rollback;

\echo '22. caller binding: B no puede firmar como A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c202', true);
select core.plan_tarifa_for_org('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000b201') as should_fail;
rollback;

\echo '23. anon no puede leer la tarifa'
begin;
set local role anon;
select core.plan_tarifa_for_org(null, '00000000-0000-0000-0000-00000000b201') as should_fail;
rollback;

\echo '24. sesion de sistema: lee la tarifa (webhook de cobro); sin plan, plan es null'
begin;
select ((core.plan_tarifa_for_org(null, '00000000-0000-0000-0000-00000000b202')->'plan') = 'null'::jsonb)::int as sin_plan_null_deberia_ser_1;
rollback;

\echo '25. ningun rol de la app lee core.plan directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select * from core.plan as should_fail;
rollback;

\echo '=== USO FACTURABLE (restaurantes) ==='
\echo '26. minutos de voz: 100 s + 50 s de llamadas reales = 3 minutos (redondeo hacia arriba del total); preview y llamada en curso no cuentan'
begin;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000d201', 'v1', 'llamada', 'elevenlabs-agents', '2026-10-10 18:00:00+00', 100),
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000d202', 'v2', 'llamada', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 50),
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000d201', 'v3', 'preview', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 600),
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000d201', 'v4', 'llamada', 'elevenlabs-agents', '2026-10-12 18:00:00+00', null);
select (restaurantes.uso_facturable_mes(null, '00000000-0000-0000-0000-00000000b201', '2026-10-01')->>'minutosVoz')::int as minutos_deberia_ser_3;
rollback;

\echo '27. una llamada a las 23:30 de Merida del 31 de octubre cuenta en OCTUBRE (en UTC ya es noviembre)'
begin;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000d201', 'tz1', 'llamada', 'elevenlabs-agents', '2026-11-01 05:30:00+00', 120);
select (restaurantes.uso_facturable_mes(null, '00000000-0000-0000-0000-00000000b201', '2026-10-15')->>'llamadas')::int as en_octubre_deberia_ser_1;
rollback;

\echo '28. conversaciones de WhatsApp: mismo cliente 2 veces el mismo dia = 1; al dia siguiente = otra; otro cliente = otra; fallido no cuenta -> 3'
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, status, claimed_at) values
  ('m1', '00000000-0000-0000-0000-00000000b201', repeat('a', 64), 'processed', '2026-10-10 15:00:00+00'),
  ('m2', '00000000-0000-0000-0000-00000000b201', repeat('a', 64), 'processed', '2026-10-10 20:00:00+00'),
  ('m3', '00000000-0000-0000-0000-00000000b201', repeat('a', 64), 'processed', '2026-10-11 15:00:00+00'),
  ('m4', '00000000-0000-0000-0000-00000000b201', repeat('b', 64), 'processed', '2026-10-10 15:00:00+00'),
  ('m5', '00000000-0000-0000-0000-00000000b201', repeat('c', 64), 'failed', '2026-10-10 15:00:00+00'),
  ('m6', '00000000-0000-0000-0000-00000000b202', repeat('d', 64), 'processed', '2026-10-10 15:00:00+00');
select (restaurantes.uso_facturable_mes(null, '00000000-0000-0000-0000-00000000b201', '2026-10-01')->>'conversacionesWa')::int as conversaciones_deberia_ser_3;
rollback;

\echo '29. el owner de A lee su uso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select (restaurantes.uso_facturable_mes('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000b201', '2026-10-01') is not null)::int as owner_lee_deberia_ser_1;
rollback;

\echo '30. el owner de B NO lee el uso de A (null)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c202', true);
select (restaurantes.uso_facturable_mes('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000b201', '2026-10-01') is null)::int as cruzado_null_deberia_ser_1;
rollback;

\echo '31. caller binding del uso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c202', true);
select restaurantes.uso_facturable_mes('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000b201', '2026-10-01') as should_fail;
rollback;

\echo '32. anon no lee el uso'
begin;
set local role anon;
select restaurantes.uso_facturable_mes(null, '00000000-0000-0000-0000-00000000b201', '2026-10-01') as should_fail;
rollback;

\echo '33. una organizacion que no es de restaurantes se rechaza'
begin;
select restaurantes.uso_facturable_mes(null, '00000000-0000-0000-0000-00000000b203', '2026-10-01') as should_fail;
rollback;

\echo '34. el superadmin sin membresia lee el uso de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c203', true);
select (restaurantes.uso_facturable_mes('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-00000000b201', '2026-10-01') is not null)::int as superadmin_lee_deberia_ser_1;
rollback;

\echo 'los escenarios 4/5/6/7/8/9/10/11/12/16/17/18/22/23/25/31/32/33 deben terminar en ERROR'
