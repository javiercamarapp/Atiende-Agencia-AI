-- paridad3 D-31 + D-P3-19 + D-P3-15 + D-P3-21 -- verificacion contra Postgres REAL de la migracion 027 (estatus SAT a escala, automatizacion por
-- cliente, solicitudes de documentos, estado de modulos del cierre, cierre forzado y entrega de reportes).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor
-- esperado (ver run-gate.mjs). Sistema = rol authenticated con `sub` vacio. Staff = rol authenticated con `sub` del usuario.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-00000000f001', 'despachos', 'Despacho A piloto', 'despacho-a-piloto', 'active'),
  ('00000000-0000-0000-0000-00000000f002', 'despachos', 'Despacho B piloto', 'despacho-b-piloto', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000f002', 'despachos', 'Cliente B1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000fb01', 'admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-00000000fb02', 'admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-00000000fb03', 'contador-a@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-00000000fb04', 'auditor-a@example.com', 'Auditor A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-00000000fb02', '00000000-0000-0000-0000-00000000f002', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-00000000fb03', '00000000-0000-0000-0000-00000000f001', null, 'member', 'contador'),
  ('00000000-0000-0000-0000-00000000fb04', '00000000-0000-0000-0000-00000000f001', null, 'viewer', 'auditor')
on conflict do nothing;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal, responsable_id) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'CCC010101CC1', 'Cliente A1 SA', array['601'], '06000', '00000000-0000-0000-0000-00000000fb03'),
  ('00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000f002', 'DDD010101DD1', 'Cliente B1 SA', array['612'], '06000', null)
on conflict do nothing;

-- Facturas del cliente A1. dc01 nunca consultada (reciente), dc02 vigente consultada hace 1 h, dc03 cancelada, dc04 'En proceso' consultada hace 1 h,
-- dc05 'En proceso' consultada hace 30 h, dc06 vigente de 2020 consultada hace 30 dias (fuera de la ventana), dc07 de 2020 NUNCA consultada.
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, estado_sat, estado_sat_intentado_en, estatus_cancelacion) values
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe01', 'I', 'AAA010101AA1', 'CCC010101CC1', 100, 116, true, current_date - 5, 'pendiente', null, null),
  ('00000000-0000-0000-0000-00000000fc02', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe02', 'I', 'BBB020202BB2', 'CCC010101CC1', 200, 232, true, current_date - 200, 'vigente', now() - interval '1 hour', null),
  ('00000000-0000-0000-0000-00000000fc03', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe03', 'E', 'ZZZ999999ZZ9', 'CCC010101CC1', 300, 348, true, current_date - 6, 'cancelado', null, null),
  ('00000000-0000-0000-0000-00000000fc04', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe04', 'I', 'AAA010101AA1', 'CCC010101CC1', 400, 464, true, current_date - 7, 'vigente', now() - interval '1 hour', 'En proceso'),
  ('00000000-0000-0000-0000-00000000fc05', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe05', 'I', 'AAA010101AA1', 'CCC010101CC1', 500, 580, true, current_date - 8, 'vigente', now() - interval '30 hours', 'En proceso'),
  ('00000000-0000-0000-0000-00000000fc06', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe06', 'I', 'AAA010101AA1', 'CCC010101CC1', 600, 696, true, '2020-03-10', 'vigente', now() - interval '30 days', null),
  ('00000000-0000-0000-0000-00000000fc07', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe07', 'I', 'AAA010101AA1', 'CCC010101CC1', 700, 812, true, '2020-03-11', 'pendiente', null, null),
  ('00000000-0000-0000-0000-00000000fc08', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000fe08', 'I', 'AAA010101AA1', 'DDD010101DD1', 800, 928, true, current_date - 3, 'pendiente', null, null)
on conflict do nothing;
update despachos.invoice set property_id = '00000000-0000-0000-0000-00000000fa02', organization_id = '00000000-0000-0000-0000-00000000f002' where id = '00000000-0000-0000-0000-00000000fc08';

\echo '=== D-P3-19: barrido SAT priorizado ==='

\echo '1. sistema: el barrido (ventana 2 ejercicios, 20 por cliente) trae nunca consultados y En proceso vencida; NO trae al cancelado, al consultado hace 1 h ni al de 2020 ya consultado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as barrido_deberia_ser_4 from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 2, 20);
rollback;

\echo '2. el orden es por prioridad: primero los nunca consultados (prio 0), despues la cancelacion En proceso (prio 1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (array_agg(out_prioridad order by out_prioridad))[4]::int as cuarta_prioridad_deberia_ser_1 from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 2, 20);
rollback;

\echo '3. el tope por cliente se respeta (1 por cliente: A1 y B1 -> 2 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as tope_por_cliente_deberia_ser_2 from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 2, 1);
rollback;

\echo '4. el tope global se respeta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as tope_global_deberia_ser_1 from despachos.system_cfdi_pendientes_estatus_sat(1, 6, 2, 20);
rollback;

\echo '5. staff autenticado NO puede ejecutar el barrido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 2, 20) as should_fail;
rollback;

\echo '6. anon NO tiene EXECUTE sobre el barrido'
begin;
set local role anon;
select * from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 2, 20) as should_fail;
rollback;

\echo '7. ventana invalida -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_pendientes_estatus_sat(100, 6, 9, 20) as should_fail;
rollback;

\echo '8. registrar vigente con detalle persiste las 4 columnas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable con aceptación', 'En proceso', 'S - Comprobante obtenido satisfactoriamente.', 'No se encontró');
reset role;
select count(*) as detalle_persistido_deberia_ser_1 from despachos.invoice
  where id = '00000000-0000-0000-0000-00000000fc01' and es_cancelable = 'Cancelable con aceptación' and estatus_cancelacion = 'En proceso' and codigo_estatus like 'S - %' and validacion_efos = 'No se encontró' and estado_sat = 'vigente';
rollback;

\echo '9. la primera vez que aparece En proceso avisa (true); la segunda no (dedupe)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable con aceptación', 'En proceso', null, null);
select out_cancelacion_en_proceso_nueva::int as segunda_vez_deberia_ser_0 from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable con aceptación', 'En proceso', null, null);
rollback;

\echo '10. primera vez En proceso -> true'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_cancelacion_en_proceso_nueva::int as primera_vez_deberia_ser_1 from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable con aceptación', 'En proceso', null, null);
rollback;

\echo '11. pendiente solo anota el intento: NO pisa el estado ni el detalle ya verificados'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc04', 'pendiente', null, null, null, null);
reset role;
select count(*) as detalle_intacto_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000fc04' and estado_sat = 'vigente' and estatus_cancelacion = 'En proceso';
rollback;

\echo '12. cancelado es terminal: una consulta posterior no lo regresa a vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc03', 'vigente', null, null, null, null);
reset role;
select count(*) as sigue_cancelado_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000fc03' and estado_sat = 'cancelado';
rollback;

\echo '13. al pasar a cancelado se reporta el cambio (true) y deja de entrar al barrido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_cambio_a_cancelado::int as cambio_deberia_ser_1 from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'cancelado', 'No cancelable', 'Cancelado sin aceptación', null, null);
rollback;

\echo '14. estado invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'otro', null, null, null, null) as should_fail;
rollback;

\echo '15. staff autenticado NO puede registrar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000fc01', 'vigente', null, null, null, null) as should_fail;
rollback;

\echo '15b. staff (contador) verifica a mano un CFDI y queda el detalle de cancelacion; la primera vez avisa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select out_cancelacion_en_proceso_nueva::int as aviso_deberia_ser_1 from despachos.invoice_estado_sat_detalle_registrar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable con aceptación', 'En proceso', 'S - ok', '200');
rollback;

\echo '15c. verificacion manual: cross-tenant (admin de otro despacho) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select * from despachos.invoice_estado_sat_detalle_registrar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc01', 'vigente', null, null, null, null) as should_fail;
rollback;

