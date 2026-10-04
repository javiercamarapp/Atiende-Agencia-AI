-- D-P3-13/14/18/22/23 -- verificación contra Postgres REAL de la migración 026 (clasificación al ingerir, correcciones por RFC, pólizas del periodo
-- del cron, UUID por cliente, marca de rechazo de una revisión, dirección al capturar la ficha y portal: CFDI del cliente y autoaceptado).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado
-- (ver run-gate.mjs). Los negativos tienen un control positivo con la misma precondición para que un fallo por otra causa no se confunda con la defensa
-- que se prueba. Sujetos: admin de A (org-wide), contador de A acotado a UN cliente (A1), readonly de A, admin de B (otro despacho), usuario sin
-- membresía y sesión sin sub (sistema / anon). Todos los RFC, folios y nombres son ficticios.
\set ON_ERROR_STOP off
\pset pager off


insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000d26a1', 'despachos', 'Despacho A', 'despacho-a-ingesta', 'active'),
  ('00000000-0000-0000-0000-0000000d26a2', 'despachos', 'Despacho B', 'despacho-b-ingesta', 'active'),
  ('00000000-0000-0000-0000-0000000d26a3', 'hoteles', 'Hotel H', 'hotel-h-ingesta', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-0000000d26a1', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-0000000d26b3', '00000000-0000-0000-0000-0000000d26a2', 'despachos', 'Cliente B1'),
  ('00000000-0000-0000-0000-0000000d26b4', '00000000-0000-0000-0000-0000000d26a3', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d26c1', 'ingesta-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000d26c2', 'ingesta-contador-a1@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-0000000d26c3', 'ingesta-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-0000000d26c4', 'ingesta-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-0000000d26c5', 'ingesta-nadie@example.com', 'Sin membresia', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d26c1', '00000000-0000-0000-0000-0000000d26a1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000d26c2', '00000000-0000-0000-0000-0000000d26a1', array['00000000-0000-0000-0000-0000000d26b1']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-0000000d26c3', '00000000-0000-0000-0000-0000000d26a1', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-0000000d26c4', '00000000-0000-0000-0000-0000000d26a2', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal) values
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 'CCC010101CC1', 'Cliente A1 SA', array['601'], '06000'),
  ('00000000-0000-0000-0000-0000000d26b3', '00000000-0000-0000-0000-0000000d26a2', 'DDD010101DD1', 'Cliente B1 SA', array['601'], '06000')
on conflict do nothing;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '1050000', 'Clientes', 'D'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '2010000', 'Proveedores nacionales', 'A'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '2600300', 'IVA acreditable', 'D'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '2600400', 'IVA trasladado', 'A'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '4080000', 'Ingresos por servicios', 'A'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '6020100', 'Servicios profesionales', 'D'),
  ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', '6020300', 'Servicios de mantenimiento', 'D')
