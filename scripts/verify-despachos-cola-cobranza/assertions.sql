-- D-11 (cola de cobranza) -- verificación contra Postgres REAL de la migración 017.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en
-- ERROR; alias `..._deberia_ser_N` = el valor esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs).
-- Todos los datos son ficticios (RFC genéricos, teléfono de ejemplo); nada envía mensajes.
-- Sujetos: c01 admin A, c02 contador A, c03 auditor A, c04 admin B, c05 sin membresía, c06 staff de hoteles.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000d11a01', 'despachos', 'Despacho A', 'despacho-a-cobranza'),
  ('00000000-0000-0000-0000-000000d11a02', 'despachos', 'Despacho B', 'despacho-b-cobranza'),
  ('00000000-0000-0000-0000-000000d11a03', 'hoteles', 'Hotel H', 'hotel-h-cobranza')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11a01', 'despachos', 'Cliente A'),
  ('00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11a02', 'despachos', 'Cliente B'),
  ('00000000-0000-0000-0000-000000d11b03', '00000000-0000-0000-0000-000000d11a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d11c01', 'cobranza-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d11c02', 'cobranza-contador-a@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-000000d11c03', 'cobranza-auditor-a@example.com', 'Auditor A', 'seed'),
  ('00000000-0000-0000-0000-000000d11c04', 'cobranza-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d11c05', 'cobranza-none@example.com', 'Sin membresia', 'seed'),
  ('00000000-0000-0000-0000-000000d11c06', 'cobranza-hotel@example.com', 'Staff hoteles', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d11c01', '00000000-0000-0000-0000-000000d11a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d11c02', '00000000-0000-0000-0000-000000d11a01', null, 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d11c03', '00000000-0000-0000-0000-000000d11a01', null, 'member', 'auditor'),
  ('00000000-0000-0000-0000-000000d11c04', '00000000-0000-0000-0000-000000d11a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d11c06', '00000000-0000-0000-0000-000000d11a03', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values
  ('00000000-0000-0000-0000-000000d11d01', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11a11', 'I', 'AAA010101AA1', 'RRR010101RR1', 1000, 1160, true, '2026-07-10'),
  ('00000000-0000-0000-0000-000000d11d02', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11a12', 'I', 'AAA010101AA1', 'RRR010101RR1', 500, 580, true, '2026-07-11'),
  ('00000000-0000-0000-0000-000000d11d03', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11a13', 'I', 'AAA010101AA1', 'RRS020202RS2', 200, 232, true, '2026-07-12'),
  ('00000000-0000-0000-0000-000000d11d04', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11a14', 'I', 'AAA010101AA1', 'RRR010101RR1', 100, 116, true, '2026-07-13'),
  ('00000000-0000-0000-0000-000000d11d05', '00000000-0000-0000-0000-000000d11a02', '00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11a15', 'I', 'AAA010101AA1', 'RRR010101RR1', 300, 348, true, '2026-07-14'),
  ('00000000-0000-0000-0000-000000d11d06', '00000000-0000-0000-0000-000000d11a02', '00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11a16', 'I', 'AAA010101AA1', 'BBB030303BB3', 300, 348, true, '2026-07-14')
on conflict do nothing;
insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento, monto_pagado, pagado_en) values
  ('00000000-0000-0000-0000-000000d11e01', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11d01', '2026-08-10', null, null),
  ('00000000-0000-0000-0000-000000d11e02', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11d02', '2026-08-11', null, null),
  ('00000000-0000-0000-0000-000000d11e03', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11d03', '2026-08-12', null, null),
  ('00000000-0000-0000-0000-000000d11e04', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11d04', '2026-08-13', 116, now()),
  ('00000000-0000-0000-0000-000000d11e05', '00000000-0000-0000-0000-000000d11a02', '00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11d05', '2026-08-14', null, null)
on conflict do nothing;
insert into despachos.cobranza_gestion (id, organization_id, property_id, receivable_id, tipo, estado, nota, fecha_seguimiento)
values ('00000000-0000-0000-0000-000000d11f01', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'llamada', 'pendiente', 'gestion-fixture-A', '2026-09-01')
on conflict do nothing;
insert into despachos.cobranza_gestion (id, organization_id, property_id, receivable_id, tipo, estado, monto_promesa_centavos, fecha_promesa)
values ('00000000-0000-0000-0000-000000d11f02', '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e02', 'promesa_pago', 'pendiente', 50000, '2026-09-15')
on conflict do nothing;

\echo '=== GESTIONES: escritura de staff (positivo) ==='
\echo '1. admin A crea una promesa de pago en centavos enteros -> queda pendiente con su monto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, 150000, current_date + 7, null);
select (count(*) filter (where tipo = 'promesa_pago' and estado = 'pendiente' and monto_promesa_centavos = 150000))::int as promesa_pendiente_deberia_ser_1 from despachos.cobranza_gestion;
rollback;

\echo '2. contador A registra una llamada sin seguimiento -> queda cumplida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c02', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'llamada', 'Contesto el contador del cliente', null, null, null);
select (count(*) filter (where tipo = 'llamada' and estado = 'cumplida'))::int as llamada_cumplida_deberia_ser_1 from despachos.cobranza_gestion where nota = 'Contesto el contador del cliente';
rollback;

\echo '3. una nota con fecha de seguimiento queda pendiente (entra a la cola)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e02', 'nota', 'Llamar el lunes', null, null, current_date + 3);
select (count(*) filter (where estado = 'pendiente'))::int as nota_pendiente_deberia_ser_1 from despachos.cobranza_gestion where nota = 'Llamar el lunes';
rollback;

\echo '4. un recordatorio manual sin nota es valido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e03', 'recordatorio', null, null, null, null);
rollback;

\echo '=== GESTIONES: roles, cross-tenant, cross-cliente, anon ==='
\echo '5. auditor A (solo lectura) NO puede crear gestiones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c03', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '6. admin de OTRO despacho (B) no puede crear gestiones sobre una cuenta de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '7. admin A no puede crear una gestion sobre una cuenta de B aunque indique la property A (cross-cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e05', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '8. admin A tampoco la crea indicando la property de B (sin membresia ahi)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11e05', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '9. usuario sin membresia no puede crear'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c05', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '10. staff de hoteles no puede crear en una property de despachos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c06', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '11. sesion de sistema (sin sub) rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '12. anon sin EXECUTE'
begin;
set local role anon;
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '=== GESTIONES: validacion de forma ==='
\echo '13. promesa sin monto -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, null, current_date + 1, null) as should_fail;
rollback;

\echo '14. promesa con monto 0 -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, 0, current_date + 1, null) as should_fail;
rollback;

\echo '15. promesa con monto negativo -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, -5, current_date + 1, null) as should_fail;
rollback;

\echo '16. promesa sin fecha -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, 100, null, null) as should_fail;
rollback;

\echo '17. promesa con fecha a mas de un ano -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', null, 100, current_date + 400, null) as should_fail;
rollback;

\echo '18. promesa sobre una cuenta ya pagada -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e04', 'promesa_pago', null, 100, current_date + 1, null) as should_fail;
rollback;

\echo '19. llamada sin nota -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'llamada', null, null, null, null) as should_fail;
rollback;

\echo '20. tipo desconocido -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'amenaza', null, null, null, null) as should_fail;
rollback;

\echo '21. monto de promesa en un tipo que no es promesa -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'nota', 'x', 100, null, null) as should_fail;
rollback;

\echo '22. nota de mas de 1000 caracteres -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'nota', repeat('a', 1001), null, null, null) as should_fail;
rollback;

\echo '23. cuenta inexistente -> P0002'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e99', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '24. tope de 500 gestiones por cuenta (54000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
reset role;
insert into despachos.cobranza_gestion (organization_id, property_id, receivable_id, tipo, estado)
  select '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e03', 'recordatorio', 'cumplida' from generate_series(1, 500);
set local role authenticated;
select despachos.cobranza_gestion_crear('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e03', 'recordatorio', null, null, null, null) as should_fail;
rollback;

\echo '=== GESTIONES: resolver ==='
\echo '25. contador A resuelve la gestion pendiente como cumplida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c02', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cumplida', 'Ya se hizo');
select (count(*) filter (where estado = 'cumplida' and nota = 'Ya se hizo'))::int as resuelta_deberia_ser_1 from despachos.cobranza_gestion where id = '00000000-0000-0000-0000-000000d11f01';
rollback;

\echo '26. una promesa pendiente se marca incumplida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f02', 'incumplida', null);
select (count(*) filter (where estado = 'incumplida' and tipo = 'promesa_pago' and monto_promesa_centavos = 50000))::int as incumplida_deberia_ser_1 from despachos.cobranza_gestion where id = '00000000-0000-0000-0000-000000d11f02';
rollback;

\echo '27. resolver dos veces la misma gestion -> 55000'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cancelada', null);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cumplida', null) as should_fail;
rollback;

\echo '28. estado 'pendiente' no es una resolucion valida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'pendiente', null) as should_fail;
rollback;

\echo '29. admin B no puede resolver una gestion de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cancelada', null) as should_fail;
rollback;

\echo '30. admin B tampoco usando su propia property (cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11f01', 'cancelada', null) as should_fail;
rollback;

\echo '31. auditor A no puede resolver'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c03', true);
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cancelada', null) as should_fail;
rollback;

\echo '32. anon no puede resolver'
begin;
set local role anon;
select despachos.cobranza_gestion_resolver('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11f01', 'cancelada', null) as should_fail;
rollback;

\echo '=== TABLAS: acceso directo cerrado y aislamiento de lectura ==='
\echo '33. authenticated NO puede insertar directo en cobranza_gestion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
insert into despachos.cobranza_gestion (organization_id, property_id, receivable_id, tipo) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'nota') returning id as should_fail;
rollback;