\echo '15d. verificacion manual: un auditor (solo lectura) NO puede'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb04', true);
select * from despachos.invoice_estado_sat_detalle_registrar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc01', 'vigente', null, null, null, null) as should_fail;
rollback;

\echo '15e. verificacion manual: un CFDI cancelado no cambia de estado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select * from despachos.invoice_estado_sat_detalle_registrar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc03', 'vigente', null, null, null, null) as should_fail;
rollback;

\echo '15f. verificacion manual: persiste el detalle (el staff lo lee de la factura)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select * from despachos.invoice_estado_sat_detalle_registrar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc01', 'vigente', 'Cancelable sin aceptación', 'En proceso', 'S - ok', '200');
select count(*) as detalle_visible_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000fc01' and es_cancelable = 'Cancelable sin aceptación' and validacion_efos = '200';
rollback;

\echo '=== D-P3-21 / D-31: automatizacion por cliente ==='

\echo '16. admin del despacho guarda correo, dia y plantilla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'Contacto@Cliente.com', true, true, 5, '{"nomina": true, "estados_cuenta": ["0123456789"]}'::jsonb);
select count(*) as guardado_deberia_ser_1 from despachos.cliente_automatizacion where property_id = '00000000-0000-0000-0000-00000000fa01' and contacto_correo = 'contacto@cliente.com' and envio_reportes_cierre and solicitud_dia = 5;
rollback;

\echo '17. un contador tambien puede (rol admin/contador)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'a@b.com', false, true, 1, '{}'::jsonb);
select count(*) as contador_guarda_deberia_ser_1 from despachos.cliente_automatizacion where property_id = '00000000-0000-0000-0000-00000000fa01';
rollback;

\echo '18. un auditor (solo lectura) NO puede guardar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb04', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'a@b.com', false, true, 1, '{}'::jsonb) as should_fail;
rollback;

\echo '19. cross-tenant: el admin de OTRO despacho no puede guardar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'a@b.com', false, true, 1, '{}'::jsonb) as should_fail;
rollback;

\echo '20. activar el envio sin correo de contacto -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', null, true, true, 1, '{}'::jsonb) as should_fail;
rollback;

\echo '21. plantilla con clave desconocida -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'a@b.com', false, true, 1, '{"otra": true}'::jsonb) as should_fail;
rollback;

\echo '22. correo invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'no-es-correo', false, true, 1, '{}'::jsonb) as should_fail;
rollback;

\echo '23. anon NO puede guardar'
begin;
set local role anon;
select despachos.cliente_automatizacion_guardar('00000000-0000-0000-0000-00000000fa01', 'a@b.com', false, true, 1, '{}'::jsonb) as should_fail;
rollback;

\echo '24. RLS: el staff de otro despacho no ve la automatizacion ajena'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select count(*) as filas_ajenas_deberia_ser_0 from despachos.cliente_automatizacion;
rollback;