on conflict do nothing;
-- CFDI ficticios de A1 (centavos: 100000 + 16000 de IVA = 116000). d01 recibido clasificado y limpio; d02 recibido con revisión pendiente; d03 cancelado;
-- d04 con revisión ya rechazada; d05 recibido sin clasificar; d06 emitido de tipo E; d07 recibido del periodo cerrado; d08 recibido ya contabilizado;
-- d09 indeterminado cuyo emisor es el RFC de la ficha; d10 indeterminado ajeno; d11 de A2 (sin ficha); d12 de B1; d13 con clasificación 'otros' 0.30, d14 con 0.65, d15 corregida por una persona, d16 con empate.
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha,
                               direccion, metodo_pago, forma_pago, uso_cfdi, moneda, subtotal_centavos, total_centavos, iva_trasladado_centavos, estado_sat) values
  ('00000000-0000-0000-0000-000000d26d01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e01', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-10', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d02', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e02', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-11', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d03', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e03', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-12', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'cancelado'),
  ('00000000-0000-0000-0000-000000d26d04', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e04', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-13', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d05', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e05', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-14', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d06', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e06', 'E', 'CCC010101CC1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-15', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d07', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e07', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-05-10', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d08', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e08', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-16', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d09', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e09', 'I', 'CCC010101CC1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-17', 'indeterminado', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d10', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e10', 'I', 'XXX010101XX1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-18', 'indeterminado', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d11', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-000000d26e11', 'I', 'PPP010101PP1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-19', 'indeterminado', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d13', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e13', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-21', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d14', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e14', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-22', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d15', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e15', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-23', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d16', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e16', 'I', 'PPP010101PP1', 'CCC010101CC1', 1000, 1160, 160, true, '2026-07-24', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d26d12', '00000000-0000-0000-0000-0000000d26a2', '00000000-0000-0000-0000-0000000d26b3', '00000000-0000-0000-0000-000000d26e12', 'I', 'PPP010101PP1', 'DDD010101DD1', 1000, 1160, 160, true, '2026-07-20', 'recibido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente')
on conflict do nothing;
insert into despachos.invoice_review (id, organization_id, property_id, invoice_id, reason, status, resolved_by, resolved_at) values
  ('00000000-0000-0000-0000-0000000d26f1', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d02', 'prueba pendiente', 'pendiente', null, null),
  ('00000000-0000-0000-0000-0000000d26f2', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d04', 'prueba rechazada', 'rechazado', '00000000-0000-0000-0000-0000000d26c1', now()),
  ('00000000-0000-0000-0000-0000000d26f3', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'prueba por rechazar', 'pendiente', null, null)
on conflict do nothing;
-- Clasificaciones ya existentes (insert como dueño del fixture): d01 (la última manda: dos filas), d02, d03, d04, d06, d07, d08.
insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method, razon, created_at) values
  ('00000000-0000-0000-0000-000000d26d01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'otros', 0.300, 'reglas', 'primera', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-000000d26d01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', 'segunda', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000d26d02', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d03', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d04', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d06', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d07', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d08', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.800, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d13', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'otros', 0.300, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d14', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.650, 'reglas', null, now()),
  ('00000000-0000-0000-0000-000000d26d15', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'seguros', 1.000, 'manual', null, now()),
  ('00000000-0000-0000-0000-000000d26d16', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'servicios_profesionales', 0.450, 'reglas', 'Empate', now());
update despachos.invoice_classification set empate = true where invoice_id = '00000000-0000-0000-0000-000000d26d16';
update despachos.invoice set excluido_por_revision = true where id = '00000000-0000-0000-0000-000000d26d04';
insert into despachos.periodo_cierre (property_id, organization_id, anio, mes, status) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 2026, 5, 'closed') on conflict do nothing;
-- Portal: enlaces vigente de A1 y A2, uno expirado de A1; documentos recibidos.
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, creado_en, expira_en) values
  ('00000000-0000-0000-0000-00000d26ab01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', repeat('a', 64), 'enlace A1', '00000000-0000-0000-0000-0000000d26c1', now() - interval '1 day', now() + interval '10 days'),
  ('00000000-0000-0000-0000-00000d26ab02', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', repeat('b', 64), 'enlace A2', '00000000-0000-0000-0000-0000000d26c1', now() - interval '1 day', now() + interval '10 days'),
  ('00000000-0000-0000-0000-00000d26ab03', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', repeat('c', 64), 'enlace expirado', '00000000-0000-0000-0000-0000000d26c1', now() - interval '20 days', now() - interval '1 day');
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-00000d26ab01', 'cfdi_xml', 'uno.xml', 'application/xml', 3, repeat('1', 64), 'abc'::bytea),
  ('00000000-0000-0000-0000-00000d26aa02', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-00000d26ab01', 'cfdi_xml', 'dos.xml', 'application/xml', 3, repeat('2', 64), 'abc'::bytea),
  ('00000000-0000-0000-0000-00000d26aa03', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-00000d26ab01', 'pdf', 'tres.pdf', 'application/pdf', 3, repeat('3', 64), 'abc'::bytea),
  ('00000000-0000-0000-0000-00000d26aa04', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-00000d26ab01', 'cfdi_xml', 'cuatro.xml', 'application/xml', 3, repeat('4', 64), 'abc'::bytea),
  ('00000000-0000-0000-0000-00000d26aa05', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-00000d26ab02', 'cfdi_xml', 'cinco.xml', 'application/xml', 3, repeat('5', 64), 'abc'::bytea),
  ('00000000-0000-0000-0000-00000d26aa06', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-00000d26ab01', 'cfdi_xml', 'seis.xml', 'application/xml', 3, repeat('6', 64), 'abc'::bytea);
insert into despachos.property_config (property_id, organization_id, portal_autoaceptar_validos) values ('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-0000000d26a1', false) on conflict do nothing;


\echo '=== invoice_clasificar: escritura de la clasificación ==='

\echo '1. admin de A clasifica un CFDI de A1: fila nueva con método y razón'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false);
select (count(*) = 1 and bool_and(method = 'reglas' and razon = 'Coincidencias: laptop' and property_id = '00000000-0000-0000-0000-0000000d26b1'))::int as clasificar_deberia_ser_1 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d05';
rollback;

\echo '2. método 'claveprodserv' aceptado (control del CHECK ampliado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select ((despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'claveprodserv', 'Coincidencias: laptop', null, false)) is not null)::int as metodo_claveprodserv_deberia_ser_1;
rollback;

\echo '2. método 'correccion' aceptado (control del CHECK ampliado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select ((despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'correccion', 'Coincidencias: laptop', null, false)) is not null)::int as metodo_correccion_deberia_ser_1;
rollback;

\echo '3. categoría fina nueva aceptada y categoría inventada rechazada por el CHECK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'telefonia', 0.8, 'reglas', 'Coincidencias: laptop', null, false) is not null)::int as cat_fina_deberia_ser_1;
rollback;

\echo '3b. categoría inventada -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'inventada', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '4. método inválido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'ia', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '4b. method 'manual' fuerza confianza 1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.2, 'manual', 'Coincidencias: laptop', null, false);
select (confianza = 1)::int as manual_confianza_uno_deberia_ser_1 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d05';
rollback;

\echo '5. confianza fuera de rango -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 1.5, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '6. contador de A1 clasifica en A1 (control)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select (despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) is not null)::int as contador_propio_deberia_ser_1;
rollback;

\echo '7. contador de A1 NO clasifica en A2 (no es su cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-000000d26d11', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '8. readonly de A NO clasifica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c3', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '9. admin de B NO clasifica un CFDI de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '10. usuario sin membresía NO clasifica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c5', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '11. anon NO tiene EXECUTE'
begin;
set local role anon;
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '12. sesión de sistema (sin sub) NO clasifica por la vía de staff'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d05', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '13. el CFDI debe ser de la property indicada (cross-property dentro del mismo despacho) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d11', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '14. el CFDI de otro despacho tampoco (property de B con CFDI de B pero staff de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b3', '00000000-0000-0000-0000-000000d26d12', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '15. CFDI inexistente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_clasificar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26dff', 'equipo_computo', 0.8, 'reglas', 'Coincidencias: laptop', null, false) as should_fail;
rollback;

\echo '16. INSERT directo en invoice_classification como authenticated -> error (la escritura solo pasa por las funciones)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method) values ('00000000-0000-0000-0000-000000d26d05', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'otros', 0.3, 'reglas') returning 1 as should_fail;
rollback;

\echo '17. la lectura es por property: el admin de A ve las 2 clasificaciones de d01'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as ve_admin_a_deberia_ser_2 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '18. el admin de B no ve ninguna clasificación de A (cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select count(*) as ve_admin_b_deberia_ser_0 from despachos.invoice_classification where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '19. el contador de A1 no ve las clasificaciones de otra property (A2 no tiene, A1 sí)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select count(*) as ve_contador_a1_deberia_ser_2 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '=== correcciones por RFC ==='

\echo '20. guardar una corrección por RFC (admin de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null);
select (count(*) = 1 and bool_and(autor_id = '00000000-0000-0000-0000-0000000d26c1' and categoria = 'publicidad' and created_at is not null))::int as correccion_guardada_deberia_ser_1 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '21. guardar dos veces la misma clave actualiza (1 fila), con otra ClaveProdServ son 2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'seguros', '6020300');
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', '43211503', 'transporte', null);
select (count(*) = 2 and bool_or(categoria = 'seguros' and cuenta = '6020300'))::int as upsert_deberia_ser_1 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '22. RFC en minúsculas se normaliza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'ppp010101pp1', null, 'publicidad', null);
select (rfc_emisor = 'PPP010101PP1')::int as rfc_normalizado_deberia_ser_1 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '23. RFC inválido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'NOESRFC', null, 'publicidad', null) as should_fail;
rollback;

\echo '24. categoría de la corrección fuera del catálogo -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'sin_clasificar', null) as should_fail;
rollback;

\echo '25. ClaveProdServ de longitud incorrecta -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', '1234', 'publicidad', null) as should_fail;
rollback;

\echo '26. cuenta con formato inválido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', 'abc') as should_fail;
rollback;

\echo '27. el contador de A1 guarda en A1 (control)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select (despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null) is not null)::int as contador_corrige_deberia_ser_1;
rollback;

\echo '28. el contador de A1 NO guarda en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b2', 'PPP010101PP1', null, 'publicidad', null) as should_fail;
rollback;

\echo '29. readonly NO guarda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c3', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null) as should_fail;
rollback;

\echo '30. admin de B NO guarda en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null) as should_fail;
rollback;

\echo '31. anon NO tiene EXECUTE'
begin;
set local role anon;
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null) as should_fail;
rollback;

\echo '32. sin sub (sistema) NO guarda por la vía de staff'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null) as should_fail;
rollback;

\echo '33. INSERT directo en clasificacion_correccion -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad') returning 1 as should_fail;
rollback;