\echo '34. authenticated NO puede actualizar directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
update despachos.cobranza_gestion set estado = 'cancelada' returning id as should_fail;
rollback;

\echo '35. authenticated NO puede borrar directo (una gestion jamas se borra)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
delete from despachos.cobranza_gestion returning id as should_fail;
rollback;

\echo '36. anon no puede leer gestiones'
begin;
set local role anon;
select count(*) as should_fail from despachos.cobranza_gestion;
rollback;

\echo '37. staff de A ve su gestion fixture'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select count(*)::int as ve_propia_deberia_ser_1 from despachos.cobranza_gestion where id = '00000000-0000-0000-0000-000000d11f01';
rollback;

\echo '38. staff de B NO ve gestiones de A (RLS)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select count(*)::int as aislamiento_deberia_ser_0 from despachos.cobranza_gestion;
rollback;

\echo '39. usuario sin membresia no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c05', true);
select count(*)::int as sin_membresia_deberia_ser_0 from despachos.cobranza_gestion;
rollback;

\echo '40. la llave foranea compuesta impide una gestion con cuenta de otra property'
begin;
reset role;
insert into despachos.cobranza_gestion (organization_id, property_id, receivable_id, tipo) values ('00000000-0000-0000-0000-000000d11a02', '00000000-0000-0000-0000-000000d11b02', '00000000-0000-0000-0000-000000d11e01', 'recordatorio') returning id as should_fail;
rollback;