\echo '25. sin escritura directa: el admin NO puede insertar en la tabla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com') returning 1 as should_fail;
rollback;

\echo '=== D-31: solicitudes de documentos ==='

\echo '26. el staff pide los documentos del periodo: plantilla por defecto = estado de cuenta + XML emitidos + XML recibidos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select count(*) as renglones_deberia_ser_3 from despachos.solicitud_documentos_renglon where property_id = '00000000-0000-0000-0000-00000000fa01';
rollback;

\echo '27. idempotente: la segunda llamada no crea otra (creada = false)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select out_creada::int as segunda_deberia_ser_0 from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '28. la plantilla del cliente se respeta: nomina activa y una cuenta propia = 4 renglones (cuenta, emitidos, recibidos, nomina)'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, plantilla) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', '{"nomina": true, "estados_cuenta": ["0123456789"]}');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select count(*) as renglones_plantilla_deberia_ser_4 from despachos.solicitud_documentos_renglon where property_id = '00000000-0000-0000-0000-00000000fa01';
rollback;

\echo '29. la etiqueta de la cuenta va enmascarada (no se publica la cuenta completa)'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, plantilla) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', '{"estados_cuenta": ["0123456789"]}');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select count(*) as etiqueta_enmascarada_deberia_ser_1 from despachos.solicitud_documentos_renglon where tipo = 'estado_cuenta' and etiqueta = 'Estado de cuenta ****6789';
rollback;

\echo '30. cross-tenant: el admin de otro despacho no puede pedir documentos de un cliente ajeno'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6) as should_fail;
rollback;

\echo '31. periodo invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 13) as should_fail;
rollback;

\echo '32. «no aplica» exige motivo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select despachos.solicitud_renglon_no_aplica('00000000-0000-0000-0000-00000000fa01', (select id from despachos.solicitud_documentos_renglon where clave = 'xml_emitidos'), 'x') as should_fail;
rollback;

\echo '33. «no aplica» con motivo marca el renglon'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select despachos.solicitud_renglon_no_aplica('00000000-0000-0000-0000-00000000fa01', (select id from despachos.solicitud_documentos_renglon where clave = 'xml_emitidos'), 'No emitio facturas este mes');
select count(*) as no_aplica_deberia_ser_1 from despachos.solicitud_documentos_renglon where clave = 'xml_emitidos' and estado = 'no_aplica' and motivo_no_aplica = 'No emitio facturas este mes';
rollback;

\echo '34. cuando todos los renglones estan recibidos o no aplican, la solicitud queda completa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select despachos.solicitud_renglon_no_aplica('00000000-0000-0000-0000-00000000fa01', r.id, 'Sin movimientos este mes') from despachos.solicitud_documentos_renglon r;
select count(*) as completa_deberia_ser_1 from despachos.solicitud_documentos where property_id = '00000000-0000-0000-0000-00000000fa01' and estado = 'completa' and completada_en is not null;
rollback;

\echo '35. reabrir un «no aplica» devuelve la solicitud a abierta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_documentos_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select despachos.solicitud_renglon_no_aplica('00000000-0000-0000-0000-00000000fa01', r.id, 'Sin movimientos este mes') from despachos.solicitud_documentos_renglon r;
select despachos.solicitud_renglon_reabrir('00000000-0000-0000-0000-00000000fa01', (select id from despachos.solicitud_documentos_renglon where clave = 'xml_recibidos'));
select count(*) as abierta_deberia_ser_1 from despachos.solicitud_documentos where property_id = '00000000-0000-0000-0000-00000000fa01' and estado = 'abierta' and completada_en is null;
rollback;

\echo '36. cross-tenant: el admin de otro despacho no ve los renglones ajenos (RLS)'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select count(*) as renglones_ajenos_deberia_ser_0 from despachos.solicitud_documentos_renglon;
rollback;

\echo '37. la funcion interna de creacion NO es ejecutable por staff'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6) as should_fail;
rollback;