\echo '34. UPDATE directo en clasificacion_correccion -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
update despachos.clasificacion_correccion set categoria = 'seguros' where property_id = '00000000-0000-0000-0000-0000000d26b1' returning 1 as should_fail;
rollback;

\echo '35. el admin de A ve su corrección y el admin de B no (RLS)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', null, 'publicidad', null);
select count(*) as ve_admin_a_deberia_ser_1 from despachos.clasificacion_correccion;
rollback;

\echo '36. el admin de B no ve la corrección de A (cross-tenant)'
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad') on conflict do nothing;

\echo '36b. cross-tenant: el admin de B ve 0 correcciones de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select count(*) as ve_admin_b_deberia_ser_0 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;
delete from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';

\echo '37. eliminar: borra la propia y devuelve true'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.clasificacion_correccion (id, organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26c9', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (despachos.clasificacion_correccion_eliminar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26c9'))::int as elimino_deberia_ser_1;
select count(*) as quedan_deberia_ser_0 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '38. eliminar con otra property no borra (devuelve false) y la fila sigue ahí'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.clasificacion_correccion (id, organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26c9', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (not despachos.clasificacion_correccion_eliminar('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-0000000d26c9'))::int as eliminar_ajena_deberia_ser_1;
rollback;

\echo '39. el admin de B NO puede eliminar la corrección de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
reset role;
insert into despachos.clasificacion_correccion (id, organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26c9', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select despachos.clasificacion_correccion_eliminar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26c9') as should_fail;
rollback;

\echo '40. tope de 1000 correcciones por cliente (54000) con un control a 999'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) select '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', 'AAA' || lpad(g::text, 6, '0') || 'AA1', 'otros' from generate_series(1, 999) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b2', 'ZZZ010101ZZ1', null, 'otros', null) is not null)::int as correccion_1000_deberia_ser_1;
rollback;

\echo '41. la correccion 1001 se rechaza'
begin;
reset role;
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) select '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', 'AAA' || lpad(g::text, 6, '0') || 'AA1', 'otros' from generate_series(1, 1000) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b2', 'ZZZ010101ZZ1', null, 'otros', null) as should_fail;
rollback;

\echo '41b. actualizar una existente con el tope lleno SÍ se permite'
begin;
reset role;
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) select '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', 'AAA' || lpad(g::text, 6, '0') || 'AA1', 'otros' from generate_series(1, 1000) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (despachos.clasificacion_correccion_guardar('00000000-0000-0000-0000-0000000d26b2', 'AAA000001AA1', null, 'seguros', null) is not null)::int as actualizar_con_tope_deberia_ser_1;
rollback;

\echo '42. invoice_categoria_corregir: fila manual nueva + regla por RFC del emisor del CFDI'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', '6020300', true);
select (count(*) = 1 and bool_and(method = 'manual' and confianza = 1 and cuenta = '6020300' and classified_by = '00000000-0000-0000-0000-0000000d26c1'))::int as manual_deberia_ser_1 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d01' and categoria = 'seguros';
select (count(*) = 1 and bool_and(rfc_emisor = 'PPP010101PP1' and categoria = 'seguros' and cuenta = '6020300'))::int as regla_deberia_ser_1 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '43. invoice_categoria_corregir sin guardar la regla: no crea corrección'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', null, false);
select count(*) as sin_regla_deberia_ser_0 from despachos.clasificacion_correccion where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '44. reclasificar deja historia: la clasificación anterior sigue ahí (no hay update silencioso)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', null, false);
select count(*) as historia_deberia_ser_3 from despachos.invoice_classification where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '45. invoice_categoria_corregir: readonly NO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c3', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', null, false) as should_fail;
rollback;

\echo '46. invoice_categoria_corregir: admin de B NO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', null, false) as should_fail;
rollback;

\echo '47. invoice_categoria_corregir: categoría inventada -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'inventada', null, false) as should_fail;
rollback;

\echo '48. invoice_categoria_corregir: CFDI de otra property -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d11', 'seguros', null, false) as should_fail;
rollback;

