-- D-27/D-28/D-26 -- verificacion contra Postgres REAL de la migracion 022 (funciones de solo sistema de los crons).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs). Sistema = rol authenticated con `sub` vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-00000000d001', 'despachos', 'Org A cron', 'org-a-cron', 'active'),
  ('00000000-0000-0000-0000-00000000d002', 'despachos', 'Org B cron', 'org-b-cron', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d001', 'despachos', 'Cliente A'),
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-00000000d002', 'despachos', 'Cliente B'),
  ('00000000-0000-0000-0000-00000000da03', '00000000-0000-0000-0000-00000000d002', 'despachos', 'Cliente B sin ficha')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000db01', 'cron-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-00000000db02', 'cron-b@example.com', 'Staff B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-00000000db02', '00000000-0000-0000-0000-00000000d002', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d001', 'CCC010101CC1', 'Cliente A SA', array['601'], '06000'),
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-00000000d002', 'DDD010101DD1', 'Cliente B SA', array['612'], '06000')
on conflict do nothing;
insert into despachos.property_config (property_id, organization_id, zona_horaria) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d001', 'America/Mexico_City')
on conflict do nothing;
-- inv1 pendiente (nunca consultado), inv2 vigente consultado hace 1 dia, inv3 cancelado, inv4 pendiente de otro cliente
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, estado_sat, estado_sat_intentado_en) values
  ('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000de01', 'I', 'AAA010101AA1', 'CCC010101CC1', 100, 116, true, '2026-07-10', 'pendiente', null),
  ('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000de02', 'I', 'BBB020202BB2', 'CCC010101CC1', 200, 232, true, '2026-07-11', 'vigente', now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000dc03', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000de03', 'I', 'ZZZ999999ZZ9', 'CCC010101CC1', 300, 348, true, '2026-07-12', 'cancelado', null),
  ('00000000-0000-0000-0000-00000000dc04', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-00000000de04', 'I', 'AAA010101AA1', 'DDD010101DD1', 400, 464, true, '2026-07-13', 'pendiente', null)
on conflict do nothing;

\echo '=== D-27: CFDI por verificar ==='

\echo '1. sistema: el barrido devuelve solo los pendientes de reintento (inv1 e inv4); excluye cancelado (inv3) y el consultado hace 1 dia (inv2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as barrido_deberia_ser_2 from despachos.system_cfdi_pendientes_estatus_sat(100, 6);
rollback;

\echo '2. sistema: con reintento 0 dias tambien entra inv2 (3 filas), nunca el cancelado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as barrido_reintento_cero_deberia_ser_3 from despachos.system_cfdi_pendientes_estatus_sat(100, 0);
rollback;

\echo '3. el tope se respeta y el mas antiguo (nunca intentado, creado primero) va primero'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_invoice_id = '00000000-0000-0000-0000-00000000dc01')::int as mas_antiguo_primero_deberia_ser_1 from despachos.system_cfdi_pendientes_estatus_sat(1, 6);
rollback;

\echo '4. staff autenticado NO puede ejecutar el barrido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_cfdi_pendientes_estatus_sat(100, 6) as should_fail;
rollback;

\echo '5. anon NO tiene EXECUTE sobre el barrido'
begin;
set local role anon;
select * from despachos.system_cfdi_pendientes_estatus_sat(100, 6) as should_fail;
rollback;

\echo '6. limite invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_pendientes_estatus_sat(0, 6) as should_fail;
rollback;

\echo '7. registrar vigente sobre pendiente: cambia, no es cancelacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado_anterior = 'pendiente' and out_estado_nuevo = 'vigente' and not out_cambio_a_cancelado)::int as registrar_vigente_deberia_ser_1 from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc01', 'vigente');
rollback;

\echo '8. vigente -> cancelado: avisa la transicion UNA vez y persiste la fecha de verificacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc02', 'cancelado');
reset role;
select (estado_sat = 'cancelado' and estado_sat_verificado_en is not null)::int as persistido_cancelado_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000dc02';
rollback;

\echo '9. la transicion a cancelado se reporta solo en la PRIMERA llamada (idempotente: no hay segundo aviso)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc02', 'cancelado');
select (not out_cambio_a_cancelado)::int as segunda_vez_sin_cambio_deberia_ser_1 from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc02', 'cancelado');
rollback;

\echo '10. un CFDI cancelado es terminal: registrar vigente no lo revive'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc03', 'vigente');
reset role;
select (estado_sat = 'cancelado')::int as cancelado_terminal_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000dc03';
rollback;

\echo '11. una consulta que no concluyo (pendiente) NO pisa un estado ya verificado, solo anota el intento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc02', 'pendiente');
reset role;
select (estado_sat = 'vigente' and estado_sat_intentado_en > now() - interval '1 minute')::int as pendiente_no_pisa_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-00000000dc02';
rollback;

\echo '12. estado invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc01', 'inventado') as should_fail;
rollback;

\echo '13. CFDI inexistente -> error P0002'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dcff', 'vigente') as should_fail;
rollback;

\echo '14. staff autenticado NO puede registrar un estatus por esta via'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc01', 'vigente') as should_fail;
rollback;

\echo '15. anon NO tiene EXECUTE sobre el registro'
begin;
set local role anon;
select * from despachos.system_cfdi_registrar_estatus_sat('00000000-0000-0000-0000-00000000dc01', 'vigente') as should_fail;
rollback;

\echo '16. cross-tenant: el staff de B no ve ninguna factura de A (RLS intacta con la columna nueva)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db02', true);
select count(*) as cross_tenant_deberia_ser_0 from despachos.invoice where property_id = '00000000-0000-0000-0000-00000000da01';
rollback;