\echo '38. portal: el cliente liga SU documento a un renglon; el staff lo acepta y el renglon queda recibido (trigger)'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000000fd01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000ff01', 'pdf', 'edo.pdf', 'application/pdf', 5, repeat('b', 64), '\x255044462d'::bytea);
select set_config('t.rid', (select id::text from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta'), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_solicitud_vincular(repeat('a', 64), '00000000-0000-0000-0000-00000000fd01', current_setting('t.rid')::uuid);
reset role;
update despachos.portal_cliente_documento set estado = 'aceptado', resuelto_en = now() where id = '00000000-0000-0000-0000-00000000fd01';
select count(*) as renglon_recibido_deberia_ser_1 from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta' and estado = 'recibido' and documento_id = '00000000-0000-0000-0000-00000000fd01';
rollback;

\echo '39. portal: vincular deja el renglon en revision mientras el staff no acepte'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000000fd01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000ff01', 'pdf', 'edo.pdf', 'application/pdf', 5, repeat('b', 64), '\x255044462d'::bytea);
select set_config('t.rid', (select id::text from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta'), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_solicitud_vincular(repeat('a', 64), '00000000-0000-0000-0000-00000000fd01', current_setting('t.rid')::uuid);
reset role;
select count(*) as fuera_de_revision_deberia_ser_0 from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta' and estado <> 'en_revision';
rollback;

\echo '40. portal: si el staff RECHAZA el documento el renglon vuelve a pendiente y se libera el documento'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000000fd01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000ff01', 'pdf', 'edo.pdf', 'application/pdf', 5, repeat('b', 64), '\x255044462d'::bytea);
select set_config('t.rid', (select id::text from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta'), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_solicitud_vincular(repeat('a', 64), '00000000-0000-0000-0000-00000000fd01', current_setting('t.rid')::uuid);
reset role;
update despachos.portal_cliente_documento set estado = 'rechazado', resuelto_en = now(), motivo = 'Ilegible' where id = '00000000-0000-0000-0000-00000000fd01';
select count(*) as renglon_libre_deberia_ser_1 from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta' and estado = 'pendiente' and documento_id is null;
rollback;

\echo '41. portal: un token invalido no vincula nada'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_solicitud_vincular(repeat('c', 64), '00000000-0000-0000-0000-00000000fd01', gen_random_uuid()) as should_fail;
rollback;

\echo '42. portal: no se puede ligar el documento de OTRO cliente (otro enlace/property) a un renglon propio'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days'),
  ('00000000-0000-0000-0000-00000000ff02', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', repeat('d', 64), 'Enlace B', '00000000-0000-0000-0000-00000000fb02', now() + interval '10 days');
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000000fd02', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000ff02', 'pdf', 'ajeno.pdf', 'application/pdf', 5, repeat('e', 64), '\x255044462d'::bytea);
select set_config('t.rid', (select id::text from despachos.solicitud_documentos_renglon where clave = 'estado_cuenta'), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_solicitud_vincular(repeat('a', 64), '00000000-0000-0000-0000-00000000fd02', current_setting('t.rid')::uuid) as should_fail;
rollback;

\echo '43. portal: un staff autenticado NO puede usar las funciones del portal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.portal_cliente_solicitudes(repeat('a', 64)) as should_fail;
rollback;

\echo '44. portal: el listado de solicitudes devuelve solo las del cliente del enlace'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', 2026, 6);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(despachos.portal_cliente_solicitudes(repeat('a', 64)) -> 0 -> 'renglones') as renglones_del_cliente_deberia_ser_3;
rollback;

\echo '45. sistema: toca crear la solicitud del mes anterior a los clientes con ficha (2 clientes) y deja de tocar tras crearla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as por_crear_deberia_ser_2 from despachos.system_solicitudes_por_crear('2026-07-01', 100);
rollback;

\echo '46. sistema: el dia configurado se respeta (dia 5, hoy = 3 -> solo el cliente sin configuracion)'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, solicitud_dia) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', 5);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as por_crear_antes_de_su_dia_deberia_ser_1 from despachos.system_solicitudes_por_crear('2026-07-03', 100);
rollback;

\echo '47. sistema: un cliente con la solicitud apagada no entra'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, solicitud_activa) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as apagado_deberia_ser_1 from despachos.system_solicitudes_por_crear('2026-07-01', 100);
rollback;

\echo '48. sistema: crear la solicitud es idempotente y devuelve el correo de contacto para el aviso'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'contacto@cliente.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_solicitud_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
select count(*) as segunda_sin_crear_deberia_ser_1 from despachos.system_solicitud_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6) where not out_creada and out_contacto_correo = 'contacto@cliente.com';
rollback;

\echo '49. staff NO puede ejecutar system_solicitud_crear'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_solicitud_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6) as should_fail;
rollback;

\echo '50. recordatorios: a los 3 dias toca el nivel 1; tras marcarlo ya no; a los 8 dias toca el nivel 2'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
update despachos.solicitud_documentos set creada_en = now() - interval '4 days';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_nivel as nivel_deberia_ser_1 from despachos.system_solicitudes_para_recordatorio(current_date, 100);
rollback;

\echo '51. recordatorios: marcado el nivel 1 la misma solicitud ya no sale'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
update despachos.solicitud_documentos set creada_en = now() - interval '4 days';
select set_config('t.sid', (select id::text from despachos.solicitud_documentos), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_solicitud_recordatorio_marcar(current_setting('t.sid')::uuid, 1);
select count(*) as ya_marcada_deberia_ser_0 from despachos.system_solicitudes_para_recordatorio(current_date, 100);
rollback;

\echo '52. recordatorios: a los 11 dias toca el nivel 3'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
update despachos.solicitud_documentos set creada_en = now() - interval '11 days', ultimo_recordatorio_nivel = 1;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_nivel as nivel_deberia_ser_3 from despachos.system_solicitudes_para_recordatorio(current_date, 100);
rollback;

\echo '53. recordatorios: una solicitud completa (sin pendientes) no recibe recordatorio'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
update despachos.solicitud_documentos set creada_en = now() - interval '11 days';
update despachos.solicitud_documentos_renglon set estado = 'no_aplica', motivo_no_aplica = 'No aplica', resuelto_en = now();
select despachos.solicitud_recomputar((select id from despachos.solicitud_documentos));
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as completa_sin_recordatorio_deberia_ser_0 from despachos.system_solicitudes_para_recordatorio(current_date, 100);
rollback;

\echo '54. recordatorios: staff NO puede ejecutar el barrido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_solicitudes_para_recordatorio(current_date, 100) as should_fail;
rollback;

\echo '55. enlace del aviso: se crea atribuido al responsable de la ficha y vence en los dias pedidos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'Solicitud 2026-06', 35);
reset role;
select count(*) as enlace_deberia_ser_1 from despachos.portal_cliente_enlace where token_hash = repeat('1', 64) and creado_por = '00000000-0000-0000-0000-00000000fb03' and expira_en > now() + interval '34 days';
rollback;

\echo '56. enlace del aviso: sin responsable en la ficha se atribuye a un admin de la organizacion'
begin;
update despachos.cliente_ficha set responsable_id = null where property_id = '00000000-0000-0000-0000-00000000fa01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'Solicitud 2026-06', 35);
reset role;
select count(*) as enlace_admin_deberia_ser_1 from despachos.portal_cliente_enlace where token_hash = repeat('1', 64) and creado_por = '00000000-0000-0000-0000-00000000fb01';
rollback;

\echo '57. enlace del aviso: el correo anterior sigue vivo (dos enlaces de la misma etiqueta conviven hasta su vencimiento)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'Solicitud 2026-06', 35);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('2', 64), 'Solicitud 2026-06', 35);
reset role;
select count(*) as vigentes_deberia_ser_2 from despachos.portal_cliente_enlace where property_id = '00000000-0000-0000-0000-00000000fa01' and revocado_en is null;
rollback;

\echo '57b. enlace del aviso: con 20 vigentes se retiran los automaticos mas viejos, nunca los creados a mano por el staff'
begin;
insert into despachos.portal_cliente_enlace (organization_id, property_id, token_hash, etiqueta, creado_por, expira_en)
  select '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', md5(g::text) || md5(g::text), case when g = 1 then 'Enlace manual' else 'Solicitud 2026-05' end, '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days'
  from generate_series(1, 20) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('3', 64), 'Solicitud 2026-06', 35);
reset role;
select count(*) as manual_sigue_vivo_deberia_ser_1 from despachos.portal_cliente_enlace where etiqueta = 'Enlace manual' and revocado_en is null;
rollback;

\echo '58. enlace del aviso: etiqueta fuera del patron -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'Cualquier cosa', 35) as should_fail;
rollback;

\echo '59. enlace del aviso: staff NO puede crearlo por esta via'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_portal_enlace_crear('00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'Solicitud 2026-06', 35) as should_fail;
rollback;

\echo '=== D-P3-15: estado de los modulos del cierre ==='

-- Libro del cliente A1 en 2026-06: dos polizas, una cuadrada y otra descuadrada; dc09/dc10 son CFDI de junio (I y E), dc11 de julio.
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', '1050000', 'Clientes', 'D'),
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', '4080000', 'Ingresos', 'A')
on conflict do nothing;
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, estado_sat) values
  ('00000000-0000-0000-0000-00000000fc09', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe09', 'I', 'CCC010101CC1', 'AAA010101AA1', 100, 116, true, '2026-06-10', 'vigente'),
  ('00000000-0000-0000-0000-00000000fc10', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe10', 'I', 'CCC010101CC1', 'AAA010101AA1', 200, 232, false, '2026-06-12', 'vigente'),
  ('00000000-0000-0000-0000-00000000fc11', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe11', 'I', 'CCC010101CC1', 'AAA010101AA1', 300, 348, true, '2026-07-02', 'vigente'),
  ('00000000-0000-0000-0000-00000000fc12', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fe12', 'N', 'CCC010101CC1', 'AAA010101AA1', 400, 400, true, '2026-06-15', 'vigente')
on conflict do nothing;
insert into despachos.libro_poliza (id, organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, invoice_id, total_centavos) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6, 'ingreso', 1, '2026-06-10', 'CFDI 09', 'cfdi', '00000000-0000-0000-0000-00000000fc09', 11600),
  ('00000000-0000-0000-0000-00000000f902', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6, 'diario', 2, '2026-06-20', 'Ajuste manual', 'manual', null, 5000)
on conflict do nothing;
insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, debe_centavos, haber_centavos) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 1, '1050000', 11600, 0),
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2, '4080000', 0, 11600),
  ('00000000-0000-0000-0000-00000000f902', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 1, '1050000', 5000, 0),
  ('00000000-0000-0000-0000-00000000f902', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2, '4080000', 0, 4000)
on conflict do nothing;
insert into despachos.estado_cuenta_movimiento (id, organization_id, property_id, hash, banco, formato, fecha, cargo, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('1', 64), 'generico', 'csv', '2026-06-05', null, 116, 116, '00000000-0000-0000-0000-00000000f700', 1),
  ('00000000-0000-0000-0000-00000000f802', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('2', 64), 'generico', 'csv', '2026-06-06', null, 232, 232, '00000000-0000-0000-0000-00000000f700', 2),
  ('00000000-0000-0000-0000-00000000f803', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('3', 64), 'generico', 'csv', '2026-06-07', 50, null, -50, '00000000-0000-0000-0000-00000000f700', 3)
on conflict do nothing;

\echo '60. el estado de modulos suma debe y haber de las polizas del periodo y detecta la poliza descuadrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_debe_centavos - out_haber_centavos)::int as diferencia_deberia_ser_1000 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '61. una poliza descuadrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_polizas_descuadradas as descuadradas_deberia_ser_1 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '62. CFDI de ingreso/egreso del periodo sin poliza: dc10 (la nomina y el CFDI de julio no cuentan; dc09 ya tiene poliza)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_cfdi_sin_poliza as sin_poliza_deberia_ser_1 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '63. una poliza reversada libera al CFDI: vuelve a contar como sin poliza'
begin;
update despachos.libro_poliza set reversada = true where id = '00000000-0000-0000-0000-00000000f901';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_cfdi_sin_poliza as sin_poliza_deberia_ser_2 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '64. CFDI invalidos del periodo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_cfdi_invalidos as invalidos_deberia_ser_1 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '65. conciliacion: 3 movimientos del periodo, 1 conciliado, 1 sesion abierta'
begin;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo) values ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '2026-06');
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000fc09', 'manual');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_movimientos * 100 + out_movimientos_conciliados * 10 + out_conciliacion_abiertas) as conciliacion_deberia_ser_311 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '66. un match deshecho ya no cuenta como conciliado'
begin;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo) values ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '2026-06');
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen, deshecho_en, motivo_deshacer) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000fc09', 'manual', now(), 'Error de captura');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_movimientos_conciliados as conciliados_deberia_ser_0 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '67. papel de pagos provisionales generado del periodo'
begin;
insert into despachos.pago_provisional (organization_id, property_id, ejercicio, mes, impuesto, regimen, base_centavos, determinado_centavos, acreditable_centavos, a_cargo_centavos, a_favor_centavos)
values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6, 'IVA', '601', 100, 16, 0, 16, 0);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_pagos_provisionales as papel_deberia_ser_1 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '68. solicitud del periodo con renglones pendientes se refleja en el estado'
begin;
select * from despachos.solicitud_crear_interna('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_solicitud_pendientes as pendientes_deberia_ser_3 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '69. staff de la property puede consultar el estado de modulos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb04', true);
select out_polizas as staff_lee_deberia_ser_2 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '70. cross-tenant: el staff de otro despacho NO puede consultar el estado de un cliente ajeno'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select * from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6) as should_fail;
rollback;