\echo '49. invoice_categoria_corregir: anon NO'
begin;
set local role anon;
select despachos.invoice_categoria_corregir('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'seguros', null, false) as should_fail;
rollback;

\echo '=== rechazo de una revisión marca el CFDI ==='

\echo '50. rechazar la revisión marca excluido_por_revision en su CFDI'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
update despachos.invoice_review set status = 'rechazado', resolved_by = '00000000-0000-0000-0000-0000000d26c1', resolved_at = now() where id = '00000000-0000-0000-0000-0000000d26f3' and status = 'pendiente';
select (select excluido_por_revision from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d05')::int as rechazo_marca_deberia_ser_1;
rollback;

\echo '51. aprobar NO marca (control)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
update despachos.invoice_review set status = 'aprobado', resolved_by = '00000000-0000-0000-0000-0000000d26c1', resolved_at = now() where id = '00000000-0000-0000-0000-0000000d26f1' and status = 'pendiente';
select (not (select excluido_por_revision from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d02'))::int as aprobar_no_marca_deberia_ser_1;
rollback;

\echo '52. un CFDI sin revisión rechazada sigue sin marca'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (not excluido_por_revision)::int as sin_marca_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '53. el default de la columna es falso para un CFDI nuevo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (not excluido_por_revision)::int as default_falso_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d08';
rollback;

\echo '54. el staff no puede escribir la marca directamente (sin UPDATE sobre invoice)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
update despachos.invoice set excluido_por_revision = true where id = '00000000-0000-0000-0000-000000d26d01' returning 1 as should_fail;
rollback;

\echo '55. la función del trigger no es ejecutable por authenticated ni anon'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (not has_function_privilege('authenticated', 'despachos.invoice_review_marcar_exclusion()', 'execute') and not has_function_privilege('anon', 'despachos.invoice_review_marcar_exclusion()', 'execute'))::int as trigger_sin_execute_deberia_ser_1;
rollback;

\echo '=== UUID único por cliente ==='


\echo '56. el mismo UUID en dos properties de la MISMA organización se permite'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-000000d26e01', 'I', 'PPP010101PP1', 'RRR010101RR1', 100, 116, true, '2026-07-10');
select count(*) as mismo_uuid_dos_clientes_deberia_ser_2 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e01';
rollback;

\echo '57. el mismo UUID en la MISMA property se rechaza (23505)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26e01', 'I', 'PPP010101PP1', 'RRR010101RR1', 100, 116, true, '2026-07-10') returning 1 as should_fail;
rollback;

\echo '58. la llave vieja (organization_id, folio_fiscal) ya no existe y la nueva sí'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select ((select count(*) from pg_constraint where conname = 'invoice_organization_id_folio_fiscal_key' and conrelid = 'despachos.invoice'::regclass) = 0 and (select count(*) from pg_constraint where conname = 'invoice_property_folio_fiscal_uk' and conrelid = 'despachos.invoice'::regclass) = 1)::int as llaves_deberia_ser_1;
rollback;

\echo '59. el UUID de OTRA organización tampoco choca (control)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
reset role;
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values ('00000000-0000-0000-0000-0000000d26a2', '00000000-0000-0000-0000-0000000d26b3', '00000000-0000-0000-0000-000000d26e01', 'I', 'PPP010101PP1', 'RRR010101RR1', 100, 116, true, '2026-07-10');
select count(*) as uuid_otra_org_deberia_ser_2 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e01';
rollback;

\echo '=== configuración por cliente ==='

\echo '60. el admin fija el umbral de confianza en 0.5 (el piso) y en 1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 0.5) on conflict (property_id) do update set clasificacion_umbral_confianza = excluded.clasificacion_umbral_confianza;
update despachos.property_config set clasificacion_umbral_confianza = 1 where property_id = '00000000-0000-0000-0000-0000000d26b1';
select (clasificacion_umbral_confianza = 1)::int as umbral_uno_deberia_ser_1 from despachos.property_config where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '61. umbral bajo el piso (0.4) -> error del CHECK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 0.4) returning 1 as should_fail;
rollback;

\echo '62. umbral mayor que 1 -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 1.2) returning 1 as should_fail;
rollback;

\echo '63. por omisión: umbral 0.7 y autoaceptado encendido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
insert into despachos.property_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1');
select (clasificacion_umbral_confianza = 0.7 and portal_autoaceptar_validos)::int as defaults_deberia_ser_1 from despachos.property_config where property_id = '00000000-0000-0000-0000-0000000d26b1';
rollback;

\echo '64. el contador NO cambia la configuración (RLS: 0 filas afectadas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
reset role;
insert into despachos.property_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
with u as (update despachos.property_config set portal_autoaceptar_validos = false where property_id = '00000000-0000-0000-0000-0000000d26b1' returning 1) select count(*) as contador_no_cambia_deberia_ser_0 from u;
rollback;

\echo '65. el admin de B NO cambia la configuración de A (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
reset role;
insert into despachos.property_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
with u as (update despachos.property_config set portal_autoaceptar_validos = false where property_id = '00000000-0000-0000-0000-0000000d26b1' returning 1) select count(*) as admin_b_no_cambia_deberia_ser_0 from u;
rollback;

\echo '=== dirección de los CFDI indeterminados ==='

\echo '66. con ficha: el indeterminado cuyo emisor es el RFC de la ficha pasa a emitido; el ajeno sigue indeterminado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1');
select (select direccion from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d09') = 'emitido' and (select direccion from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d10') = 'indeterminado' as ok \gset
select (:'ok'::boolean)::int as direccion_deberia_ser_1;
rollback;

\echo '67. devuelve cuántos cambió y no toca los que ya tenían sentido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1') = 1)::int as cambiados_deberia_ser_1;
rollback;

\echo '68. los ya clasificados (recibido) no cambian'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1');
select (direccion = 'recibido')::int as recibido_intacto_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '69. sin ficha (A2) devuelve 0'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b2') as sin_ficha_deberia_ser_0;
rollback;

\echo '70. es idempotente: la segunda corrida cambia 0'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1');
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1') as segunda_deberia_ser_0;
rollback;

\echo '71. readonly NO recalcula'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c3', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1') as should_fail;
rollback;

\echo '72. admin de B NO recalcula la dirección de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c4', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1') as should_fail;
rollback;

\echo '73. anon NO tiene EXECUTE'
begin;
set local role anon;
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b1') as should_fail;
rollback;

\echo '74. el contador de A1 NO recalcula en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c2', true);
select despachos.invoice_direccion_recalcular('00000000-0000-0000-0000-0000000d26b2') as should_fail;
rollback;