\echo '41. el CHECK de promesa impide una promesa sin monto aunque se escriba como superusuario'
begin;
insert into despachos.cobranza_gestion (organization_id, property_id, receivable_id, tipo, fecha_promesa) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'promesa_pago', current_date) returning id as should_fail;
rollback;

\echo '=== WHATSAPP: consentimiento opt-in / opt-out ==='
\echo '42. admin A registra opt-in con evidencia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autorizo por escrito en la firma del contrato');
select (count(*) filter (where estado = 'opt_in' and telefono = '+5219981234567'))::int as optin_deberia_ser_1 from despachos.cobranza_whatsapp_consentimiento;
rollback;

\echo '43. opt-in sin evidencia -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', null) as should_fail;
rollback;

\echo '44. telefono sin formato E.164 -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '9981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '45. RFC con formato invalido -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'XX', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '46. un RFC que solo es cliente de B no se puede dar de alta en A (cross-cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'BBB030303BB3', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '47. estado desconocido -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'quizas', 'ok') as should_fail;
rollback;

\echo '48. auditor A no puede fijar consentimiento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c03', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '49. admin B no puede fijar consentimiento en la property de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '50. anon no puede fijar consentimiento'
begin;
set local role anon;
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '51. sistema (sin sub) no puede fijar consentimiento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'ok') as should_fail;
rollback;

\echo '52. el consentimiento es por property: el opt-in de B no afecta a A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
reset role;
insert into despachos.cobranza_whatsapp_consentimiento (organization_id, property_id, rfc_receptor, telefono, estado, evidencia) values ('00000000-0000-0000-0000-000000d11a02', '00000000-0000-0000-0000-000000d11b02', 'RRR010101RR1', '+5219981234567', 'opt_in', 'x');
set local role authenticated;
select count(*)::int as consentimiento_ajeno_deberia_ser_0 from despachos.cobranza_whatsapp_consentimiento where rfc_receptor = 'RRR010101RR1';
rollback;

\echo '=== WHATSAPP: outbox (solo encola, nunca envia) ==='
\echo '53. con opt-in se encola en estado pendiente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1');
select (count(*) filter (where estado = 'pendiente' and rfc_receptor = 'RRR010101RR1'))::int as encolado_deberia_ser_1 from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '54. el mismo dedupe_key es idempotente (duplicado = true, una sola fila)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1');
select (select count(*) from despachos.cobranza_whatsapp_outbox)::int * 10 + (select out_duplicado::int from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1')) as idempotente_deberia_ser_11;
rollback;

\echo '55. sin consentimiento -> CB001'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '56. con opt-out -> no se encola'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_out', null);
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '57. opt-out cancela los mensajes pendientes del cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e02', 'Recordatorio de pago', 'dk-2');
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_out', null);
select (count(*) filter (where estado = 'cancelado'))::int * 10 + (count(*) filter (where estado = 'pendiente'))::int as cancelados_deberia_ser_20 from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '58. el opt-in de un cliente no habilita a OTRO cliente de la misma property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e03', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '59. cuenta ya pagada -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e04', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '60. cuenta de otra property (cross-tenant) -> rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e05', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '61. cuerpo vacio -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', '   ', 'dk-1') as should_fail;
rollback;