\echo '71. anon NO puede consultar el estado de modulos'
begin;
set local role anon;
select * from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6) as should_fail;
rollback;

\echo '72. periodo invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 0) as should_fail;
rollback;

-- Periodo de cierre abierto del cliente A1 con tareas encadenadas: t1 (auto-check), t2 (auto-check, depende de t1), t3 (manual, depende de t1).
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes) values
  ('00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 6),
  ('00000000-0000-0000-0000-00000000f602', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', 2026, 6)
on conflict do nothing;
insert into despachos.periodo_cierre_tarea (id, periodo_cierre_id, template_key, title, category, status, depends_on, auto_check_query) values
  ('00000000-0000-0000-0000-00000000f611', '00000000-0000-0000-0000-00000000f601', 'a', 'T1', 'cfdi', 'pending', '{}', 'cfdi_pending_count'),
  ('00000000-0000-0000-0000-00000000f612', '00000000-0000-0000-0000-00000000f601', 'b', 'T2', 'bank', 'blocked', array['00000000-0000-0000-0000-00000000f611']::uuid[], 'bank_feeds_sync_status'),
  ('00000000-0000-0000-0000-00000000f613', '00000000-0000-0000-0000-00000000f601', 'c', 'T3 manual', 'custom', 'blocked', array['00000000-0000-0000-0000-00000000f611']::uuid[], null)
on conflict do nothing;

\echo '73. sistema: lista los periodos abiertos (2: uno por cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as abiertos_deberia_ser_2 from despachos.system_periodos_cierre_abiertos(100);
rollback;

\echo '74. sistema: autocompleta la tarea con auto-check y desbloquea a sus dependientes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cierre_tareas_autocompletar('00000000-0000-0000-0000-00000000f601', array['00000000-0000-0000-0000-00000000f611']::uuid[]);
reset role;
select count(*) as desbloqueadas_deberia_ser_2 from despachos.periodo_cierre_tarea where periodo_cierre_id = '00000000-0000-0000-0000-00000000f601' and status = 'pending';
rollback;

\echo '75. sistema: NUNCA completa una tarea manual (sin auto-check)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cierre_tareas_autocompletar('00000000-0000-0000-0000-00000000f601', array['00000000-0000-0000-0000-00000000f613']::uuid[]) as completadas_deberia_ser_0;
rollback;

\echo '76. sistema: la tarea se atribuye a «sistema»'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cierre_tareas_autocompletar('00000000-0000-0000-0000-00000000f601', array['00000000-0000-0000-0000-00000000f611']::uuid[]);
reset role;
select count(*) as atribuida_deberia_ser_1 from despachos.periodo_cierre_tarea where id = '00000000-0000-0000-0000-00000000f611' and status = 'done' and completed_by = 'sistema';
rollback;

\echo '77. sistema: no completa tareas de un periodo ya cerrado'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cierre_tareas_autocompletar('00000000-0000-0000-0000-00000000f601', array['00000000-0000-0000-0000-00000000f611']::uuid[]) as completadas_deberia_ser_0;
rollback;

\echo '78. staff NO puede autocompletar tareas por la via de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.system_cierre_tareas_autocompletar('00000000-0000-0000-0000-00000000f601', array['00000000-0000-0000-0000-00000000f611']::uuid[]) as should_fail;
rollback;

\echo '79. staff NO puede listar los periodos de todos los clientes por la via de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_periodos_cierre_abiertos(100) as should_fail;
rollback;

\echo '80. cierre forzado: un admin registra el motivo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.periodo_cierre_forzar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'El cliente entrego tarde, cierro con la diferencia conocida', array['balanza', 'cfdi_sin_poliza']);
select count(*) as forzado_deberia_ser_1 from despachos.periodo_cierre where id = '00000000-0000-0000-0000-00000000f601' and cierre_forzado and cierre_forzado_validaciones = array['balanza', 'cfdi_sin_poliza'];
rollback;

\echo '81. cierre forzado: un contador (no admin) NO puede'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select despachos.periodo_cierre_forzar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'El cliente entrego tarde, cierro con la diferencia', null) as should_fail;
rollback;

\echo '82. cierre forzado: motivo corto -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.periodo_cierre_forzar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'urgente', null) as should_fail;
rollback;

\echo '83. cierre forzado: cross-tenant -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select despachos.periodo_cierre_forzar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'Intento desde otro despacho que debe fallar', null) as should_fail;
rollback;

\echo '84. cierre forzado: un periodo ya cerrado no se marca (false)'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.periodo_cierre_forzar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'El periodo ya estaba cerrado, no debe marcarse', null)::int as marcado_deberia_ser_0;
rollback;