\echo '=== pólizas del periodo (sistema) ==='

\echo '75. candidatos: d01, d08 (clasificados con 0.80) y d15 (corregido por una persona); el resto queda fuera'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as candidatos_deberia_ser_3 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100);
rollback;

\echo '76. el candidato es d01 y trae su última clasificación (servicios_profesionales)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as candidato_d01_deberia_ser_1 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01' and out_categoria = 'servicios_profesionales' and out_property_id = '00000000-0000-0000-0000-0000000d26b1' and out_total_centavos = 116000;
rollback;

\echo '77. NO son candidatos: cancelado, excluido, con revisión pendiente, sin clasificar, tipo E, periodo cerrado, ya contabilizado, indeterminado, otra property sin clasificar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as no_candidatos_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id in ('00000000-0000-0000-0000-000000d26d02', '00000000-0000-0000-0000-000000d26d03', '00000000-0000-0000-0000-000000d26d04', '00000000-0000-0000-0000-000000d26d05', '00000000-0000-0000-0000-000000d26d06', '00000000-0000-0000-0000-000000d26d07', '00000000-0000-0000-0000-000000d26d09', '00000000-0000-0000-0000-000000d26d10', '00000000-0000-0000-0000-000000d26d11', '00000000-0000-0000-0000-000000d26d12', '00000000-0000-0000-0000-000000d26d13', '00000000-0000-0000-0000-000000d26d14', '00000000-0000-0000-0000-000000d26d16');
rollback;

\echo '78. un CFDI con póliza vigente deja de ser candidato (d08 con póliza) y uno reversado vuelve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.libro_poliza (organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, invoice_id, total_centavos) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 2026, 7, 'egreso', 1, '2026-07-16', 'x', 'cfdi', '00000000-0000-0000-0000-000000d26d08', 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as con_poliza_fuera_deberia_ser_2 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100);
rollback;

\echo '78b. el umbral del cliente cuenta: con umbral 0.6 el CFDI con 0.65 pasa a candidato; el de 0.30 y el empate siguen fuera'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 0.6);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as umbral_cliente_deberia_ser_1 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d14';
rollback;

\echo '78c. con el umbral por omisión (0.7) el CFDI con 0.65 NO es candidato, y el de 0.30 ('otros') ni el empate tampoco'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as dudosos_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id in ('00000000-0000-0000-0000-000000d26d13', '00000000-0000-0000-0000-000000d26d14', '00000000-0000-0000-0000-000000d26d16');
rollback;

\echo '78d. una clasificación hecha por una persona (manual) es candidato aunque el umbral sea 1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza) values ('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-0000000d26a1', 1);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as manual_con_umbral_uno_deberia_ser_1 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d15';
rollback;

\echo '78e. no es candidato un CFDI en moneda extranjera'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.invoice set moneda = 'USD' where id = '00000000-0000-0000-0000-000000d26d01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as usd_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '78f. no es candidato un CFDI con retención de ISR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.invoice set isr_retenido_centavos = 100 where id = '00000000-0000-0000-0000-000000d26d01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as retencion_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '78g. no es candidato un CFDI con IEPS'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.invoice set ieps_centavos = 100 where id = '00000000-0000-0000-0000-000000d26d01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ieps_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '78h. no es candidato un CFDI cuyo total no es base + IVA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.invoice set total_centavos = 116001 where id = '00000000-0000-0000-0000-000000d26d01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as total_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '78i. no es candidato un CFDI sin montos en centavos (anterior a D-22)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.invoice set subtotal_centavos = null where id = '00000000-0000-0000-0000-000000d26d01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sincentavos_fuera_deberia_ser_0 from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '78j. un recibido clasificado como venta (categoría sin cuenta de gasto) NO es candidato; un emitido sí aunque la categoría sea de venta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method) values ('00000000-0000-0000-0000-000000d26d01', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'venta_servicios', 0.9, 'reglas');
update despachos.invoice set direccion = 'emitido' where id = '00000000-0000-0000-0000-000000d26d08';
insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method) values ('00000000-0000-0000-0000-000000d26d08', '00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'venta_servicios', 0.9, 'reglas');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d01') * 10 + (select count(*) from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) where out_invoice_id = '00000000-0000-0000-0000-000000d26d08') as venta_recibido_fuera_emitido_dentro_deberia_ser_1;
rollback;

\echo '79. el staff autenticado NO puede listar candidatos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select * from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) as should_fail;
rollback;

\echo '80. anon NO tiene EXECUTE'
begin;
set local role anon;
select * from despachos.system_polizas_periodo_candidatos('2026-05-01', '2026-07-31', 100) as should_fail;
rollback;

\echo '81. ventana inválida (hasta < desde) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_polizas_periodo_candidatos('2026-07-31', '2026-07-01', 10) as should_fail;
rollback;

\echo '82. límite inválido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_polizas_periodo_candidatos('2026-07-01', '2026-07-31', 0) as should_fail;
rollback;

\echo '83. ventana de más de 400 días -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_polizas_periodo_candidatos('2024-01-01', '2026-07-31', 10) as should_fail;
rollback;

\echo '84. registrar crea la póliza (estado creada, folio 1) con actor NULL (sistema) y origen cfdi'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado, out_folio from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
reset role;
select (count(*) = 1 and bool_and(creado_por is null and origen = 'cfdi' and folio = 1 and total_centavos = 116000))::int as poliza_sistema_deberia_ser_1 from despachos.libro_poliza where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '85. registrar es idempotente: la segunda vez dice ya_tenia_poliza y no duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
select (out_estado = 'ya_tenia_poliza')::int as idempotente_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
reset role;
select count(*) as una_sola_deberia_ser_1 from despachos.libro_poliza where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '86. periodo cerrado -> periodo_cerrado y nada escrito'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'periodo_cerrado')::int as cerrado_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d07', 'egreso', '2026-05-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
reset role;
select count(*) as nada_escrito_deberia_ser_0 from despachos.libro_poliza where invoice_id = '00000000-0000-0000-0000-000000d26d07';
rollback;

\echo '87. cancelado -> cancelado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'cancelado')::int as cancelado_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d03', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
rollback;