\echo '=== D-28: CFDI ya ingeridos afectados por la edicion 69-B ==='

\echo '17. sistema: tras ingerir la edicion, AAA010101AA1 presunto afecta a inv1 (A) e inv4 (B); desvirtuado no cuenta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64),
  '[{"rfc":"AAA010101AA1","nombre":"FANTASMA SA","situacion":"presunto"},{"rfc":"BBB020202BB2","nombre":"OK SA","situacion":"desvirtuado"}]'::jsonb);
select count(*) as afectados_deberia_ser_2 from despachos.system_efos_invoices_afectados(100);
rollback;

\echo '18. sin edicion ingerida no hay afectados'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_edicion_deberia_ser_0 from despachos.system_efos_invoices_afectados(100);
rollback;

\echo '19. staff autenticado NO puede listar los afectados de todos los clientes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_efos_invoices_afectados(100) as should_fail;
rollback;

\echo '20. anon NO tiene EXECUTE sobre los afectados'
begin;
set local role anon;
select * from despachos.system_efos_invoices_afectados(100) as should_fail;
rollback;

\echo '=== D-26: vencimientos ==='

\echo '21. clientes con ficha de properties activas (A y B; la property sin ficha no entra)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as clientes_deberia_ser_2 from despachos.system_despachos_clientes_ficha(100);
rollback;

\echo '22. staff autenticado NO puede listar los clientes del sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_despachos_clientes_ficha(100) as should_fail;
rollback;

\echo '23. upsert crea el vencimiento; repetirlo no duplica y corrige la fecha de uno pendiente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-10', '2026-11-17', 'critica');
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-10', '2026-11-18', 'critica');
reset role;
select (count(*) = 1 and min(fecha_limite) = '2026-11-18')::int as upsert_idempotente_deberia_ser_1 from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-00000000da01';
rollback;

\echo '24. upsert NO toca un vencimiento completado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'IVA', '2026-10', '2026-11-17', 'critica');
reset role;
update despachos.fiscal_deadline set estado = 'completado', fecha_presentacion = '2026-11-01' where property_id = '00000000-0000-0000-0000-00000000da01' and tipo = 'IVA';
set local role authenticated;
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'IVA', '2026-10', '2026-12-30', 'baja');
reset role;
select (fecha_limite = '2026-11-17' and estado = 'completado')::int as completado_intacto_deberia_ser_1 from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-00000000da01' and tipo = 'IVA';
rollback;

\echo '25. upsert sobre una property SIN ficha de cliente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da03', 'ISR', '2026-10', '2026-11-17', 'critica') as should_fail;
rollback;

\echo '26. upsert con tipo fuera del catalogo -> error (check de tabla)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'Inventado', '2026-10', '2026-11-17', 'critica') as should_fail;
rollback;

\echo '27. staff autenticado NO puede crear vencimientos por la via de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-10', '2026-11-17', 'critica') as should_fail;
rollback;

\echo '28. por_escalar devuelve el vencido/por vencer con su nivel maximo previo; escalar es idempotente por nivel'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-09', '2026-10-17', 'critica');
select despachos.system_vencimiento_escalar((select out_deadline_id from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') limit 1), 'nivel_2', 'barrido');
select (despachos.system_vencimiento_escalar((select out_deadline_id from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') limit 1), 'nivel_2', 'barrido') = false)::int as segundo_escalamiento_mismo_nivel_deberia_ser_1;
rollback;

\echo '29. escalar a un nivel MENOR que el ya registrado no hace nada; a uno mayor si'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-09', '2026-10-17', 'critica');
select despachos.system_vencimiento_escalar((select out_deadline_id from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') limit 1), 'nivel_3', 'barrido');
select (despachos.system_vencimiento_escalar((select out_deadline_id from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') limit 1), 'nivel_2', 'barrido') = false)::int as nivel_menor_sin_efecto_deberia_ser_1;
rollback;

\echo '30. escalar marca el vencimiento como escalado y deja UNA fila de escalamiento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-09', '2026-10-17', 'critica');
select despachos.system_vencimiento_escalar((select out_deadline_id from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') limit 1), 'nivel_2', 'barrido');
reset role;
select (d.estado = 'escalado' and (select count(*) from despachos.deadline_escalation e where e.deadline_id = d.id) = 1)::int as escalado_una_fila_deberia_ser_1 from despachos.fiscal_deadline d where d.property_id = '00000000-0000-0000-0000-00000000da01' and d.periodo = '2026-09';
rollback;

\echo '31. un vencimiento completado no se escala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_vencimiento_upsert('00000000-0000-0000-0000-00000000da01', 'ISR', '2026-09', '2026-10-17', 'critica');
reset role;
update despachos.fiscal_deadline set estado = 'completado', fecha_presentacion = '2026-10-01' where property_id = '00000000-0000-0000-0000-00000000da01';
select set_config('test.did', (select id::text from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-00000000da01' limit 1), true);
set local role authenticated;
select (despachos.system_vencimiento_escalar(current_setting('test.did')::uuid, 'nivel_4', 'x') = false)::int as completado_no_escala_deberia_ser_1;
rollback;

\echo '32. nivel invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_vencimiento_escalar('00000000-0000-0000-0000-00000000dcff', 'nivel_9', 'x') as should_fail;
rollback;

\echo '33. staff autenticado y anon NO pueden escalar ni listar por escalar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000db01', true);
select * from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-00000000da01', '2026-10-17') as should_fail;
rollback;

\echo '34. anon NO tiene EXECUTE sobre escalar'
begin;
set local role anon;
select despachos.system_vencimiento_escalar('00000000-0000-0000-0000-00000000dcff', 'nivel_2', 'x') as should_fail;
rollback;