\echo '=== D-P3-21: entrega de reportes al cerrar ==='

\echo '85. no se abre la entrega de un periodo que NO esta cerrado'
begin;
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, envio_reportes_cierre) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.cierre_entrega_crear('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601') as should_fail;
rollback;

\echo '86. sin el opt-in del cliente (apagado por omision) no se abre la entrega'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.cierre_entrega_crear('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601') as should_fail;
rollback;

\echo '87. con opt-in y periodo cerrado se abre la entrega, idempotente por periodo'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, envio_reportes_cierre) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.cierre_entrega_crear('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
select out_creada::int as segunda_deberia_ser_0 from despachos.cierre_entrega_crear('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
rollback;

\echo '88. cross-tenant: el admin de otro despacho NO abre la entrega'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, envio_reportes_cierre) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select * from despachos.cierre_entrega_crear('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601') as should_fail;
rollback;

\echo '89. se agrega un PDF; el mismo tipo dos veces no duplica (false)'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cliente_automatizacion (property_id, organization_id, contacto_correo, envio_reportes_cierre) values ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f001', 'a@b.com', true);
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_entrega_archivo_agregar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501', 'balanza', 'balanza-2026-06.pdf', '\x255044462d312e34'::bytea);
select despachos.cierre_entrega_archivo_agregar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501', 'balanza', 'balanza-2026-06.pdf', '\x255044462d312e34'::bytea)::int as duplicado_deberia_ser_0;
rollback;

\echo '90. solo se aceptan PDF (firma %PDF-)'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_entrega_archivo_agregar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501', 'diot', 'diot.pdf', '\x3c68746d6c3e'::bytea) as should_fail;
rollback;

\echo '91. tipo de archivo fuera del catalogo -> error'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_entrega_archivo_agregar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501', 'secreto', 'x.pdf', '\x255044462d312e34'::bytea) as should_fail;
rollback;

\echo '92. el staff NO puede leer el contenido (bytea) del PDF por SQL directo'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
insert into despachos.cierre_entrega_archivo (entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 'diot', 'diot.pdf', 5, repeat('f', 64), '\x255044462d'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select contenido from despachos.cierre_entrega_archivo as should_fail;
rollback;

\echo '93. el staff SI lista los metadatos de sus archivos'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
insert into despachos.cierre_entrega_archivo (entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 'diot', 'diot.pdf', 5, repeat('f', 64), '\x255044462d'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select count(*) as metadatos_deberia_ser_1 from (select id, tipo, nombre_archivo from despachos.cierre_entrega_archivo) x;
rollback;

\echo '94. cross-tenant: el staff de otro despacho no ve archivos ajenos (RLS)'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
insert into despachos.cierre_entrega_archivo (entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 'diot', 'diot.pdf', 5, repeat('f', 64), '\x255044462d'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select count(*) as archivos_ajenos_deberia_ser_0 from (select id from despachos.cierre_entrega_archivo) x;
rollback;

\echo '95. portal: el cliente lista las entregas publicadas de SU property'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id in ('00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000f602');
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values
  ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601'),
  ('00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000f602');
insert into despachos.cierre_entrega_archivo (entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 'diot', 'diot.pdf', 5, repeat('f', 64), '\x255044462d'::bytea),
  ('00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', 'diot', 'diot-b.pdf', 5, repeat('9', 64), '\x255044462d'::bytea);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(despachos.portal_cliente_reportes(repeat('a', 64))) as entregas_propias_deberia_ser_1;
rollback;

\echo '96. portal: el cliente baja su PDF'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
insert into despachos.cierre_entrega_archivo (id, entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f5a1', '00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 'diot', 'diot.pdf', 5, repeat('f', 64), '\x255044462d'::bytea);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select octet_length(out_contenido) as bytes_deberia_ser_5 from despachos.portal_cliente_reporte_contenido(repeat('a', 64), '00000000-0000-0000-0000-00000000f5a1');
rollback;

\echo '97. portal: el PDF de OTRO cliente no se puede bajar con un enlace ajeno'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f602';
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-00000000f602');
insert into despachos.cierre_entrega_archivo (id, entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f5b1', '00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fa02', 'diot', 'diot-b.pdf', 5, repeat('9', 64), '\x255044462d'::bytea);
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_reporte_contenido(repeat('a', 64), '00000000-0000-0000-0000-00000000f5b1') as should_fail;
rollback;

\echo '98. portal: un enlace revocado no baja nada'
begin;
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, expira_en, revocado_en) values
  ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', repeat('a', 64), 'Enlace', '00000000-0000-0000-0000-00000000fb01', now() + interval '10 days', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_reportes(repeat('a', 64)) as should_fail;
rollback;

\echo '99. portal: un staff autenticado NO puede usar las funciones de reportes del portal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.portal_cliente_reporte_contenido(repeat('a', 64), gen_random_uuid()) as should_fail;
rollback;

\echo '100. marcar el correo de la entrega como encolado es idempotente'
begin;
insert into despachos.cierre_entrega (id, organization_id, property_id, periodo_cierre_id) values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_entrega_marcar_correo('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501');
select despachos.cierre_entrega_marcar_correo('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f501')::int as segunda_deberia_ser_0;
rollback;

\echo '101. anon no escribe ninguna de las tablas nuevas'
begin;
set local role anon;
insert into despachos.solicitud_documentos (organization_id, property_id, ejercicio, mes) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 1) returning 1 as should_fail;
rollback;

\echo '102. el staff no puede insertar solicitudes directamente (solo por funciones)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
insert into despachos.solicitud_documentos (organization_id, property_id, ejercicio, mes) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', 2026, 1) returning 1 as should_fail;
rollback;

\echo '103. el estado de modulos devuelve la periodicidad del cliente (bimestral/mensual) para saber si toca pago provisional'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_periodicidad = 'mensual')::int as periodicidad_deberia_ser_1 from despachos.cierre_estado_modulos('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;

\echo '104. el staff guarda un artefacto de un periodo cerrado; el mismo tipo dos veces no duplica (false)'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_artefacto_guardar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'balanza.xml', '\x3c783e3c2f783e'::bytea);
select despachos.cierre_artefacto_guardar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'balanza.xml', '\x3c783e3c2f783e'::bytea)::int as duplicado_deberia_ser_0;
rollback;

\echo '105. no se guarda un artefacto de un periodo que no esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_artefacto_guardar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'balanza.xml', '\x3c783e3c2f783e'::bytea) as should_fail;
rollback;

\echo '106. cross-tenant: el admin de otro despacho NO guarda ni descarga artefactos ajenos'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select despachos.cierre_artefacto_guardar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_catalogo_xml', 'catalogo.xml', '\x3c783e3c2f783e'::bytea) as should_fail;
rollback;

\echo '107. tipo de artefacto fuera del catalogo -> error'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select despachos.cierre_artefacto_guardar('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'otra_cosa', 'x.xml', '\x3c783e3c2f783e'::bytea) as should_fail;
rollback;

\echo '108. el staff NO lee el contenido (bytea) del artefacto por SQL directo'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cierre_artefacto (organization_id, property_id, periodo_cierre_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'b.xml', 7, repeat('a', 64), '\x3c783e3c2f783e'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select contenido from despachos.cierre_artefacto as should_fail;
rollback;

\echo '109. el staff con rol de escritura descarga el contenido por la funcion; el auditor NO'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cierre_artefacto (id, organization_id, property_id, periodo_cierre_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f4a1', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'b.xml', 7, repeat('a', 64), '\x3c783e3c2f783e'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb03', true);
select octet_length(out_contenido) as bytes_deberia_ser_7 from despachos.cierre_artefacto_contenido('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f4a1');
rollback;

\echo '110. el auditor (solo lectura) NO descarga el artefacto'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cierre_artefacto (id, organization_id, property_id, periodo_cierre_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f4a1', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'b.xml', 7, repeat('a', 64), '\x3c783e3c2f783e'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb04', true);
select * from despachos.cierre_artefacto_contenido('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f4a1') as should_fail;
rollback;

\echo '111. cross-tenant: el staff de otro despacho no ve los artefactos ajenos (RLS)'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
insert into despachos.cierre_artefacto (organization_id, property_id, periodo_cierre_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000f601', 'contabilidad_balanza_xml', 'b.xml', 7, repeat('a', 64), '\x3c783e3c2f783e'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb02', true);
select count(*) as artefactos_ajenos_deberia_ser_0 from (select id from despachos.cierre_artefacto) x;
rollback;

\echo '112. sistema: lee las tareas de un periodo abierto (3) para el auto-check; staff NO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as tareas_deberia_ser_3 from despachos.system_cierre_tareas('00000000-0000-0000-0000-00000000f601');
rollback;

\echo '113. staff NO puede leer las tareas por la via de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000fb01', true);
select * from despachos.system_cierre_tareas('00000000-0000-0000-0000-00000000f601') as should_fail;
rollback;

\echo '114. sistema: un periodo cerrado ya no devuelve tareas'
begin;
update despachos.periodo_cierre set status = 'closed', closed_at = now() where id = '00000000-0000-0000-0000-00000000f601';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as tareas_cerrado_deberia_ser_0 from despachos.system_cierre_tareas('00000000-0000-0000-0000-00000000f601');
rollback;

\echo '115. sistema: system_solicitud_crear devuelve las etiquetas de los renglones (para el correo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select cardinality(out_etiquetas) as etiquetas_deberia_ser_3 from despachos.system_solicitud_crear('00000000-0000-0000-0000-00000000fa01', 2026, 6);
rollback;