\echo '88. excluido por revisión -> excluido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'excluido')::int as excluido_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d04', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
rollback;

\echo '89. con revisión pendiente -> revision_pendiente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'revision_pendiente')::int as pendiente_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d02', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
rollback;

\echo '90. póliza descuadrada -> error 22023'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","debe":100,"haber":0},{"cuenta":"2010000","debe":0,"haber":99}]'::jsonb, null) as should_fail;
rollback;

\echo '91. cuenta fuera del catálogo del cliente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"9999999","debe":100,"haber":0},{"cuenta":"2010000","debe":0,"haber":100}]'::jsonb, null) as should_fail;
rollback;

\echo '92. sin catálogo y sin catálogo base -> sin_catalogo (A2 no tiene cuentas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'sin_catalogo')::int as sin_catalogo_deberia_ser_1 from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-000000d26d11', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null);
rollback;

\echo '93. sin catálogo pero con catálogo base: lo siembra y crea la póliza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b2', '00000000-0000-0000-0000-000000d26d11', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, '[{"codigo":"6020100","descripcion":"Servicios profesionales","naturaleza":"D"},{"codigo":"2600300","descripcion":"IVA acreditable","naturaleza":"D"},{"codigo":"2010000","descripcion":"Proveedores","naturaleza":"A"}]'::jsonb);
reset role;
select (select count(*) from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-0000000d26b2') = 3 and (select count(*) from despachos.libro_poliza where invoice_id = '00000000-0000-0000-0000-000000d26d11') = 1 as ok \gset
select (:'ok'::boolean)::int as siembra_y_poliza_deberia_ser_1;
rollback;

\echo '94. CFDI de otra property (property de A, CFDI de B) -> error P0002'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d12', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null) as should_fail;
rollback;

\echo '95. el staff autenticado NO puede registrar por la vía de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select * from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null) as should_fail;
rollback;

\echo '96. anon NO tiene EXECUTE'
begin;
set local role anon;
select * from despachos.system_poliza_cfdi_registrar('00000000-0000-0000-0000-0000000d26b1', '00000000-0000-0000-0000-000000d26d01', 'egreso', '2026-07-10', 'CFDI prueba', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null) as should_fail;
rollback;

\echo '97. el núcleo libro_poliza_insertar_nucleo no es ejecutable por nadie (staff, anon)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (not has_function_privilege('authenticated', 'despachos.libro_poliza_insertar_nucleo(uuid, uuid, text, date, text, text, uuid, uuid, jsonb, uuid)', 'execute') and not has_function_privilege('anon', 'despachos.libro_poliza_insertar_nucleo(uuid, uuid, text, date, text, text, uuid, uuid, jsonb, uuid)', 'execute') and not has_function_privilege('authenticated', 'despachos.libro_poliza_insertar(uuid, uuid, text, date, text, text, uuid, uuid, jsonb)', 'execute'))::int as nucleo_sin_execute_deberia_ser_1;
rollback;

\echo '98. regresión: la vía de staff (libro_poliza_registrar) sigue creando pólizas con el actor humano'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-0000000d26b1', 'egreso', '2026-07-10', 'manual', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, '00000000-0000-0000-0000-000000d26d01');
select (creado_por = '00000000-0000-0000-0000-0000000d26c1' and origen = 'cfdi')::int as poliza_staff_deberia_ser_1 from despachos.libro_poliza where invoice_id = '00000000-0000-0000-0000-000000d26d01';
rollback;

\echo '99. regresión: el staff sin permiso sigue sin poder (readonly)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c3', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-0000000d26b1', 'egreso', '2026-07-10', 'manual', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null) as should_fail;
rollback;

\echo '100. regresión: periodo cerrado sigue rechazando a staff (55000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-0000000d26b1', 'egreso', '2026-05-10', 'manual', '[{"cuenta":"6020100","concepto":"x","debe":100000,"haber":0},{"cuenta":"2600300","concepto":"IVA","debe":16000,"haber":0},{"cuenta":"2010000","concepto":"x","debe":0,"haber":116000}]'::jsonb, null) as should_fail;
rollback;

\echo '=== portal: CFDI del cliente y autoaceptado ==='

\echo '101. el cliente (token de A1) ve los 14 CFDI de A1 (sin los de A2 ni B1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length((despachos.portal_cliente_cfdi_listar(repeat('a', 64)))->'cfdi') as cfdi_a1_deberia_ser_14;
rollback;

\echo '102. NO ve CFDI de otra property: ninguno de A2 ni de B1 aparece'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ajenos_deberia_ser_0 from jsonb_array_elements((despachos.portal_cliente_cfdi_listar(repeat('a', 64)))->'cfdi') x where x->>'id' in ('00000000-0000-0000-0000-000000d26d11', '00000000-0000-0000-0000-000000d26d12');
rollback;

\echo '103. el token de A2 ve solo lo de A2 (1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length((despachos.portal_cliente_cfdi_listar(repeat('b', 64)))->'cfdi') as cfdi_a2_deberia_ser_1;
rollback;

\echo '103b. el listado trae la organizacion y la property del enlace (para la bitacora)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (r->>'organization_id' = '00000000-0000-0000-0000-0000000d26a1' and r->>'property_id' = '00000000-0000-0000-0000-0000000d26b1')::int as ids_bitacora_deberia_ser_1 from despachos.portal_cliente_cfdi_listar(repeat('a', 64)) r;
rollback;

\echo '104. token expirado -> error genérico'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_cfdi_listar(repeat('c', 64)) as should_fail;
rollback;

\echo '105. token inexistente -> error genérico'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_cfdi_listar(repeat('f', 64)) as should_fail;
rollback;

\echo '106. token con forma inválida -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_cfdi_listar('xyz') as should_fail;
rollback;

\echo '107. un staff autenticado NO usa la vía del portal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.portal_cliente_cfdi_listar(repeat('a', 64)) as should_fail;
rollback;

\echo '108. anon NO tiene EXECUTE'
begin;
set local role anon;
select despachos.portal_cliente_cfdi_listar(repeat('a', 64)) as should_fail;
rollback;