\echo '62. cuerpo de mas de 1000 caracteres -> rechazado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', repeat('a', 1001), 'dk-1') as should_fail;
rollback;

\echo '63. auditor A no puede encolar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c03', true);
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '64. admin B no puede encolar sobre una cuenta de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '65. anon no puede encolar'
begin;
set local role anon;
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '66. sistema (sin sub) no puede encolar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;

\echo '67. tope de 200 mensajes pendientes por property (54000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
reset role;
insert into despachos.cobranza_whatsapp_consentimiento (organization_id, property_id, rfc_receptor, telefono, estado, evidencia) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'x');
insert into despachos.cobranza_whatsapp_outbox (organization_id, property_id, receivable_id, rfc_receptor, telefono, cuerpo, dedupe_key)
  select '00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'RRR010101RR1', '+5219981234567', 'm', 'bulk-' || g from generate_series(1, 200) g;
set local role authenticated;
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-tope') as should_fail;
rollback;

\echo '68. el staff NO puede leer la columna telefono del outbox (PII)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select telefono as should_fail from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '69. el staff SI puede leer el resto de columnas del outbox'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select id, estado, cuerpo, rfc_receptor from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '70. staff de B no ve el outbox de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c04', true);
reset role;
insert into despachos.cobranza_whatsapp_outbox (organization_id, property_id, receivable_id, rfc_receptor, telefono, cuerpo, dedupe_key) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'RRR010101RR1', '+5219981234567', 'm', 'a-1');
set local role authenticated;
select count(*)::int as outbox_ajeno_deberia_ser_0 from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '71. authenticated NO puede insertar directo en el outbox'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
insert into despachos.cobranza_whatsapp_outbox (organization_id, property_id, receivable_id, rfc_receptor, telefono, cuerpo, dedupe_key) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'RRR010101RR1', '+5219981234567', 'm', 'x') returning id as should_fail;
rollback;

\echo '72. authenticated NO puede insertar directo en consentimientos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
insert into despachos.cobranza_whatsapp_consentimiento (organization_id, property_id, rfc_receptor, telefono, estado, evidencia) values ('00000000-0000-0000-0000-000000d11a01', '00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'x') returning id as should_fail;
rollback;

\echo '73. anon no puede leer el outbox'
begin;
set local role anon;
select count(*) as should_fail from despachos.cobranza_whatsapp_outbox;
rollback;

\echo '74. el helper interno _cobranza_contexto no es ejecutable por authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos._cobranza_contexto('00000000-0000-0000-0000-000000d11b01', false) as should_fail;
rollback;

\echo '=== ESTRUCTURA: postura de seguridad ==='
\echo '75. las 3 tablas tienen RLS habilitado'
begin;
select (count(*) filter (where c.relrowsecurity))::int as rls_deberia_ser_3
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'despachos' and c.relname in ('cobranza_gestion', 'cobranza_whatsapp_consentimiento', 'cobranza_whatsapp_outbox');
rollback;

\echo '76. ninguna policy de las tablas nuevas es permisiva (using true) ni aplica a anon'
begin;
select count(*)::int as policies_permisivas_deberia_ser_0 from pg_policies
where schemaname = 'despachos' and tablename like 'cobranza\_%' and (qual = 'true' or with_check = 'true' or 'anon' = any(roles));
rollback;

\echo '77. las 5 funciones definer fijan search_path'
begin;
select (count(*) filter (where p.prosecdef and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')))::int as definer_con_search_path_deberia_ser_5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'despachos' and p.proname in ('_cobranza_contexto', 'cobranza_gestion_crear', 'cobranza_gestion_resolver', 'cobranza_whatsapp_consentimiento_fijar', 'cobranza_whatsapp_encolar');
rollback;

\echo '78. ni anon ni public tienen privilegios sobre las tablas nuevas'
begin;
select count(*)::int as grants_anon_deberia_ser_0 from information_schema.role_table_grants
where table_schema = 'despachos' and table_name like 'cobranza\_%' and grantee in ('anon', 'PUBLIC');
rollback;


\echo '79. un dedupe_key ya usado por OTRA cuenta no se devuelve como duplicado (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d11c01', true);
select despachos.cobranza_whatsapp_consentimiento_fijar('00000000-0000-0000-0000-000000d11b01', 'RRR010101RR1', '+5219981234567', 'opt_in', 'Autoriza por contrato');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e01', 'Recordatorio de pago', 'dk-1');
select * from despachos.cobranza_whatsapp_encolar('00000000-0000-0000-0000-000000d11b01', '00000000-0000-0000-0000-000000d11e02', 'Recordatorio de pago', 'dk-1') as should_fail;
rollback;