\echo '109. el listado no expone contenido ni campos internos (solo las llaves esperadas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from jsonb_object_keys((despachos.portal_cliente_cfdi_listar(repeat('a', 64)))->'cfdi'->0)) as llaves_deberia_ser_11;
rollback;

\echo '110. contexto: property y organización del documento, bandera por omisión encendida y umbral 0.7'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (c->>'property_id' = '00000000-0000-0000-0000-0000000d26b1' and c->>'organization_id' = '00000000-0000-0000-0000-0000000d26a1' and (c->>'autoaceptar')::boolean and (c->>'umbral')::numeric = 0.7 and c->>'ficha_rfc' = 'CCC010101CC1')::int as contexto_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', 'PPP010101PP1') c;
rollback;

\echo '111. contexto: existe=true cuando el UUID ya está en la property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((c->>'existe')::boolean)::int as existe_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e01', '2026-07-10', 'PPP010101PP1') c;
rollback;

\echo '112. contexto: periodo cerrado detectado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((c->>'periodo_cerrado')::boolean)::int as cerrado_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-05-20', 'PPP010101PP1') c;
rollback;

\echo '113. contexto: bandera apagada en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((c->>'autoaceptar')::boolean)::int + 1 as bandera_apagada_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa05', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', 'PPP010101PP1') c;
rollback;

\echo '114. contexto: la situación EFOS del emisor sale de la lista vigente (presunto)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.efos_ingesta (periodo, fuente_sha256, filas) values ('2026-07', repeat('e', 64), 1);
insert into despachos.efos_contribuyente (periodo, rfc, nombre, situacion) values ('2026-07', 'EFO010101EF1', 'x', 'presunto');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (c->>'efos_situacion' = 'presunto' and (c->>'efos_lista_disponible')::boolean)::int as efos_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', 'EFO010101EF1') c;
rollback;

\echo '115. contexto: las correcciones del emisor viajan (solo las de esa property y ese RFC)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, categoria) values ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'PPP010101PP1', 'publicidad'), ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b2', 'PPP010101PP1', 'seguros'), ('00000000-0000-0000-0000-0000000d26a1', '00000000-0000-0000-0000-0000000d26b1', 'OTR010101OT1', 'seguros');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(c->'correcciones') as correcciones_deberia_ser_1 from despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', 'PPP010101PP1') c;
rollback;

\echo '116. contexto: documento inexistente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aaff', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', null) as should_fail;
rollback;

\echo '117. contexto: un staff autenticado NO lo usa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', null) as should_fail;
rollback;

\echo '118. contexto: anon NO tiene EXECUTE'
begin;
set local role anon;
select despachos.system_portal_ingesta_contexto('00000000-0000-0000-0000-00000d26aa01', '00000000-0000-0000-0000-000000d26e99', '2026-07-10', null) as should_fail;
rollback;

\echo '119. aceptar: crea el CFDI en la property del documento, con su desglose, su clasificación y marca el documento aceptado por el sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
reset role;
select (select count(*) from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e50' and property_id = '00000000-0000-0000-0000-0000000d26b1' and organization_id = '00000000-0000-0000-0000-0000000d26a1') = 1 and (select count(*) from despachos.invoice_impuesto where property_id = '00000000-0000-0000-0000-0000000d26b1' and importe_centavos = 16000) >= 1 and (select count(*) from despachos.invoice_classification c join despachos.invoice i on i.id = c.invoice_id where i.folio_fiscal = '00000000-0000-0000-0000-000000d26e50' and c.method = 'reglas' and c.classified_by is null) = 1 and (select estado = 'aceptado' and resuelto_por is null and resuelto_en is not null and invoice_id is not null from despachos.portal_cliente_documento where id = '00000000-0000-0000-0000-00000d26aa01') as ok \gset
select (:'ok'::boolean)::int as aceptar_deberia_ser_1;
rollback;

\echo '120. aceptar: el sentido (direccion) lo calcula la base con la ficha: recibido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
reset role;
select (direccion = 'recibido')::int as direccion_deberia_ser_1 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e50';
rollback;

\echo '121. aceptar: segunda llamada sobre el mismo documento -> no_aplica (ya no está recibido) y no duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
select (out_estado = 'no_aplica')::int as segunda_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
select count(*) as un_solo_cfdi_deberia_ser_1 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e50';
rollback;

\echo '122. aceptar: UUID ya existente en esa property -> ya_existia, el documento queda aceptado con la factura existente y no se duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'ya_existia' and out_invoice_id = '00000000-0000-0000-0000-000000d26d01')::int as ya_existia_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa02', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e01","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
select (estado = 'aceptado' and invoice_id = '00000000-0000-0000-0000-000000d26d01' and resuelto_por is null)::int as doc_aceptado_deberia_ser_1 from despachos.portal_cliente_documento where id = '00000000-0000-0000-0000-00000d26aa02';
select count(*) as sin_duplicar_deberia_ser_1 from despachos.invoice where property_id = '00000000-0000-0000-0000-0000000d26b1' and folio_fiscal = '00000000-0000-0000-0000-000000d26e01';
rollback;

\echo '123. aceptar: un UUID que existe en OTRA property del despacho SÍ se ingiere (A2 tiene el suyo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'aceptado')::int as otra_property_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e11","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
rollback;

\echo '124. aceptar: periodo cerrado -> periodo_cerrado, nada escrito, el documento sigue recibido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'periodo_cerrado')::int as cerrado_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa04', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-05-20","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
select (estado = 'recibido')::int as sigue_recibido_deberia_ser_1 from despachos.portal_cliente_documento where id = '00000000-0000-0000-0000-00000d26aa04';
select count(*) as nada_deberia_ser_0 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e50';
rollback;

\echo '125. aceptar: bandera apagada en A2 -> autoaceptar_apagado y nada escrito'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'autoaceptar_apagado')::int as apagado_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa05', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"DDD010101DD1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
select count(*) as nada_deberia_ser_0 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e50';
rollback;

\echo '126. aceptar: un documento que no es XML de CFDI -> no_aplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'no_aplica')::int as pdf_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa03', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb);
rollback;

\echo '127. aceptar: el llamador no elige la property: aunque el JSON diga otra, el CFDI queda en la del documento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_estado from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', ('{"folio_fiscal":"00000000-0000-0000-0000-000000d26e51","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb || jsonb_build_object('property_id', '00000000-0000-0000-0000-0000000d26b3', 'organization_id', '00000000-0000-0000-0000-0000000d26a2')), '[]'::jsonb, null);
reset role;
select (property_id = '00000000-0000-0000-0000-0000000d26b1' and organization_id = '00000000-0000-0000-0000-0000000d26a1')::int as property_del_documento_deberia_ser_1 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d26e51';
rollback;

\echo '128. aceptar: sin clasificación ni desglose también funciona'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'aceptado')::int as sin_clasif_deberia_ser_1 from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa06', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e52","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, null, null);
rollback;

\echo '129. aceptar: clasificación con categoría inventada -> error y no queda nada (atómico)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"inventada","confianza":0.8,"method":"reglas"}'::jsonb) as should_fail;
rollback;

\echo '130. aceptar: JSON sin folio_fiscal -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"tipo":"I"}'::jsonb, null, null) as should_fail;
rollback;

\echo '131. aceptar: un staff autenticado NO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select * from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb) as should_fail;
rollback;

\echo '132. aceptar: anon NO tiene EXECUTE'
begin;
set local role anon;
select * from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aa01', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb) as should_fail;
rollback;

\echo '133. aceptar: documento inexistente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_cfdi_aceptar('00000000-0000-0000-0000-00000d26aaff', '{"folio_fiscal":"00000000-0000-0000-0000-000000d26e50","tipo":"I","rfc_emisor":"PPP010101PP1","rfc_receptor":"CCC010101CC1","emisor_nombre":"Prov","subtotal":1000,"total":1160,"iva":160,"descuento":0,"valido":true,"issues":[],"warnings":[],"requires_human_review":false,"fecha":"2026-07-22","metodo_pago":"PUE","forma_pago":"03","uso_cfdi":"G03","moneda":"MXN","subtotal_centavos":100000,"descuento_centavos":0,"total_centavos":116000,"iva_trasladado_centavos":16000}'::jsonb, '[{"naturaleza":"traslado","impuesto":"002","tipo_factor":"Tasa","tasa_o_cuota":0.16,"base_centavos":100000,"importe_centavos":16000}]'::jsonb, '{"categoria":"servicios_profesionales","confianza":0.8,"method":"reglas","razon":"Coincidencias: honorarios","empate":false}'::jsonb) as should_fail;
rollback;

\echo '=== postura de catálogo ==='

\echo '134. ninguna función nueva es ejecutable por anon'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as anon_sin_execute_deberia_ser_0 from pg_proc p where p.pronamespace = 'despachos'::regnamespace and p.proname in ('invoice_clasificar','invoice_categoria_corregir','clasificacion_correccion_guardar','clasificacion_correccion_eliminar','invoice_direccion_recalcular','system_polizas_periodo_candidatos','system_poliza_cfdi_registrar','portal_cliente_cfdi_listar','system_portal_ingesta_contexto','system_portal_cfdi_aceptar','libro_poliza_insertar_nucleo','libro_poliza_insertar','invoice_review_marcar_exclusion') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '135. toda función nueva es security definer con search_path fijo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as definer_deberia_ser_0 from pg_proc p where p.pronamespace = 'despachos'::regnamespace and p.proname in ('invoice_clasificar','invoice_categoria_corregir','clasificacion_correccion_guardar','clasificacion_correccion_eliminar','invoice_direccion_recalcular','system_polizas_periodo_candidatos','system_poliza_cfdi_registrar','portal_cliente_cfdi_listar','system_portal_ingesta_contexto','system_portal_cfdi_aceptar','libro_poliza_insertar_nucleo','libro_poliza_insertar','invoice_review_marcar_exclusion') and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

\echo '136. PUBLIC no tiene EXECUTE en ninguna (revoke from public)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as public_sin_execute_deberia_ser_0 from pg_proc p where p.pronamespace = 'despachos'::regnamespace and p.proname in ('invoice_clasificar','invoice_categoria_corregir','clasificacion_correccion_guardar','clasificacion_correccion_eliminar','invoice_direccion_recalcular','system_polizas_periodo_candidatos','system_poliza_cfdi_registrar','portal_cliente_cfdi_listar','system_portal_ingesta_contexto','system_portal_cfdi_aceptar','libro_poliza_insertar_nucleo','libro_poliza_insertar','invoice_review_marcar_exclusion') and has_function_privilege('public', p.oid, 'execute');
rollback;

\echo '137. anon no tiene privilegios sobre las tablas nuevas ni sobre la clasificación'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as anon_tablas_deberia_ser_0 from (values ('despachos.clasificacion_correccion'), ('despachos.invoice_classification')) t(n) where has_table_privilege('anon', t.n, 'select, insert, update, delete');
rollback;

\echo '138. authenticated solo lee las tablas de clasificación (sin insert/update/delete directos)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select count(*) as authenticated_escritura_deberia_ser_0 from (values ('despachos.clasificacion_correccion'), ('despachos.invoice_classification')) t(n) where has_table_privilege('authenticated', t.n, 'insert, update, delete');
rollback;

\echo '139. RLS habilitado en la tabla nueva'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (relrowsecurity)::int as rls_deberia_ser_1 from pg_class where oid = 'despachos.clasificacion_correccion'::regclass;
rollback;

\echo '140. el CHECK de categoría de invoice_classification incluye las 18 categorías finas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d26c1', true);
select (pg_get_constraintdef(oid) like '%servicios_profesionales%' and pg_get_constraintdef(oid) like '%venta_mercancia%' and pg_get_constraintdef(oid) like '%otros%' and pg_get_constraintdef(oid) like '%sin_clasificar%')::int as check_categoria_deberia_ser_1 from pg_constraint where conname = 'invoice_classification_categoria_check';
rollback;

\echo 'FIN: los escenarios con should_fail deben terminar en ERROR; los demas devuelven el valor *_deberia_ser_N'
